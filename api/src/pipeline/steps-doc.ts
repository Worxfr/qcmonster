// Etapes du workflow, partie 2: extraction et ancrage (5-6), quota (apres verify-run), generation et publication (11-13).
import { z } from 'zod';
import { CostBlockedError, JobBudgetExceededError } from '../../../shared/bedrock.js';
import { gsi1, keys } from '../../../shared/ddb/keys.js';
import { ClaimItemSchema, FicheItemSchema, GapItemSchema, QcmItemSchema, questionId } from '../../../shared/items.js';
import { jobCapEur } from '../../../shared/names.js';
import { cleanLabel, cleanTopic } from '../../../shared/scans.js';
import { callModel, centsFromMicros, iso, jobKey, type Ctx } from './ctx.js';
import { isDuplicate, minhash } from './fingerprint.js';
import { endWithoutDoc, keptSections, rangesOf, sentencesOf, sortedTexts, transition, type PlanSection, type TextSentence } from './job.js';
import { consumeQuotaOnce } from './quota-ops.js';
import { extractPrompt, generatePrompt, solvePrompt, SYSTEM_JSON } from './prompts.js';
import type { Item } from './ports.js';
import { MSG, purgeScan, type WfInput } from './steps.js';
import { addVerifyCostOnce, currentAttempt, draftKey } from './steps-cost.js';
import { ModelOutputError, normalize, parseModelJson, salvageTruncatedList, sliceRanges, thinEvenly, words, type SliceRange } from './text.js';

export const GEN_RESERVE_CENTS = 6; // part du plafond de 0,25 EUR gardee pour la generation (etapes 11 et 12)
export const MAX_CLAIMS = 60;
export const MAX_QUESTIONS = 5;
/** Nombre de questions (QCM, et trous) selon le nombre de faits verifies: environ une pour deux faits, de 1 a MAX_QUESTIONS. */
export const questionCap = (verified: number): number => Math.min(MAX_QUESTIONS, Math.max(1, Math.ceil(verified / 2)));

const ExtractOut = z.object({
  titre: z.string().max(300),
  matiere: z.string(),
  affirmations: z
    .array(z.object({ phraseId: z.string(), extrait: z.string(), texte: z.string(), type: z.enum(['factuelle', 'non_factuelle', 'consigne']), aRisque: z.boolean() }))
    .max(200),
});
const SUBJECTS = ['maths', 'physique', 'svt', 'histoire_geo', 'francais', 'autre'] as const;

export interface RawClaim {
  phraseId: string;
  extrait: string;
  texte: string;
  type: 'factuelle' | 'non_factuelle' | 'consigne';
  aRisque: boolean;
}
/**
 * Controle d'ancrage PAR CODE (etape 6): le phraseId existe et l'extrait (2 mots au moins) est bien dans cette phrase
 * (comparaison normalisee). Sinon l'affirmation est supprimee. Une `consigne` d'exercice n'est jamais une affirmation (T3 B2/B3). Textes en double retires; `max` au plus (MAX_CLAIMS par defaut).
 */
export function anchorClaims(raw: RawClaim[], sentences: Map<string, string>, max = MAX_CLAIMS): { kept: (RawClaim & { page: number })[]; dropped: number } {
  const seen = new Set<string>();
  const kept: (RawClaim & { page: number })[] = [];
  for (const c of raw) {
    const src = sentences.get(c.phraseId);
    const ex = normalize(c.extrait);
    const texte = c.texte.trim();
    const ok = c.type !== 'consigne' && src !== undefined && ex.split(' ').length >= 2 && normalize(src).includes(ex) && texte.length >= 5 && texte.length <= 1000;
    if (!ok || seen.has(normalize(texte)) || kept.length >= max) continue;
    seen.add(normalize(texte));
    kept.push({ ...c, type: c.type as 'factuelle' | 'non_factuelle', texte, page: Number(/^p([0-9]+)-/.exec(c.phraseId)![1]), extrait: c.extrait.trim().slice(0, 300) });
  }
  return { kept, dropped: raw.length - kept.length };
}

