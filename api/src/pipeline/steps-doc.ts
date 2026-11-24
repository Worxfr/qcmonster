// Etapes du workflow, partie 2: extraction et ancrage (5-6), quota (apres verify-run), generation et publication (11-13).
import { z } from 'zod';
import { CostBlockedError, JobBudgetExceededError } from '../../../shared/bedrock.js';
import { gsi1, keys } from '../../../shared/ddb/keys.js';
import { ClaimItemSchema, FicheItemSchema, GapItemSchema, QcmItemSchema, questionId } from '../../../shared/items.js';
import { JOB_COST_CAP_EUR } from '../../../shared/names.js';
import { consumePages } from '../../../shared/quota.js';
import { callModel, centsFromMicros, iso, jobKey, type Ctx } from './ctx.js';
import { isDuplicate, minhash } from './fingerprint.js';
import { endWithoutDoc, quotaScope, transition } from './job.js';
import { extractPrompt, generatePrompt, solvePrompt, SYSTEM_JSON } from './prompts.js';
import type { Item } from './ports.js';
import { MSG, type WfInput } from './steps.js';
import { normalize, parseModelJson } from './text.js';

export const GEN_RESERVE_CENTS = 6; // part du plafond de 0,25 EUR gardee pour la generation (etapes 11 et 12)
export const MAX_CLAIMS = 60;
export const MAX_QUESTIONS = 5;

const ExtractOut = z.object({
  titre: z.string().max(300),
  matiere: z.string(),
  affirmations: z
    .array(z.object({ phraseId: z.string(), extrait: z.string(), texte: z.string(), type: z.enum(['factuelle', 'non_factuelle']), aRisque: z.boolean() }))
    .max(200),
});
const SUBJECTS = ['maths', 'physique', 'svt', 'histoire_geo', 'francais', 'autre'] as const;

export interface RawClaim {
  phraseId: string;
  extrait: string;
  texte: string;
  type: 'factuelle' | 'non_factuelle';
  aRisque: boolean;
}
/**
 * Controle d'ancrage PAR CODE (etape 6): le phraseId existe et l'extrait (2 mots au moins) est bien dans cette phrase
 * (comparaison normalisee). Sinon l'affirmation est supprimee. Textes en double retires; MAX_CLAIMS au plus.
 */
export function anchorClaims(raw: RawClaim[], sentences: Map<string, string>): { kept: (RawClaim & { page: number })[]; dropped: number } {
  const seen = new Set<string>();
  const kept: (RawClaim & { page: number })[] = [];
  for (const c of raw) {
    const src = sentences.get(c.phraseId);
    const ex = normalize(c.extrait);
    const texte = c.texte.trim();
    const ok = src !== undefined && ex.split(' ').length >= 2 && normalize(src).includes(ex) && texte.length >= 5 && texte.length <= 1000;
    if (!ok || seen.has(normalize(texte)) || kept.length >= MAX_CLAIMS) continue;
    seen.add(normalize(texte));
    kept.push({ ...c, texte, page: Number(/^p([0-9]+)-/.exec(c.phraseId)![1]), extrait: c.extrait.trim().slice(0, 300) });
  }
  return { kept, dropped: raw.length - kept.length };
}

/** Budget transmis a L2b: plafond du job moins ce qui est depense moins la reserve de generation. */
export const budgetLeftCents = (micros: number): number => Math.max(0, Math.floor(JOB_COST_CAP_EUR * 100) - centsFromMicros(micros) - GEN_RESERVE_CENTS);

