// POST /cours/{coursId}/revisions (handler `revise-create`, M1 #90, docs/M1-design.md 3.3 et 6): modifier le texte d'un cours confirme.
// Eleve seulement. Tout est controle AVANT la moindre ecriture; la creation (job + verrou + compteurs) est UNE transaction. Aucun texte de cours dans les journaux ni les erreurs.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ReviseRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { costGateFor } from '../../../shared/cost.js';
import { keys, monthParis } from '../../../shared/ddb/keys.js';
import { CoursBlocksItemSchema, CoursTextItemSchema } from '../../../shared/items.js';
import { REVISION_CLAIMS_RETIRED_MAX, REVISION_MAX_NN, REVISION_MONTH_FAMILY_MICROS, REVISION_MONTH_STUDENT_MICROS, REVISION_NEW_CLAIMS, REVISION_NEW_QUESTIONS, REVISION_PER_COURS_PER_DAY, REVISION_PER_STUDENT_PER_DAY, REVISION_RESERVE_MICROS, REVISION_TTL_S } from '../../../shared/scans.js';
import { CHANGE_MESSAGES } from '../pipeline/changes.js';
import { DELETING, releaseLock } from '../pipeline/append.js';
import { dayParis, iso, jobKey, ttlIn, type Ctx } from '../pipeline/ctx.js';
import { bodyOf, callerOf, fail, json, pathId, requireStudent, resetDate } from '../pipeline/http.js';
import { sentencesOf } from '../pipeline/job.js';
import type { Item, TxOp } from '../pipeline/ports.js';
import { analyse, PLAN_MESSAGES } from './plan.js';
import { FINAL_STATES, MSG_REVISION } from './lock.js';
import { applyTo, loadCours, revisionView, type Changes, type RevFiche } from './store.js';
import { settleCost } from './settle.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;
const REVISION_OPEN = 'verification';
const nnOf = (sk: string, prefix: string): number => Number(sk.slice(prefix.length)) || 0;

/**
 * Le verrou est-il libre ou repris? Jamais de restauration ici (ce role n'a pas les droits d'un ajout interrompu): un verrou n'est repris que si son job
 * est absent (expire), termine, ou final ET restaure. Sinon 409.
 */
async function lockFree(ctx: Ctx, sid: string, head: Item): Promise<boolean> {
  const holder = head.appendJobId;
  if (typeof holder !== 'string') return true;
  if (holder === DELETING) return false;
  const job = await ctx.db.get(jobKey(sid, holder));
  const done = !job || job.state === 'termine' || (FINAL_STATES.includes(job.state as string) && typeof job.restoredAt === 'string');
  if (!done) return false;
  await releaseLock(ctx, sid, head.SK.slice('COURS#'.length), holder);
  return true;
}