/**
 * Budget transmis a L2b: plafond du job (`jobCapEur(pages)`) moins ce qui est depense moins la reserve de generation. Avec des sections,
 * `share` = part de la section dans le reste (mots de la section / mots des sections pas encore traitees): la somme ne depasse jamais le plafond.
 */
export const budgetLeftCents = (micros: number, pages = 1, share = 1): number =>
  Math.max(0, Math.floor((Math.floor(jobCapEur(pages) * 100) - centsFromMicros(micros) - GEN_RESERVE_CENTS) * Math.min(1, Math.max(0, share))));

/** Supprime les elements d'une tentative precedente (les numeros en trop ne doivent pas survivre a une relance). */
async function clearDoc(ctx: Ctx, docId: string, prefixes: string[]): Promise<void> {
  const old = (await ctx.db.query(`DOC#${docId}`)).filter((x) => prefixes.some((p) => x.SK.startsWith(p)));
  if (old.length) await ctx.db.remove(old.map((o) => ({ PK: o.PK, SK: o.SK })));
}

export interface ExtractResult {
  ok: boolean;
  docId?: string;
  budgetRestantCentimes?: number;
  /** Nombre d'affirmations ancrees de la section (0: pas de fiche, la machine passe a la section suivante sans verify-run). */
  claims?: number;
}

/** Plan de sections du job (absent pour un job d'avant 1.3 ou une machine ancienne: une seule section couvre tout le texte). */
const planOf = (job: Item): PlanSection[] | undefined => (Array.isArray(job.sections) ? (job.sections as PlanSection[]) : undefined);

/** Phrases de la section `index` (rang parmi les sections non ignorees) et son identite. Sans plan: tout le texte. */
async function sectionOf(ctx: Ctx, jobId: string, job: Item, index: number) {
  const all = sentencesOf(await sortedTexts(ctx, jobId));
  const plan = planOf(job);
  if (!plan) return { plan, sentences: all, section: undefined, planIndex: 0, rank: 0, kept: [] as ReturnType<typeof keptSections>, restWords: 0, ownWords: 0 };
  const kept = keptSections(plan);
  const k = kept[index];
  if (!k) throw new Error('section inconnue');
  const ranges = rangesOf(all.map((s) => s.id), plan);
  const slice = (n: number): TextSentence[] => all.slice(ranges[n].start, ranges[n].end);
  const wc = (n: number) => slice(n).reduce((a, s) => a + words(s.text).length, 0);
  return {
    plan,
    sentences: slice(k.planIndex),
    section: k.section,
    planIndex: k.planIndex,
    rank: index,
    kept,
    ownWords: wc(k.planIndex),
    restWords: kept.slice(index).reduce((a, x) => a + wc(x.planIndex), 0),
  };
}

/** Ecrit le statut d'une section dans l'en-tete du cours durable (`COURS#`). Sans effet si le job n'a pas de cours. */
async function setCoursStatus(ctx: Ctx, sid: string, job: Item, planIndex: number, statut: 'fiche' | 'sans_fiche'): Promise<void> {
  if (typeof job.coursId !== 'string') return;
  const head = await ctx.db.get(keys.cours(sid, job.coursId));
  if (!head) return;
  const sections = (head.sections as Record<string, unknown>[]).map((s, n) => {
    if (n !== planIndex) return s;
    const { docId, ...rest } = s;
    return statut === 'fiche' ? { ...rest, statut, docId } : { ...rest, statut };
  });
  await ctx.db.put({ ...head, sections });
}

/** Phrases de contexte donnees avec une tranche (deja traitees par la tranche precedente: aucune affirmation n'en est gardee). */
export const CONTEXT_SENTENCES = 2;
/** Affirmations demandees au plus par tranche (40 x environ 130 jetons = 5 200 jetons, sous maxTokens). */
export const SLICE_MAX_CLAIMS = 40;
const SLICE_MAX_TOKENS = 6000;
/** Une tranche de cette taille ou moins n'est plus coupee en deux. */
const MIN_SLICE = 4;

interface ExtractPart {
  titre: string;
  matiere: string;
  affirmations: z.infer<typeof ExtractOut>['affirmations'];
  /** Faux: la sortie a ete coupee (limite de jetons) ou est abimee; `affirmations` ne contient que les objets entiers recus. */
  complete: boolean;
}

