// Etapes de la machine `revise` (M1 #90, docs/M1-design.md 3.3 a 3.5). Une modification travaille sur une COPIE (`DOC#<revisionId>-<k>`, sans en-tete de fiche donc invisible);
// rien n'est ecrit dans le cours ni dans la fiche avant `rev-commit`. Echec = on jette la copie. Aucun texte de cours dans l'etat de la machine, les journaux ni les erreurs.
// Aucune de ces etapes n'appelle `setCoursStatus`, `endWithoutDoc`, `purgeScan`, `deleteDocTree` ni `restoreAfterFailedAppend` (B1 de la relecture de la PR #99).
import { keys } from '../../../shared/ddb/keys.js';
import { ClaimItemSchema, CoursBlocksItemSchema, CoursTextItemSchema, GapItemSchema, QcmItemSchema, questionId } from '../../../shared/items.js';
import { sanitizeLatex } from '../../../shared/latex.js';
import { log } from '../../../shared/log/index.js';
import { REVISION_COST_CAP_EUR } from '../../../shared/names.js';
import { parseReviseInput, parseReviseStepInput, type ReviseInput } from '../../../shared/revise-access.js';
import { REVISION_BANK_MAX, REVISION_NEW_CLAIMS, REVISION_NEW_QUESTIONS, REVISION_TTL_S } from '../../../shared/scans.js';
import { releaseLock } from '../pipeline/append.js';
import { centsFromMicros, iso, jobKey, ttlIn, type Ctx } from '../pipeline/ctx.js';
import { sentencesOf } from '../pipeline/job.js';
import type { Item } from '../pipeline/ports.js';
import { addVerifyCostOnce } from '../pipeline/steps-cost.js';
import { anchorClaims, claimStatus, extractSlices, makeQuestions, REVISION_GEN_RESERVE_CENTS, shuffleChoices, type EligibleClaim } from '../pipeline/steps-doc.js';
import { ModelOutputError, thinEvenly } from '../pipeline/text.js';
import { cleanupWork, FINAL_STATES, isRevision, MSG_REVISION } from './lock.js';
import { extractionInput } from './plan.js';
import { settleCost } from './settle.js';
import { applyTo, fichesOf, loadChanges, loadCours, revisionIdOf, type RevFiche } from './store.js';

const OPEN = 'verification';

/** Le job de la modification, ENCORE ouverte (ni annulee, ni echouee). Sinon l'etape s'arrete: `Catch` de la machine vers `rev-fail`. */
async function open(ctx: Ctx, i: ReviseInput): Promise<Item> {
  const job = await ctx.db.get(jobKey(i.sid, i.revisionId));
  if (!isRevision(job) || job.coursId !== i.coursId) throw new Error('modification introuvable');
  if (job.state !== OPEN) throw new Error('modification arretee');
  return job;
}
async function holdsLock(ctx: Ctx, i: ReviseInput): Promise<Item> {
  const head = await ctx.db.get(keys.cours(i.sid, i.coursId));
  if (!head || head.appendJobId !== i.revisionId) throw new Error('verrou du cours perdu');
  return head;
}
const fiche = (job: Item, index: number): RevFiche => fichesOf(job)[index] ?? (() => { throw new Error('fiche de la modification inconnue'); })();
async function clearPart(ctx: Ctx, docId: string, prefixes?: string[]): Promise<void> {
  const part = (await ctx.db.query(`DOC#${docId}`)).filter((x) => !prefixes || prefixes.some((p) => x.SK.startsWith(p)));
  if (part.length) await ctx.db.remove(part.map((o) => ({ PK: o.PK, SK: o.SK })));
}