export async function extract(ctx: Ctx, i: WfInput): Promise<{ ok: boolean; docId?: string; budgetRestantCentimes?: number }> {
  const job0 = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job0 || job0.state !== 'verification') return { ok: false };
  const docId = (job0.docId as string | undefined) ?? ctx.newId();
  await ctx.db.update(jobKey(i.sid, i.jobId), { set: { docId } });

  const texts = (await ctx.db.query(`JOB#${i.jobId}`, 'TEXT#')).sort((a, b) => Number(a.page) - Number(b.page));
  const sentences = new Map<string, string>();
  for (const t of texts) for (const s of t.sentences as { id: string; text: string }[]) sentences.set(s.id, s.text);
  const numbered = [...sentences].map(([id, text]) => `[${id}] ${text}`).join('\n');

  const raw = await callModel(ctx, i, 'extraction', 'haiku', { system: SYSTEM_JSON, prompt: extractPrompt(numbered), maxTokens: 8000 });
  const out = parseModelJson(raw, ExtractOut);
  const { kept } = anchorClaims(out.affirmations, sentences);
  if (kept.length === 0) {
    await endWithoutDoc(ctx, i.sid, i.jobId, ['verification'], 'rejete', MSG.noClaims);
    return { ok: false };
  }
  // CLAIM#<nn>: ecrit ici, JAMAIS modifie ensuite; les verdicts (L2b) sont dans VERDICT#<nn>.
  for (const [n, c] of kept.entries()) {
    await ctx.db.put(ClaimItemSchema.parse({ ...keys.claim(docId, n + 1), texte: c.texte, origine: { page: c.page, phraseId: c.phraseId, extrait: c.extrait }, type: c.type, aRisque: c.aRisque }));
  }
  const subject = (SUBJECTS as readonly string[]).includes(out.matiere) ? out.matiere : 'autre';
  const cur = await ctx.db.update(jobKey(i.sid, i.jobId), { set: { draftTitle: out.titre.trim().slice(0, 200) || 'Cours', draftSubject: subject, claimCount: kept.length } });
  return { ok: true, docId, budgetRestantCentimes: budgetLeftCents((cur?.coutMicros as number | undefined) ?? 0) };
}

/** Consommation du quota, etat distinct juste apres verify-run. Ajoute aussi le cout de L2b (une seule fois). */
export async function quotaConsume(ctx: Ctx, i: WfInput & { verify?: { coutCentimes?: number } }): Promise<void> {
  const c = i.verify?.coutCentimes;
  const verifyCents = typeof c === 'number' && Number.isInteger(c) && c > 0 ? c : 0;
  const won = await ctx.db.update(jobKey(i.sid, i.jobId), {
    set: { quotaState: 'consumed', state: 'generation' },
    add: { coutMicros: verifyCents * 10_000 },
    cond: { exists: true, eq: { quotaState: 'reserved', state: 'verification' } },
  });
  if (!won) return; // relance: deja consomme
  const scope = await quotaScope(ctx, won.familyId as string, i.sid, won.quotaMonth as string);
  await consumePages(ctx.quota, scope, won.pages as number);
}

// ---------------------------------------------------------------- 11-13
const GenOut = z.object({
  resume: z.string().max(3000),
  qcm: z.array(z.object({ claimId: z.string(), enonce: z.string(), choix: z.array(z.string()), cle: z.number().int() })).max(20),
  trous: z.array(z.object({ claimId: z.string(), phrase: z.string(), attendu: z.string() })).max(20),
});
const SolveOut = z.object({ reponses: z.array(z.object({ n: z.number().int(), choix: z.number().int() })).max(20) });
type GenQcm = z.infer<typeof GenOut>['qcm'][number];
type GenGap = z.infer<typeof GenOut>['trous'][number];
export interface EligibleClaim {
  id: string;
  texte: string;
}

/** Permutation deterministe des 4 choix (graine: identifiant de question): la place de la bonne reponse ne depend pas du modele. */
export function shuffleChoices(choix: string[], cle: number, seed: string): { choix: string[]; cle: number } {
  const order = [0, 1, 2, 3];
  let h = 0;
  for (const ch of seed) h = (Math.imul(h, 31) + ch.charCodeAt(0)) >>> 0;
  for (let k = 3; k > 0; k--) {
    h = (Math.imul(h, 1664525) + 1013904223) >>> 0;
    const j = h % (k + 1);
    [order[k], order[j]] = [order[j], order[k]];
  }
  return { choix: order.map((o) => choix[o]), cle: order.indexOf(cle) };
}

