// Job: lecture, transitions conditionnelles et sorties communes (rejet, echec, expiration). Un seul ecrivain: L2a.
import { monthParis } from '../../../shared/ddb/keys.js';
import { centsFromMicros, iso, jobKey, type Ctx } from './ctx.js';
import { releaseQuotaOnce } from './quota-ops.js';
import type { Item } from './ports.js';

export type JobState = 'en_attente_envoi' | 'verification_fichier' | 'transcription' | 'a_confirmer' | 'verification' | 'generation' | 'termine' | 'rejete' | 'echec' | 'expire';
export const TERMINAL: JobState[] = ['termine', 'rejete', 'echec', 'expire'];
export const isTerminal = (s: unknown): boolean => TERMINAL.includes(s as JobState);

/** Cle S3 des photos: scans/<eleve>/<job>/<n> (le prefixe `scans/` declenche la regle EventBridge; l'eleve permet de retrouver le job). */
export const scansPrefix = (sid: string, jobId: string) => `scans/${sid}/${jobId}/`;

export async function loadJob(ctx: Ctx, sid: string, jobId: string): Promise<Item> {
  const j = await ctx.db.get(jobKey(sid, jobId));
  if (!j) throw new Error('job introuvable');
  return j;
}

/** Transition conditionnelle: renvoie le job mis a jour, ou undefined si l'etat actuel n'est pas l'un de `from`. */
export function transition(ctx: Ctx, sid: string, jobId: string, from: JobState[], to: JobState, extra: Record<string, unknown> = {}): Promise<Item | undefined> {
  return ctx.db.update(jobKey(sid, jobId), { set: { state: to, ...extra }, cond: { exists: true, in: { state: from } } });
}

/**
 * Fin sans fiche (rejet, echec, expiration, annulation): etat final conditionnel, quota rendu, photos supprimees.
 * Renvoie false si le job avait deja quitte les etats `from` (un autre acteur a gagne la course).
 */
export async function endWithoutDoc(ctx: Ctx, sid: string, jobId: string, from: JobState[], to: 'rejete' | 'echec' | 'expire', message: string): Promise<boolean> {
  const cur = await ctx.db.get(jobKey(sid, jobId));
  const micros = (cur?.coutMicros as number | undefined) ?? 0;
  const job = await transition(ctx, sid, jobId, from, to, { message, finishedAt: iso(ctx), coutCentimes: centsFromMicros(micros) });
  if (!job) return false;
  // Les deux nettoyages sont tentes meme si l'un echoue (quota rendu, photo supprimee); l'erreur remonte ensuite.
  const results = await Promise.allSettled([releaseQuotaOnce(ctx, sid, jobId), ctx.s3.deleteAll(scansPrefix(sid, jobId))]);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return true;
}

export const ALL_OPEN: JobState[] = ['en_attente_envoi', 'verification_fichier', 'transcription', 'a_confirmer', 'verification', 'generation'];

export { monthParis };