// ---------------------------------------------------------------- 1. preparation
/** Fixe le plan: une « section » par fiche touchee (le plan est ecrit a la creation, figé par le verrou). Efface les restes d'une tentative precedente de la COPIE. */
export async function revPrepare(ctx: Ctx, raw: unknown): Promise<{ indices: number[] }> {
  const i = parseReviseInput(raw);
  const job = await open(ctx, i);
  await holdsLock(ctx, i);
  for (const f of fichesOf(job)) await clearPart(ctx, f.workDocId);
  await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { etape: 'verification' }, cond: { exists: true, eq: { state: OPEN } } });
  return { indices: fichesOf(job).map((_, k) => k) };
}

// ---------------------------------------------------------------- 2. extraction (dediee: jamais `extract` tel quel)
/** Budget transmis a la verification: plafond de la modification (0,10 EUR) moins le depense et la reserve de generation, partage entre les fiches restantes. */
export const revBudgetLeftCents = (micros: number, share = 1): number => Math.max(0, Math.floor((Math.floor(REVISION_COST_CAP_EUR * 100) - centsFromMicros(micros) - REVISION_GEN_RESERVE_CENTS) * Math.min(1, Math.max(0, share))));

export async function revExtract(ctx: Ctx, raw: unknown): Promise<{ ok: true; docId: string; claims: number; budgetRestantCentimes: number }> {
  const i = parseReviseStepInput(raw);
  const job = await open(ctx, i);
  const f = fiche(job, i.index);
  const head = await holdsLock(ctx, i);
  const changes = await loadChanges(ctx, i.revisionId);
  const { texts, blocks } = await loadCours(ctx, i.sid, i.coursId, head);
  const applied = applyTo(texts, blocks, changes);
  if (!applied.ok) throw new Error('changements invalides');
  const removed = new Set(changes.removed);
  const changed = new Set([...changes.corrections.map((c) => c.id).filter((id) => !removed.has(id)), ...applied.ids.values()]);
  const { owned, context } = extractionInput(sentencesOf(applied.texts), head.sections as { fromSentenceId: string }[], f.sectionIndex, changed);
  await clearPart(ctx, f.workDocId, ['CLAIM#', 'VERDICT#', 'QCM#', 'GAP#', 'FICHE']); // restes d'une tentative precedente: la COPIE seulement, jamais la fiche vivante
  // Aucune affirmation n'est un cas NORMAL (les touchees sont retirees, rien ne les remplace): la modification continue.
  if (!owned.length) return { ok: true, docId: f.workDocId, claims: 0, budgetRestantCentimes: 0 };
  const out = await extractSlices(ctx, { jobId: i.revisionId, sid: i.sid }, owned, context);
  const kept = thinEvenly(anchorClaims(out.claims, new Map(owned.map((s) => [s.id, s.text])), Infinity).kept, REVISION_NEW_CLAIMS);
  // Numeros definitifs des maintenant: `claimMax + rang`, figes par le verrou. `rev-commit` ecrit les memes elements aux memes cles (rejouable).
  const ttl = ttlIn(ctx, REVISION_TTL_S);
  for (const [n, c] of kept.entries()) {
    await ctx.db.put({ ...ClaimItemSchema.parse({ ...keys.claim(f.workDocId, f.claimMax + n + 1), texte: c.texte, origine: { page: c.page, phraseId: c.phraseId, extrait: c.extrait }, type: c.type, aRisque: c.aRisque }), ttl });
  }
  const cur = await ctx.db.get(jobKey(i.sid, i.revisionId));
  const share = 1 / Math.max(1, fichesOf(job).length - i.index);
  return { ok: true, docId: f.workDocId, claims: kept.length, budgetRestantCentimes: revBudgetLeftCents((cur?.coutMicros as number | undefined) ?? 0, share) };
}