/** Lit la sortie d'une tranche. JSON invalide (coupe par la limite de jetons): les affirmations entieres deja recues sont gardees. */
function parseExtractPart(raw: string): ExtractPart {
  try {
    return { ...parseModelJson(raw, ExtractOut), complete: true };
  } catch (e) {
    if (!(e instanceof ModelOutputError)) throw e;
    const items = salvageTruncatedList(raw, 'affirmations');
    return {
      titre: /"titre"\s*:\s*"((?:[^"\\]|\\.)*)"/.exec(raw)?.[1] ?? '',
      matiere: /"matiere"\s*:\s*"([a-z_]*)"/.exec(raw)?.[1] ?? '',
      affirmations: (items ?? []).filter((x) => ExtractOut.shape.affirmations.element.safeParse(x).success) as ExtractPart['affirmations'],
      complete: false,
    };
  }
}

/**
 * Extraction d'une section par tranches (F11): l'eleve n'a jamais a redecouper. Chaque tranche possede ses phrases [start, end[ et recoit en plus
 * CONTEXT_SENTENCES phrases avant elle (contexte): une affirmation ancree sur une phrase qu'une tranche ne possede pas est ignoree, donc aucune
 * phrase n'est comptee deux fois. Sortie coupee: on garde les affirmations entieres des phrases deja passees et on reprend a la derniere phrase
 * atteinte (ses affirmations sont refaites); sans progres, ou sans rien de lisible, la tranche est coupee en deux et rejouee.
 * shortcut: 3 appels par tranche + 6 au plus (puis on garde ce qui est lu); une tranche de 4 phrases illisible est sautee si le reste a donne des affirmations.
 */
async function extractSlices(ctx: Ctx, i: WfInput, sentences: { id: string; text: string }[]): Promise<{ titre: string; matiere: string; claims: RawClaim[] }> {
  const total = sentences.length;
  const at = new Map(sentences.map((s, n) => [s.id, n]));
  const queue: SliceRange[] = sliceRanges(sentences.map((s) => s.text.length));
  const maxCalls = queue.length * 3 + 6;
  const claims: RawClaim[] = [];
  let titre = '';
  let matiere = '';
  let calls = 0;
  let skipped = 0;
  while (queue.length > 0) {
    const r = queue.shift()!;
    if (calls >= maxCalls) {
      if (claims.length > 0) break;
      throw new ModelOutputError('sortie du modele: trop de reprises');
    }
    calls++;
    const from = Math.max(0, r.start - CONTEXT_SENTENCES);
    const numbered = sentences.slice(from, r.end).map((s) => `[${s.id}] ${s.text}`).join('\n');
    const quota = Math.min(SLICE_MAX_CLAIMS, Math.max(3, Math.ceil((MAX_CLAIMS * (r.end - r.start)) / total)));
    let raw: string;
    try {
      raw = await callModel(ctx, i, 'extraction', 'haiku', { system: SYSTEM_JSON, prompt: extractPrompt(numbered, quota, r.start - from), maxTokens: SLICE_MAX_TOKENS });
    } catch (e) {
      // Plafond du scan atteint en cours de route: on garde ce qui est deja extrait plutot que de tout perdre.
      if ((e instanceof JobBudgetExceededError || e instanceof CostBlockedError) && claims.length > 0) break;
      throw e;
    }
    const part = parseExtractPart(raw);
    titre ||= part.titre;
    matiere ||= part.matiere;
    const own = part.affirmations.filter((c) => {
      const n = at.get(c.phraseId);
      return n !== undefined && n >= r.start && n < r.end;
    });
    if (part.complete) {
      claims.push(...own);
      continue;
    }
    const last = own.reduce((m, c) => Math.max(m, at.get(c.phraseId)!), -1);
    if (last > r.start) {
      claims.push(...own.filter((c) => at.get(c.phraseId)! < last));
      queue.unshift({ start: last, end: r.end });
    } else if (r.end - r.start > MIN_SLICE) {
      const mid = r.start + Math.ceil((r.end - r.start) / 2);
      queue.unshift({ start: r.start, end: mid }, { start: mid, end: r.end });
    } else {
      claims.push(...own);
      if (own.length === 0) skipped++;
    }
  }
  if (claims.length === 0 && skipped > 0) throw new ModelOutputError('sortie du modele: illisible');
  // Ordre du cours (tri stable: l'ordre donne par le modele est garde dans une meme phrase).
  const sorted = claims.map((c, n) => ({ c, n })).sort((a, b) => at.get(a.c.phraseId)! - at.get(b.c.phraseId)! || a.n - b.n);
  return { titre, matiere, claims: sorted.map((x) => x.c) };
}