/** QCM: lie a une affirmation eligible, 4 choix distincts non vides, une cle entre 0 et 3. */
export function validQcm(q: GenQcm, eligible: Map<string, EligibleClaim>): boolean {
  return (
    eligible.has(q.claimId) &&
    q.choix.length === 4 &&
    q.enonce.trim().length >= 5 &&
    q.enonce.length <= 300 &&
    q.choix.every((c) => c.trim().length >= 1 && c.length <= 300) &&
    new Set(q.choix.map(normalize)).size === 4 &&
    q.cle >= 0 &&
    q.cle <= 3
  );
}
/** Trou: un seul `____`, le mot masque est dans l'affirmation, ne reste pas dans la phrase, et la phrase vient de l'affirmation. */
export function validGap(g: GenGap, eligible: Map<string, EligibleClaim>): boolean {
  const claim = eligible.get(g.claimId);
  if (!claim || g.phrase.split('____').length !== 2 || g.attendu.trim().length < 1 || g.attendu.length > 60) return false;
  const att = normalize(g.attendu);
  if (!att || !` ${normalize(claim.texte)} `.includes(` ${att} `)) return false;
  const rest = normalize(g.phrase.replace('____', ' '));
  if (` ${rest} `.includes(` ${att} `)) return false;
  const claimWords = new Set(normalize(claim.texte).split(' '));
  const pw = rest.split(' ').filter(Boolean);
  return pw.length > 0 && pw.filter((w) => claimWords.has(w)).length / pw.length >= 0.6;
}

/** Statut final: verdict de L2b, sinon `non_factuelle` si elle l'est, sinon `non_verifiable`. */
export function claimStatus(claim: Item, verdict: Item | undefined): 'verifiee' | 'erreur' | 'non_verifiable' | 'non_factuelle' {
  const s = verdict?.statut;
  if (s === 'verifiee' || s === 'erreur' || s === 'non_verifiable' || s === 'non_factuelle') return s;
  return claim.type === 'non_factuelle' ? 'non_factuelle' : 'non_verifiable';
}

async function makeQuestions(ctx: Ctx, i: WfInput, eligible: Map<string, EligibleClaim>) {
  const qcm: GenQcm[] = [];
  const gaps: GenGap[] = [];
  let resume = '';
  const raw = await callModel(ctx, i, 'generation', 'haiku', { system: SYSTEM_JSON, prompt: generatePrompt([...eligible.values()]), maxTokens: 4000 });
  const gen = parseModelJson(raw, GenOut);
  resume = gen.resume.trim();
  const cand = gen.qcm.filter((q) => validQcm(q, eligible)).slice(0, MAX_QUESTIONS);
  if (cand.length) {
    // Resolution a l'aveugle: un second appel repond sans voir la cle; une reponse differente rejette la question.
    const prompt = solvePrompt(cand.map((q, k) => ({ n: k + 1, claim: eligible.get(q.claimId)!.texte, enonce: q.enonce, choix: q.choix })));
    const solved = parseModelJson(await callModel(ctx, i, 'controle-qcm', 'haiku', { system: SYSTEM_JSON, prompt, maxTokens: 1000 }), SolveOut);
    const answers = new Map(solved.reponses.map((r) => [r.n, r.choix]));
    cand.forEach((q, k) => {
      if (answers.get(k + 1) === q.cle) qcm.push(q);
    });
  }
  gaps.push(...gen.trous.filter((g) => validGap(g, eligible)).slice(0, MAX_QUESTIONS));
  return { resume, qcm, gaps };
}