// ---------------------------------------------------------------- 3. generation de la fiche et des nouvelles questions
/** Reecrit `body` et `recall` de la fiche (a partir des affirmations valides) et genere les nouvelles questions, DANS LA COPIE. Un appel de modele: jamais rejoue par la machine. */
export async function revGenerate(ctx: Ctx, raw: unknown): Promise<{ docId: string; qcm: number; gaps: number }> {
  const i = parseReviseStepInput(raw);
  const job = await open(ctx, i);
  const f = fiche(job, i.index);
  await holdsLock(ctx, i);
  await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { etape: 'generation' }, cond: { exists: true, eq: { state: OPEN } } });
  await addVerifyCostOnce(ctx, i.sid, i.revisionId, f.workDocId); // cout de `verify-run`, une seule fois (marqueur COSTADDED# du job)
  const header = await ctx.db.get(keys.doc(i.sid, f.docId));
  if (!header) throw new Error('fiche introuvable');
  const live = await ctx.db.query(`DOC#${f.docId}`);
  const fresh = await ctx.db.query(`DOC#${f.workDocId}`);
  const retired = new Set([...((header.claimsRetired as number[] | undefined) ?? []), ...f.retired].map(Number));
  const verdicts = new Map([...live, ...fresh].filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [`${x.PK}|${x.SK.slice('VERDICT#'.length)}`, x]));
  const forSummary = new Map<string, EligibleClaim & { verifiee: boolean }>();
  const eligible = new Map<string, EligibleClaim>();
  // Affirmations valides: les anciennes NON retirees (verdict non `erreur`) et les nouvelles. Seules les NOUVELLES verifiees donnent des questions.
  for (const [part, isNew] of [[live, false], [fresh, true]] as const) {
    for (const c of part.filter((x) => x.SK.startsWith('CLAIM#'))) {
      const nn = c.SK.slice('CLAIM#'.length);
      if (!isNew && retired.has(Number(nn))) continue;
      const st = claimStatus(c, verdicts.get(`${c.PK}|${nn}`));
      if (st === 'verifiee') {
        forSummary.set(nn, { id: nn, texte: c.texte as string, verifiee: true });
        if (isNew) eligible.set(nn, { id: nn, texte: c.texte as string });
      } else if (st === 'non_verifiable') forSummary.set(nn, { id: nn, texte: c.texte as string, verifiee: false });
    }
  }
  if (forSummary.size === 0) throw new ModelOutputError('plus aucune affirmation valide'); // une fiche vide n'est jamais ecrite: la modification echoue, le cours reste intact
  const made = await makeQuestions(ctx, { jobId: i.revisionId, sid: i.sid }, eligible, forSummary);
  const active = (kind: 'QCM#' | 'GAP#') => live.filter((x) => x.SK.startsWith(kind) && x.retiree !== true && !retired.has(Number(x.claimId))).length;
  const roomQcm = Math.min(REVISION_NEW_QUESTIONS, Math.max(0, REVISION_BANK_MAX - active('QCM#')));
  const roomGap = Math.min(REVISION_NEW_QUESTIONS, Math.max(0, REVISION_BANK_MAX - active('GAP#')));
  const ttl = ttlIn(ctx, REVISION_TTL_S);
  const qcm = made.qcm.slice(0, roomQcm);
  const gaps = made.gaps.slice(0, roomGap);
  for (const [k, q] of qcm.entries()) {
    const n = f.qcmMax + k + 1;
    const qid = questionId(f.docId, 'qcm', n); // l'identifiant de la FICHE vivante: la question sera promue telle quelle
    const sh = shuffleChoices(q.choix, q.cle, qid);
    await ctx.db.put({ ...QcmItemSchema.parse({ ...keys.qcm(f.workDocId, n), questionId: qid, enonce: sanitizeLatex(q.enonce.trim()), choix: sh.choix.map((c) => sanitizeLatex(c)), cle: sh.cle, claimId: q.claimId }), ttl });
  }
  for (const [k, g] of gaps.entries()) {
    const n = f.gapMax + k + 1;
    await ctx.db.put({ ...GapItemSchema.parse({ ...keys.gap(f.workDocId, n), questionId: questionId(f.docId, 'gap', n), phrase: sanitizeLatex(g.phrase.trim()), attendu: g.attendu.trim(), claimId: g.claimId }), ttl });
  }
  // Texte de la fiche, DANS LA COPIE (`DOC#<revisionId>-<k> / FICHE`): `rev-commit` l'applique a l'en-tete de la fiche.
  await ctx.db.put({ PK: `DOC#${f.workDocId}`, SK: 'FICHE', resume: sanitizeLatex(made.resume), ...(made.fiche ? { body: made.fiche.body, recall: made.fiche.recall } : {}), ttl });
  return { docId: f.workDocId, qcm: qcm.length, gaps: gaps.length };
}