export async function extract(ctx: Ctx, i: WfInput): Promise<ExtractResult> {
  const job0 = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job0 || job0.state !== 'verification') return { ok: false };
  const pages = (job0.pages as number | undefined) ?? 1;
  const sec = await sectionOf(ctx, i.jobId, job0, i.index ?? 0);
  const docId = sec.section ? sec.section.docId! : ((job0.docId as string | undefined) ?? ctx.newId());
  if (!sec.section) await ctx.db.update(jobKey(i.sid, i.jobId), { set: { docId } });
  await ctx.db.update(jobKey(i.sid, i.jobId), { set: { stage: 'fiche' } });
  // Reprise: le cout de la tentative precedente (verdicts sur le point d'etre effaces) est d'abord ajoute au job, une seule fois.
  const attempt = await currentAttempt(ctx, docId);
  if (attempt > 0) await addVerifyCostOnce(ctx, i.sid, i.jobId, docId, attempt);
  await clearDoc(ctx, docId, ['CLAIM#', 'VERDICT#', 'QCM#', 'GAP#']); // restes d'une tentative precedente

  const sentences = new Map(sec.sentences.map((s) => [s.id, s.text]));
  const out = await extractSlices(ctx, i, sec.sentences);
  const kept = thinEvenly(anchorClaims(out.claims, sentences, Infinity).kept, MAX_CLAIMS); // plafond de la section, reparti sur tout le cours
  const sectionsDone = sec.plan ? (await ctx.db.update(jobKey(i.sid, i.jobId), { addSet: { extractedSections: [sec.rank] } }))?.extractedSections ?? [] : [];

  if (kept.length === 0) {
    if (sec.plan) {
      // Section sans affirmation exploitable: pas de fiche, on continue; aucune section avec fiche: le scan est rejete.
      await ctx.db.put({ ...draftKey(docId), attempt: attempt + 1 });
      await setCoursStatus(ctx, i.sid, job0, sec.planIndex, 'sans_fiche');
      const head = typeof job0.coursId === 'string' ? await ctx.db.get(keys.cours(i.sid, job0.coursId)) : undefined;
      const all = (head?.sections as { ignore?: boolean; statut?: string }[] | undefined) ?? [];
      if ((sectionsDone as number[]).length >= sec.kept.length && all.filter((s) => !s.ignore).every((s) => s.statut === 'sans_fiche')) {
        await endWithoutDoc(ctx, i.sid, i.jobId, ['verification'], 'rejete', MSG.noClaims);
        await purgeScan(ctx, i.sid, i.jobId, job0);
        return { ok: false };
      }
      return { ok: true, docId, claims: 0, budgetRestantCentimes: 0 };
    }
    await endWithoutDoc(ctx, i.sid, i.jobId, ['verification'], 'rejete', MSG.noClaims);
    return { ok: false };
  }
  // CLAIM#<nn>: ecrit ici, JAMAIS modifie ensuite; les verdicts (L2b) sont dans VERDICT#<nn>.
  for (const [n, c] of kept.entries()) {
    await ctx.db.put(ClaimItemSchema.parse({ ...keys.claim(docId, n + 1), texte: c.texte, origine: { page: c.page, phraseId: c.phraseId, extrait: c.extrait }, type: c.type, aRisque: c.aRisque }));
  }
  const modelSubject = (SUBJECTS as readonly string[]).includes(out.matiere) ? out.matiere : 'autre';
  // Les choix de l'eleve (matiere, titre de la section) priment sur l'extraction.
  const subject = sec.section?.subject ?? modelSubject;
  const title = cleanLabel(sec.section?.title, 200) ?? (out.titre.trim().slice(0, 200) || 'Cours');
  await ctx.db.put({ ...draftKey(docId), titre: title, matiere: subject, attempt: attempt + 1 });
  const draft = sec.plan && sec.rank > 0 ? {} : { draftTitle: title, draftSubject: subject };
  await ctx.db.update(jobKey(i.sid, i.jobId), { set: { stage: 'verification', ...draft, ...(sec.plan ? {} : { claimCount: kept.length }) } });
  const cur = await ctx.db.get(jobKey(i.sid, i.jobId));
  const share = sec.plan ? (sec.restWords > 0 ? sec.ownWords / sec.restWords : 1) : 1;
  return { ok: true, docId, claims: kept.length, budgetRestantCentimes: budgetLeftCents((cur?.coutMicros as number | undefined) ?? 0, pages, share) };
}