export async function reviseCreate(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  // Interrupteur d'exploitation (REVISE_ENABLED, ferme par defaut): tant que la politique de confidentialite n'est pas relevee, aucun parcours n'atteint cette route.
  if (ctx.cfg?.reviseEnabled !== true) return fail('introuvable', MSG_REVISION.off);
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const coursId = pathId(event, 'coursId');
  const parsed = ReviseRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  const req: Changes = { corrections: (parsed.data.corrections ?? []).map((c) => ({ id: c.id, text: c.text })), removed: parsed.data.removed ?? [], added: (parsed.data.added ?? []).map((a) => ({ key: a.key, afterId: a.afterId, text: a.text, ...(a.newBlock ? { newBlock: true } : {}) })) };

  // 404 uniforme: cours inconnu ou d'un autre eleve (la cle porte l'identifiant du jeton).
  let head = (await ctx.db.get(keys.cours(sid, coursId))) ?? fail('introuvable', 'Introuvable');
  if (!(await lockFree(ctx, sid, head))) fail('etat_invalide', head.appendJobId === DELETING ? MSG_REVISION.deleting : MSG_REVISION.other);
  head = (await ctx.db.get(keys.cours(sid, coursId))) ?? fail('introuvable', 'Introuvable');
  const origin = typeof head.jobId === 'string' ? await ctx.db.get(jobKey(sid, head.jobId)) : undefined;
  if (origin && origin.state !== 'termine') fail('etat_invalide', MSG_REVISION.notFinished);

  // Le texte apres changements, SANS rien ecrire: memes regles que la relecture (fonction pure partagee).
  const { texts, blocks } = await loadCours(ctx, sid, coursId, head);
  const applied = applyTo(texts, blocks, req);
  if (!applied.ok) return fail('requete_invalide', CHANGE_MESSAGES[applied.error]);
  const before = sentencesOf(texts);
  const after = sentencesOf(applied.texts);
  const sections = head.sections as { fromSentenceId: string; ignore?: boolean; statut?: string; docId?: string }[];
  const plan = analyse(before, after, sections, { corrected: req.corrections.map((c) => c.id), removed: req.removed, added: [...applied.ids.values()] });
  if (!plan.ok) return fail('requete_invalide', PLAN_MESSAGES[plan.error]);

  // Fiches touchees: elles existent encore (une fiche supprimee n'a plus de docId vivant: la partie est modifiee sans fiche).
  const changedIds = new Set([...req.corrections.map((c) => c.id), ...req.removed]);
  const fiches: RevFiche[] = [];
  const revisionId = ctx.newId();
  for (const k of plan.touched.fiches) {
    const docId = sections[k].docId!;
    const doc = await ctx.db.get(keys.doc(sid, docId));
    if (!doc) continue;
    const part = await ctx.db.query(`DOC#${docId}`);
    const retiredBefore = new Set(((doc.claimsRetired as number[] | undefined) ?? []).map(Number));
    const claims = part.filter((x) => x.SK.startsWith('CLAIM#'));
    const claimMax = claims.reduce((m, x) => Math.max(m, nnOf(x.SK, 'CLAIM#')), 0);
    const qcmMax = part.filter((x) => x.SK.startsWith('QCM#')).reduce((m, x) => Math.max(m, nnOf(x.SK, 'QCM#')), 0);
    const gapMax = part.filter((x) => x.SK.startsWith('GAP#')).reduce((m, x) => Math.max(m, nnOf(x.SK, 'GAP#')), 0);
    const retired = claims.filter((c) => changedIds.has((c.origine as { phraseId: string }).phraseId) && !retiredBefore.has(nnOf(c.SK, 'CLAIM#'))).map((c) => nnOf(c.SK, 'CLAIM#'));
    // Numeros jamais reutilises, sur deux chiffres: la fiche doit pouvoir recevoir les nouveaux (garde-fou de capacite).
    if (claimMax + REVISION_NEW_CLAIMS > REVISION_MAX_NN || qcmMax + REVISION_NEW_QUESTIONS > REVISION_MAX_NN || gapMax + REVISION_NEW_QUESTIONS > REVISION_MAX_NN || retiredBefore.size + retired.length > REVISION_CLAIMS_RETIRED_MAX) {
      return fail('fiche_trop_revisee', MSG_REVISION.tooRevised);
    }
    fiches.push({ docId, workDocId: `${revisionId}-${fiches.length}`, sectionIndex: k, claimMax, qcmMax, gapMax, rev: (doc.rev as number | undefined) ?? 0, retired, numerosRestants: Math.max(0, REVISION_MAX_NN - Math.max(claimMax, qcmMax, gapMax)) });
  }

  // Plafonds, lus d'abord pour un message precis; la TRANSACTION de creation les impose (aucune course ne les depasse).
  const day = dayParis(ctx.now());
  const month = monthParis(ctx.now());
  const fid = caller.familyId;
  const reserve = fiches.length ? REVISION_RESERVE_MICROS : 0;
  const [dayItem, monthItem, famItem] = await Promise.all([ctx.db.get(keys.revDay(sid, day)), ctx.db.get(keys.revMonth(sid, month)), ctx.db.get(keys.revFamily(fid, month))]);
  const cKey = `c_${coursId}`;
  if (((dayItem?.n as number | undefined) ?? 0) >= REVISION_PER_STUDENT_PER_DAY || ((dayItem?.[cKey] as number | undefined) ?? 0) >= REVISION_PER_COURS_PER_DAY) return fail('plafond_revisions', MSG_REVISION.limit, { resetDate: nextDay(ctx) });
  if (reserve && (((monthItem?.coutMicros as number | undefined) ?? 0) + reserve > REVISION_MONTH_STUDENT_MICROS || ((famItem?.coutMicros as number | undefined) ?? 0) + reserve > REVISION_MONTH_FAMILY_MICROS)) return fail('plafond_revisions', MSG_REVISION.limit, { resetDate: resetDate(ctx.now()) });
  if (fiches.length && costGateFor(ctx.env, await ctx.costStore.read()) !== 'ok') return fail('budget_epuise', 'Le service est en pause pour le moment', { resetDate: resetDate(ctx.now()) });

  const createdAt = iso(ctx);
  const job: Item = {
    ...jobKey(sid, revisionId),
    kind: 'revision',
    familyId: fid,
    studentId: sid,
    coursId,
    // Statut en base: les valeurs de `state` des scans (`reclaimLock` et `listScans` les lisent); l'`etat` du contrat n'en est qu'une traduction (`revisionView`).
    state: fiches.length ? REVISION_OPEN : 'termine',
    etape: 'preparation',
    pages: 1,
    quotaState: 'none',
    coutMicros: 0,
    coutCentimes: 0,
    quotaMonth: month,
    reserveMicros: reserve,
    createdAt,
    ttl: ttlIn(ctx, REVISION_TTL_S),
    changes: { corrections: req.corrections.length, removed: req.removed.length, added: req.added.length },
    ...(fiches.length ? { fiches, docIds: fiches.map((f) => f.workDocId) } : { committedAt: createdAt, restoredAt: createdAt, settledAt: createdAt, finishedAt: createdAt }),
  };
  const dayOp: TxOp = {
    key: keys.revDay(sid, day),
    spec: { add: { n: 1, [cKey]: 1 }, set: { ttl: ttlIn(ctx, 2 * 86_400) }, cond: { lt: { n: REVISION_PER_STUDENT_PER_DAY, [cKey]: REVISION_PER_COURS_PER_DAY } } },
  };
  const counters = (): TxOp[] =>
    reserve
      ? [
          { key: keys.revMonth(sid, month), spec: { add: { coutMicros: reserve }, set: { ttl: ttlIn(ctx, 40 * 86_400) }, cond: { lt: { coutMicros: REVISION_MONTH_STUDENT_MICROS - reserve + 1 } } } },
          { key: keys.revFamily(fid, month), spec: { add: { coutMicros: reserve }, set: { ttl: ttlIn(ctx, 40 * 86_400) }, cond: { lt: { coutMicros: REVISION_MONTH_FAMILY_MICROS - reserve + 1 } } } },
        ]
      : [];
  const guard = { exists: true, eq: { pages: head.pages, nbPhrases: head.nbPhrases } };

  if (!fiches.length) {
    // Aucune fiche touchee (parties ignorees): une seule transaction ecrit le job termine, les compteurs et le texte. Pas de verrou long: la condition `appendJobId` absent, l'etat
    // lu (pages, phrases) et le compteur « 1 par cours et par jour » (meme transaction) excluent un ajout, une modification ou une suppression concurrents.
    const ops: TxOp[] = [
      { put: job, ifNotExists: true },
      { key: keys.cours(sid, coursId), spec: { set: { nbPhrases: after.length }, cond: { ...guard, absent: ['appendJobId'] } } },
      dayOp,
      ...applied.changed.map((t): TxOp => ({ put: CoursTextItemSchema.parse({ ...keys.coursText(sid, coursId, Number(t.page)), page: t.page, sentences: t.sentences }) })),
      ...(blocks && applied.blocks ? [{ put: CoursBlocksItemSchema.parse({ ...keys.coursBlocks(sid, coursId), blocks: applied.blocks, figures: blocks.figures ?? [] }) } as TxOp] : []),
    ];
    if (!(await ctx.db.transact(ops))) return refused(ctx, sid, coursId, head, day, cKey);
    return json(200, revisionView(job));
  }

  // La requete (texte de l'eleve, 7 jours) AVANT la transaction: un echec la supprime. Puis job + verrou + compteurs ensemble: jamais de verrou sans job.
  await ctx.db.put({ ...keys.revChanges(revisionId), ...req, ttl: ttlIn(ctx, REVISION_TTL_S) });
  const created = await ctx.db.transact([
    { put: job, ifNotExists: true },
    { key: keys.cours(sid, coursId), spec: { set: { appendJobId: revisionId }, cond: { ...guard, absent: ['appendJobId'] } } },
    dayOp,
    ...counters(),
  ]);
  if (!created) {
    await ctx.db.remove([keys.revChanges(revisionId)]);
    return refused(ctx, sid, coursId, head, day, cKey);
  }
  try {
    await ctx.sfn.start(`rev-${revisionId}`, { revisionId, sid, fid, coursId });
  } catch (e) {
    // Une panne du lancement ne laisse ni verrou ni reserve: le job est ferme, les compteurs rendus, la requete supprimee, le verrou libere EN DERNIER.
    await abandon(ctx, job, day, cKey);
    throw e;
  }
  return json(202, revisionView(job));
}