// ---------------------------------------------------------------- 4. validation (sans modele: reprise automatique permise, idempotente)
const COPIED = ['CLAIM#', 'VERDICT#', 'QCM#', 'GAP#'];

/**
 * Ordre (docs/M1-design.md 3.4, corrige par la relecture de la PR #99 B3): 0 `commitStartedAt`; 1 copie des nouveaux elements (`attribute_not_exists`); 2 `retiree` sur les questions
 * des affirmations retirees; 3 en-tete de la fiche (sans `rev`); 4 texte et blocs du cours + `committedAt` dans UNE transaction; 5 (inclus en 4); 6 `rev` de chaque fiche, EN DERNIER;
 * 7 reglement du cout et nettoyage; 8 etat `termine` puis verrou libere en dernier.
 * Pas de champ `v`: ni les textes ni l'en-tete du cours n'en ont; le verrou (un seul ecrivain) et la condition `appendJobId` de la transaction suffisent.
 */
export async function revCommit(ctx: Ctx, raw: unknown): Promise<{ ok: true }> {
  const i = parseReviseInput(raw);
  let job = await ctx.db.get(jobKey(i.sid, i.revisionId));
  if (!isRevision(job) || job.coursId !== i.coursId) throw new Error('modification introuvable');
  if (job.state === 'termine') {
    await releaseLock(ctx, i.sid, i.coursId, i.revisionId); // plantage entre l'etat et le verrou: le verrou est libere EN DERNIER, rejouable
    return { ok: true };
  }
  if (!(job.state === OPEN || (job.state === 'echec' && job.commitStartedAt !== undefined))) throw new Error('modification arretee');
  if (job.committedAt === undefined) {
    const head = await holdsLock(ctx, i);
    if (job.commitStartedAt === undefined) {
      // « Le commit a commence: on ne l'annule plus, on le termine ». Perdu si l'eleve a annule entre-temps (etat change).
      const started = await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { commitStartedAt: iso(ctx), etape: 'validation' }, cond: { exists: true, eq: { state: OPEN }, absent: ['commitStartedAt'] } });
      if (!started) {
        job = await ctx.db.get(jobKey(i.sid, i.revisionId));
        if (job?.commitStartedAt === undefined) throw new Error('modification annulee');
      }
    }
    for (const f of fichesOf(job)) await promote(ctx, i, f);
    await writeCours(ctx, i, head);
    job = (await ctx.db.get(jobKey(i.sid, i.revisionId))) ?? job;
  }
  // `committedAt` est pose: seules les etapes 6 a 8 restent (rejouables).
  await finish(ctx, i, job);
  return { ok: true };
}