/** Pas `sectionsPlan` de la machine: indices (rang parmi les sections non ignorees) a traiter, sans aucun texte. Sans plan: une section. */
export async function sectionsPlan(ctx: Ctx, i: WfInput): Promise<{ indices: number[] }> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  const plan = job ? planOf(job) : undefined;
  return { indices: plan ? keptSections(plan).map((_, n) => n) : [0] };
}

/** Pas `sectionCost` (apres verify-run, par section): ajoute au job le cout de la verification de cette fiche, une seule fois par tentative. */
export async function sectionCost(ctx: Ctx, i: WfInput & { docId: string }): Promise<{ addedMicros: number }> {
  return { addedMicros: await addVerifyCostOnce(ctx, i.sid, i.jobId, i.docId) };
}

/**
 * Consommation du quota, etat distinct apres les verifications. Reprenable: le passage a `generation` est conditionnel a l'etat `verification`
 * et la consommation des pages est idempotente (quota-ops.ts), donc le quota est consomme UNE fois pour le scan, quel que soit le nombre de
 * sections. `verify` (ancienne machine, une seule fiche): son cout est ajoute ici; avec les sections, `sectionCost` l'a deja fait.
 */
export async function quotaConsume(ctx: Ctx, i: WfInput & { verify?: { coutCentimes?: number } }): Promise<{ ok: boolean }> {
  const c = i.verify?.coutCentimes;
  const verifyCents = typeof c === 'number' && Number.isInteger(c) && c > 0 ? c : 0;
  const moved = await ctx.db.update(jobKey(i.sid, i.jobId), {
    set: { state: 'generation', ...(verifyCents ? { verifyCostAdded: true } : {}) },
    add: { coutMicros: verifyCents * 10_000 },
    cond: { exists: true, in: { state: ['verification'] } },
  });
  // `ok` = le job est (ou etait deja, apres une relance) en `generation`; faux s'il a ete rejete, annule ou termine: la machine ne publie rien.
  if (!moved && (await ctx.db.get(jobKey(i.sid, i.jobId)))?.state !== 'generation') return { ok: false };
  await consumeQuotaOnce(ctx, i.sid, i.jobId);
  return { ok: true };
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

async function makeQuestions(ctx: Ctx, i: WfInput, eligible: Map<string, EligibleClaim>, forSummary: Map<string, EligibleClaim & { verifiee: boolean }>) {
  const cap = questionCap(eligible.size);
  const qcm: GenQcm[] = [];
  const gaps: GenGap[] = [];
  let resume = '';
  const raw = await callModel(ctx, i, 'generation', 'haiku', { system: SYSTEM_JSON, prompt: generatePrompt([...forSummary.values()], cap), maxTokens: 4000 });
  const gen = parseModelJson(raw, GenOut);
  resume = gen.resume.trim();
  const cand = gen.qcm.filter((q) => validQcm(q, eligible)).slice(0, MAX_QUESTIONS); // le plafond `cap` s'applique apres le controle a l'aveugle
  if (cand.length) {
    // Resolution a l'aveugle: un second appel repond sans voir la cle; une reponse differente rejette la question.
    const prompt = solvePrompt(cand.map((q, k) => ({ n: k + 1, claim: eligible.get(q.claimId)!.texte, enonce: q.enonce, choix: q.choix })));
    try {
      const solved = parseModelJson(await callModel(ctx, i, 'controle-qcm', 'haiku', { system: SYSTEM_JSON, prompt, maxTokens: 1000 }), SolveOut);
      const answers = new Map(solved.reponses.map((r) => [r.n, r.choix]));
      cand.forEach((q, k) => {
        if (answers.get(k + 1) === q.cle) qcm.push(q);
      });
      qcm.splice(cap);
    } catch (e) {
      // Controle illisible: aucun QCM non controle n'est publie (les trous, controles par code, restent).
      if (!(e instanceof ModelOutputError)) throw e;
    }
  }
  gaps.push(...gen.trous.filter((g) => validGap(g, eligible)).slice(0, cap));
  return { resume, qcm, gaps };
}

export async function generate(ctx: Ctx, i: WfInput): Promise<{ docId: string; qcm: number; gaps: number; doublon: boolean; skipped?: boolean }> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  const plan = job ? planOf(job) : undefined;
  const slot = plan ? keptSections(plan)[i.index ?? 0] : undefined;
  const docId = slot ? slot.section.docId : job?.docId;
  if (!job || typeof docId !== 'string') throw new Error('job sans fiche');
  if (plan && slot) {
    // Reprise: la fiche existe deja (publiee en dernier) = rien a refaire. Section sans affirmation: pas de fiche.
    if (await ctx.db.get(keys.doc(i.sid, docId))) return { docId, qcm: 0, gaps: 0, doublon: false };
    const head = typeof job.coursId === 'string' ? await ctx.db.get(keys.cours(i.sid, job.coursId)) : undefined;
    if ((head?.sections as { statut?: string }[] | undefined)?.[slot.planIndex]?.statut === 'sans_fiche') return { docId, qcm: 0, gaps: 0, doublon: false, skipped: true };
  }
  if (job.state === 'termine') return { docId, qcm: (job.nbQcm as number) ?? 0, gaps: (job.nbTrous as number) ?? 0, doublon: job.doublon === true };
  const part = await ctx.db.query(`DOC#${docId}`);
  const verdicts = new Map(part.filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [x.SK.slice('VERDICT#'.length), x]));
  // Questions: faits verifies seulement. Resume: faits verifies ou non verifiables (jamais une erreur). Une affirmation `non_factuelle`
  // (consigne, methode, opinion) n'entre ni dans le resume ni dans les questions (T3 B2/B3).
  const eligible = new Map<string, EligibleClaim>();
  const forSummary = new Map<string, EligibleClaim & { verifiee: boolean }>();
  for (const c of part.filter((x) => x.SK.startsWith('CLAIM#'))) {
    const nn = c.SK.slice('CLAIM#'.length);
    const st = claimStatus(c, verdicts.get(nn));
    if (st === 'verifiee') eligible.set(nn, { id: nn, texte: c.texte as string });
    if (st === 'verifiee' || st === 'non_verifiable') forSummary.set(nn, { id: nn, texte: c.texte as string, verifiee: st === 'verifiee' });
  }

  await clearDoc(ctx, docId, ['QCM#', 'GAP#']);
  let made: { resume: string; qcm: GenQcm[]; gaps: GenGap[] } = { resume: '', qcm: [], gaps: [] };
  if (forSummary.size > 0) {
    try {
      made = await makeQuestions(ctx, i, eligible, forSummary);
    } catch (e) {
      // Plafond du job ou budget atteint: on publie la fiche sans questions plutot que de tout perdre.
      // Idem si le modele renvoie une sortie illisible (erreur courante): le travail deja paye n'est pas perdu.
      if (!(e instanceof JobBudgetExceededError) && !(e instanceof CostBlockedError) && !(e instanceof ModelOutputError)) throw e;
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

  // Empreinte et doublon (meme famille), sur le texte de la section seule. Un texte sans groupe de mots n'est jamais un doublon.
  const sec = await sectionOf(ctx, i.jobId, job, i.index ?? 0);
  const mh = minhash(sec.sentences.map((s) => s.text).join(' '));
  const empty = mh.every((v) => v === 0xffffffff);
  const familyDocs = await ctx.db.queryGsi1(`FAMILY#${job.familyId as string}`, 'DOC#');
  const doublon = !empty && familyDocs.some((d) => d.SK !== `DOC#${docId}` && Array.isArray(d.empreinteMinHash) && (d.empreinteMinHash as number[]).length === mh.length && isDuplicate(mh, d.empreinteMinHash as number[]));

  // Copie sur la fiche: sujet, dossier (s'il existe encore), nombre de pages. Section: ses choix; sinon ceux du job (1.2 et 1.3 sans sections).
  const draft = await ctx.db.get(draftKey(docId));
  const topic = cleanTopic(slot ? slot.section.topic : (job.topicChoice ?? job.suggestedTopic));
  const folderRaw = slot ? slot.section.folderId : job.folderId;
  const folderId = typeof folderRaw === 'string' && (await ctx.db.get(keys.folder(i.sid, folderRaw))) ? folderRaw : undefined;
  const subject = slot ? slot.section.subject : (job.subjectChoice ?? job.draftSubject ?? 'autre');
  const title = slot ? (draft?.titre ?? job.draftTitle) : (job.draftTitle ?? 'Cours');
  // Le quota est consomme une fois pour le scan: `pagesConsommees` porte les pages sur la premiere fiche, 0 sur les suivantes.
  let firstFiche = true;
  if (plan && slot) {
    const head = typeof job.coursId === 'string' ? await ctx.db.get(keys.cours(i.sid, job.coursId)) : undefined;
    const st = (head?.sections as { ignore?: boolean; statut?: string }[] | undefined) ?? [];
    firstFiche = st.slice(0, slot.planIndex).every((s) => s.ignore === true || s.statut === 'sans_fiche');
  }
  const createdAt = iso(ctx);
  const fiche = FicheItemSchema.parse({
    ...keys.doc(i.sid, docId),
    titre: title ?? 'Cours',
    matiere: subject,
    empreinteMinHash: mh,
    pagesConsommees: firstFiche ? job.pages : 0,
    doublon,
    createdAt,
    ...(topic ? { sujet: topic } : {}),
    ...(folderId ? { dossierId: folderId } : {}),
    pages: job.pages,
    ...(plan && slot && typeof job.coursId === 'string' ? { coursId: job.coursId, sectionIndex: sec.rank, sectionCount: sec.kept.length } : {}),
  });
  // La fiche est ecrite en dernier: elle n'apparait dans les listes que complete.
  await ctx.db.put({ ...fiche, ...gsi1.doc(job.familyId as string, `${createdAt}#${docId}`), familyId: job.familyId, studentId: i.sid, jobId: i.jobId, resume: made.resume });
  if (plan) return { docId, qcm: made.qcm.length, gaps: made.gaps.length, doublon }; // la fin du scan est le pas `finalize`
  const done = await ctx.db.get(jobKey(i.sid, i.jobId));
  const micros = (done?.coutMicros as number | undefined) ?? 0;
  await transition(ctx, i.sid, i.jobId, ['generation'], 'termine', { finishedAt: iso(ctx), coutCentimes: centsFromMicros(micros), doublon, nbQcm: made.qcm.length, nbTrous: made.gaps.length });
  return { docId, qcm: made.qcm.length, gaps: made.gaps.length, doublon };
}

/** Dernier pas: le scan est termine. `docId` = premiere fiche, `docIds` = les fiches reellement creees (une section sans affirmation n'en a pas). */
export async function finalize(ctx: Ctx, i: WfInput): Promise<{ docIds: string[] }> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job) throw new Error('job introuvable');
  const plan = planOf(job);
  if (!plan) return { docIds: typeof job.docId === 'string' ? [job.docId] : [] };
  const docIds: string[] = [];
  let doublon = false;
  for (const { section } of keptSections(plan)) {
    const f = section.docId ? await ctx.db.get(keys.doc(i.sid, section.docId)) : undefined;
    if (f && section.docId) {
      docIds.push(section.docId);
      doublon ||= f.doublon === true;
    }
  }
  if (docIds.length === 0) throw new Error('aucune fiche creee');
  const micros = (job.coutMicros as number | undefined) ?? 0;
  await transition(ctx, i.sid, i.jobId, ['generation'], 'termine', { finishedAt: iso(ctx), coutCentimes: centsFromMicros(micros), doublon, docId: docIds[0], docIds });
  return { docIds };
}
