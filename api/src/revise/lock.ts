// Modification d'un cours confirme (M1 #90): verrou, refus de suppression et nettoyage. Un seul verrou par cours: `appendJobId` (F10), valeur = `revisionId`.
// Nettoyage: `Query` puis `BatchWriteItem` SEULEMENT (jamais `deleteDocTree`, `purgeScan` ni `restoreAfterFailedAppend`: ils passent par S3, droits que ces roles n'ont pas).
import { keys } from '../../../shared/ddb/keys.js';
import { iso, jobKey, type Ctx } from '../pipeline/ctx.js';
import { DELETING, releaseLock } from '../pipeline/append.js';
import type { Item } from '../pipeline/ports.js';

export const MSG_REVISION = {
  busy: 'Une modification est en cours',
  other: 'Une autre opération est en cours pour ce cours',
  deleting: 'Ce cours est en cours de suppression',
  notFinished: 'Ce cours est encore en cours de création',
  tooRevised: 'Cette fiche a été trop retouchée : supprime-la et rescanne',
  limit: 'Trop de modifications pour le moment, réessaie plus tard',
  cannotCancel: 'Cette modification ne peut plus être annulée',
  failed: 'La modification a échoué : ton cours n’a pas changé',
  cancelled: 'Modification annulée',
  done: 'Modification terminée',
  stuck: 'La modification n’a pas pu être terminée, elle sera reprise',
  off: 'Introuvable',
} as const;

export const FINAL_STATES = ['termine', 'rejete', 'echec', 'expire'];
export const isRevision = (job: Item | undefined): job is Item => job?.kind === 'revision';
/** Une modification est « ouverte » tant qu'elle n'est pas finie: elle tient le verrou du cours. */
export const isOpenRevision = (job: Item | undefined): boolean => isRevision(job) && !FINAL_STATES.includes(job.state as string);
/** Identifiants de la copie de travail de la modification: ses fiches de travail (`<revisionId>-<k>`). */
export const workDocIds = (job: Item): string[] => ((job.docIds as unknown[] | undefined) ?? []).filter((d): d is string => typeof d === 'string' && d.startsWith(`${job.SK.slice('JOB#'.length)}-`));

/** Supprime la copie de travail (fiches de travail, requete, marqueurs de cout): jamais une fiche vivante. Rejouable. */
export async function cleanupWork(ctx: Ctx, job: Item): Promise<void> {
  const revisionId = job.SK.slice('JOB#'.length);
  for (const docId of workDocIds(job)) {
    const part = await ctx.db.query(`DOC#${docId}`);
    if (part.length) await ctx.db.remove(part.map((o) => ({ PK: o.PK, SK: o.SK })));
  }
  const rest = await ctx.db.query(`JOB#${revisionId}`);
  if (rest.length) await ctx.db.remove(rest.map((o) => ({ PK: o.PK, SK: o.SK })));
}

/** Verrou du cours tenu par une modification? Renvoie son job. */
export async function revisionHolder(ctx: Ctx, sid: string, head: Item): Promise<Item | undefined> {
  const holder = head.appendJobId;
  if (typeof holder !== 'string' || holder === DELETING) return undefined;
  const job = await ctx.db.get(jobKey(sid, holder));
  return isRevision(job) ? job : undefined;
}

/**
 * `DELETE /cours` face a une modification: ouverte = 409 (renvoie false). Finie sans nettoyage (`rev-fail` a plante apres l'echec): la copie de travail est supprimee
 * ICI, puis le verrou libere (renvoie true). Sinon rien a faire (true). `shortcut: pas de route d'administration pour lever ce verrou; a ajouter si l'alarme revision-bloquee sonne`.
 */
export async function clearRevisionForDelete(ctx: Ctx, sid: string, head: Item): Promise<boolean> {
  const job = await revisionHolder(ctx, sid, head);
  if (!job) return true;
  const blocked = job.state === 'echec' && typeof job.restoredAt !== 'string';
  if (isOpenRevision(job) && !blocked) return false;
  if (blocked) {
    await cleanupWork(ctx, job);
    await ctx.db.update(jobKey(sid, job.SK.slice('JOB#'.length)), { set: { restoredAt: iso(ctx) }, cond: { exists: true } });
    await releaseLock(ctx, sid, head.SK.slice('COURS#'.length), job.SK.slice('JOB#'.length));
  }
  return true;
}

/** `DELETE /docs`: la fiche est-elle touchee par une modification ouverte de son cours? Les autres fiches du cours restent supprimables. */
export async function ficheLockedByRevision(ctx: Ctx, sid: string, doc: Item): Promise<boolean> {
  if (typeof doc.coursId !== 'string') return false;
  const head = await ctx.db.get(keys.cours(sid, doc.coursId));
  if (!head) return false;
  const job = await revisionHolder(ctx, sid, head);
  if (!job || (!isOpenRevision(job) && !(job.state === 'echec' && typeof job.restoredAt !== 'string'))) return false;
  const docId = doc.SK.slice('DOC#'.length);
  return ((job.fiches as { docId: string }[] | undefined) ?? []).some((f) => f.docId === docId);
}