/** Etapes 1 a 3 pour une fiche. */
async function promote(ctx: Ctx, i: ReviseInput, f: RevFiche): Promise<void> {
  const work = await ctx.db.query(`DOC#${f.workDocId}`);
  for (const it of work.filter((x) => COPIED.some((p) => x.SK.startsWith(p)))) {
    const { ttl: _ttl, ...rest } = it as Item & { ttl?: number };
    void _ttl;
    await ctx.db.put({ ...rest, PK: `DOC#${f.docId}` }, true); // jamais remplace: un element deja ecrit (reprise) reste tel quel
  }
  // 2. questions (et exercices) des affirmations retirees: sorties du tirage, jamais supprimees (l'historique et les points les citent). Les nouvelles n'en dependent pas.
  const retired = new Set(f.retired);
  const live = await ctx.db.query(`DOC#${f.docId}`);
  for (const q of live.filter((x) => (x.SK.startsWith('QCM#') || x.SK.startsWith('GAP#')) && retired.has(Number(x.claimId)) && x.retiree !== true)) {
    await ctx.db.update({ PK: q.PK, SK: q.SK }, { set: { retiree: true }, cond: { exists: true } });
  }
  for (const e of live.filter((x) => x.SK.startsWith('EXO#') && x.retiree !== true && ((x.claimIds as string[] | undefined) ?? []).some((c) => retired.has(Number(c))))) {
    await ctx.db.update({ PK: e.PK, SK: e.SK }, { set: { retiree: true }, cond: { exists: true } });
  }
  // 3. en-tete de la fiche: affirmations retirees (union), texte, nombre de questions. SANS `rev` (ecrit en dernier).
  const header = await ctx.db.get(keys.doc(i.sid, f.docId));
  if (!header) return; // fiche supprimee pendant la modification: refusee par `docs-delete`; rien a ecrire
  const text = work.find((x) => x.SK === 'FICHE');
  const after = await ctx.db.query(`DOC#${f.docId}`);
  const nbQuestions = after.filter((x) => (x.SK.startsWith('QCM#') || x.SK.startsWith('GAP#')) && x.retiree !== true).length;
  const claimsRetired = [...new Set([...((header.claimsRetired as number[] | undefined) ?? []), ...f.retired])].sort((a, b) => a - b);
  await ctx.db.update(keys.doc(i.sid, f.docId), {
    set: { claimsRetired, nbQuestions, ...(text ? { resume: text.resume, ...(text.body ? { body: text.body } : {}), ...(text.recall ? { recall: text.recall } : {}) } : {}) },
    ...(text && !text.body ? { remove: ['body', 'recall'] } : {}),
    cond: { exists: true },
  });
}

/** Etape 4 (et 5): le texte et les blocs du cours, plus `committedAt`, en UNE transaction conditionnee par le verrou. Deja pose: rien a refaire (jamais reapplique deux fois). */
async function writeCours(ctx: Ctx, i: ReviseInput, head: Item): Promise<void> {
  const changes = await loadChanges(ctx, i.revisionId);
  const { texts, blocks } = await loadCours(ctx, i.sid, i.coursId, head);
  const applied = applyTo(texts, blocks, changes);
  if (!applied.ok) throw new Error('changements invalides');
  const ok = await ctx.db.transact([
    { key: keys.cours(i.sid, i.coursId), spec: { set: { nbPhrases: sentencesOf(applied.texts).length }, cond: { exists: true, eq: { appendJobId: i.revisionId } } } },
    { key: jobKey(i.sid, i.revisionId), spec: { set: { committedAt: iso(ctx) }, cond: { exists: true, absent: ['committedAt'] } } },
    ...applied.changed.map((t) => ({ put: CoursTextItemSchema.parse({ ...keys.coursText(i.sid, i.coursId, Number(t.page)), page: t.page, sentences: t.sentences }) })),
    ...(blocks && applied.blocks ? [{ put: CoursBlocksItemSchema.parse({ ...keys.coursBlocks(i.sid, i.coursId), blocks: applied.blocks, figures: blocks.figures ?? [] }) }] : []),
  ]);
  if (!ok && (await ctx.db.get(jobKey(i.sid, i.revisionId)))?.committedAt === undefined) throw new Error('ecriture du cours refusee'); // verrou perdu: un bogue, rien n'est perdu
}