export async function generate(ctx: Ctx, i: WfInput): Promise<{ docId: string; qcm: number; gaps: number; doublon: boolean }> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job || typeof job.docId !== 'string') throw new Error('job sans fiche');
  const docId = job.docId;
  if (job.state === 'termine') return { docId, qcm: (job.nbQcm as number) ?? 0, gaps: (job.nbTrous as number) ?? 0, doublon: job.doublon === true };
  const part = await ctx.db.query(`DOC#${docId}`);
  const verdicts = new Map(part.filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [x.SK.slice('VERDICT#'.length), x]));
  const eligible = new Map<string, EligibleClaim>();
  for (const c of part.filter((x) => x.SK.startsWith('CLAIM#'))) {
    const nn = c.SK.slice('CLAIM#'.length);
    const st = claimStatus(c, verdicts.get(nn));
    if (st === 'verifiee' || st === 'non_factuelle') eligible.set(nn, { id: nn, texte: c.texte as string });
  }

  let made: { resume: string; qcm: GenQcm[]; gaps: GenGap[] } = { resume: '', qcm: [], gaps: [] };
  if (eligible.size > 0) {
    try {
      made = await makeQuestions(ctx, i, eligible);
    } catch (e) {
      // Plafond du job ou budget atteint: on publie la fiche sans questions plutot que de tout perdre.
      if (!(e instanceof JobBudgetExceededError) && !(e instanceof CostBlockedError)) throw e;
    }
  }
  for (const [k, q] of made.qcm.entries()) {
    const qid = questionId(docId, 'qcm', k + 1);
    const sh = shuffleChoices(q.choix, q.cle, qid);
    await ctx.db.put(QcmItemSchema.parse({ ...keys.qcm(docId, k + 1), questionId: qid, enonce: q.enonce.trim(), choix: sh.choix, cle: sh.cle, claimId: q.claimId }));
  }
  for (const [k, g] of made.gaps.entries()) {
    await ctx.db.put(GapItemSchema.parse({ ...keys.gap(docId, k + 1), questionId: questionId(docId, 'gap', k + 1), phrase: g.phrase.trim(), attendu: g.attendu.trim(), claimId: g.claimId }));
  }

  // Empreinte et doublon (meme famille). Un texte sans groupe de mots n'est jamais un doublon.
  const texts = (await ctx.db.query(`JOB#${i.jobId}`, 'TEXT#')).sort((a, b) => Number(a.page) - Number(b.page));
  const fullText = texts.flatMap((t) => (t.sentences as { text: string }[]).map((s) => s.text)).join(' ');
  const mh = minhash(fullText);
  const empty = mh.every((v) => v === 0xffffffff);
  const familyDocs = await ctx.db.queryGsi1(`FAMILY#${job.familyId as string}`, 'DOC#');
  const doublon = !empty && familyDocs.some((d) => d.SK !== `DOC#${docId}` && Array.isArray(d.empreinteMinHash) && (d.empreinteMinHash as number[]).length === mh.length && isDuplicate(mh, d.empreinteMinHash as number[]));

  const createdAt = iso(ctx);
  const fiche = FicheItemSchema.parse({ ...keys.doc(i.sid, docId), titre: job.draftTitle ?? 'Cours', matiere: job.draftSubject ?? 'autre', empreinteMinHash: mh, pagesConsommees: job.pages, doublon, createdAt });
  // La fiche est ecrite en dernier: elle n'apparait dans les listes que complete.
  await ctx.db.put({ ...fiche, ...gsi1.doc(job.familyId as string, `${createdAt}#${docId}`), familyId: job.familyId, studentId: i.sid, jobId: i.jobId, resume: made.resume });
  const done = await ctx.db.get(jobKey(i.sid, i.jobId));
  const micros = (done?.coutMicros as number | undefined) ?? 0;
  await transition(ctx, i.sid, i.jobId, ['generation'], 'termine', { finishedAt: iso(ctx), coutCentimes: centsFromMicros(micros), doublon, nbQcm: made.qcm.length, nbTrous: made.gaps.length });
  return { docId, qcm: made.qcm.length, gaps: made.gaps.length, doublon };
}