const nextDay = (ctx: Ctx): string => new Date(Date.parse(`${dayParis(ctx.now())}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** La transaction a echoue: dire pourquoi (verrou pris ou plafond), sans rien avoir ecrit. */
async function refused(ctx: Ctx, sid: string, coursId: string, head: Item, day: string, cKey: string): Promise<never> {
  const now = await ctx.db.get(keys.cours(sid, coursId));
  if (!now) return fail('introuvable', 'Introuvable');
  if (typeof now.appendJobId === 'string') return fail('etat_invalide', now.appendJobId === DELETING ? MSG_REVISION.deleting : MSG_REVISION.other);
  const d = await ctx.db.get(keys.revDay(sid, day));
  if (((d?.n as number | undefined) ?? 0) >= REVISION_PER_STUDENT_PER_DAY || ((d?.[cKey] as number | undefined) ?? 0) >= REVISION_PER_COURS_PER_DAY) return fail('plafond_revisions', MSG_REVISION.limit, { resetDate: nextDay(ctx) });
  if (now.pages !== head.pages || now.nbPhrases !== head.nbPhrases) return fail('etat_invalide', MSG_REVISION.other); // le cours a change entre la lecture et l'ecriture
  return fail('plafond_revisions', MSG_REVISION.limit, { resetDate: resetDate(ctx.now()) }); // plafond mensuel (eleve ou famille)
}

/** Lancement impossible: rend la reserve et le compteur du jour, supprime la requete, ferme le job, libere le verrou en dernier. */
async function abandon(ctx: Ctx, job: Item, day: string, cKey: string): Promise<void> {
  const sid = job.studentId as string;
  const revisionId = job.SK.slice('JOB#'.length);
  await ctx.db.update(jobKey(sid, revisionId), { set: { state: 'echec', finishedAt: iso(ctx), message: MSG_REVISION.failed }, cond: { exists: true, eq: { state: REVISION_OPEN } } });
  await ctx.db.update(keys.revDay(sid, day), { add: { n: -1, [cKey]: -1 }, cond: { exists: true } });
  await settleCost(ctx, job);
  await ctx.db.remove([keys.revChanges(revisionId)]);
  await ctx.db.update(jobKey(sid, revisionId), { set: { restoredAt: iso(ctx) }, cond: { exists: true } });
  await releaseLock(ctx, sid, job.coursId as string, revisionId);
}