/** Etapes 6 a 8: `rev` en dernier, reglement du cout, nettoyage, etat `termine`, verrou libere EN DERNIER. */
async function finish(ctx: Ctx, i: ReviseInput, job: Item): Promise<void> {
  for (const f of fichesOf(job)) await ctx.db.update(keys.doc(i.sid, f.docId), { set: { rev: f.rev + 1 }, cond: { exists: true } }); // affectation depuis la base figee: jamais un incrément
  await settleCost(ctx, job);
  await cleanupWork(ctx, job);
  await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { restoredAt: iso(ctx), state: 'termine', finishedAt: iso(ctx) }, cond: { exists: true } });
  await releaseLock(ctx, i.sid, i.coursId, i.revisionId);
}

// ---------------------------------------------------------------- 5. echec
/**
 * Filet de la machine (`Catch` de chaque tache, `States.Timeout` compris). Regle (relecture de la PR #99 B3), JAMAIS « finie » d'apres `rev`:
 *  - `committedAt` present: seules les etapes 6 a 8 sont rejouees;
 *  - `commitStartedAt` seul: le cours peut etre a moitie ecrit, on NE l'annule PAS: on rejoue `rev-commit`; s'il echoue encore, le job passe a `echec` SANS `restoredAt`, la copie et le verrou
 *    restent (inertes, 7 jours) et le journal `revision-bloquee` alimente une alarme;
 *  - ni l'un ni l'autre: rien de visible n'a ete ecrit, la modification est annulee (copie supprimee, cout regle, verrou libere en dernier).
 */
export async function revFail(ctx: Ctx, raw: unknown): Promise<{ ok: boolean }> {
  const i = parseReviseInput(raw);
  const job = await ctx.db.get(jobKey(i.sid, i.revisionId));
  if (!isRevision(job) || job.coursId !== i.coursId) return { ok: false };
  if (job.state === 'termine') {
    await releaseLock(ctx, i.sid, i.coursId, i.revisionId);
    return { ok: true };
  }
  if (job.committedAt !== undefined) {
    await finish(ctx, i, job);
    return { ok: true };
  }
  if (job.commitStartedAt !== undefined) return replay(ctx, i);
  // Annulation: le premier qui change l'etat gagne la course contre un `rev-commit` qui demarre. Deja final (annulee par l'eleve): on garde son etat.
  if (job.state === OPEN) {
    const failed = await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { state: 'echec', finishedAt: iso(ctx), message: MSG_REVISION.failed }, cond: { exists: true, eq: { state: OPEN }, absent: ['commitStartedAt'] } });
    if (!failed) {
      const cur = await ctx.db.get(jobKey(i.sid, i.revisionId));
      if (cur?.commitStartedAt !== undefined) return replay(ctx, i);
    }
  }
  const cur = (await ctx.db.get(jobKey(i.sid, i.revisionId))) ?? job;
  if (!FINAL_STATES.includes(cur.state as string)) throw new Error('etat inattendu');
  for (const f of fichesOf(cur)) await addVerifyCostOnce(ctx, i.sid, i.revisionId, f.workDocId); // cout de `verify-run` d'une fiche non generee, une seule fois
  await settleCost(ctx, cur);
  await cleanupWork(ctx, cur);
  await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { restoredAt: iso(ctx) }, cond: { exists: true } });
  await releaseLock(ctx, i.sid, i.coursId, revisionIdOf(cur)); // en dernier; sans effet si l'annulation l'a deja libere
  return { ok: true };
}

async function replay(ctx: Ctx, i: ReviseInput): Promise<{ ok: boolean }> {
  try {
    await revCommit(ctx, i);
    return { ok: true };
  } catch {
    await ctx.db.update(jobKey(i.sid, i.revisionId), { set: { state: 'echec', finishedAt: iso(ctx), message: MSG_REVISION.stuck }, cond: { exists: true } });
    log({ jobId: i.revisionId, step: 'revision-bloquee', status: 'error' }); // alarme: aucun contenu
    return { ok: false };
  }
}

