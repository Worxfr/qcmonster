// Job: lecture, transitions conditionnelles et sorties communes (rejet, echec, expiration). Un seul ecrivain: L2a.
import { releasePages, type QuotaScope } from '../../../shared/quota.js';
import { monthParis, keys } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { centsFromMicros, iso, jobKey, type Ctx } from './ctx.js';
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

/** Plafonds de quota de l'eleve et de la famille (lus dans Eleve / Famille, sinon valeurs par defaut de l'environnement). */
export async function quotaScope(ctx: Ctx, familyId: string, sid: string, month: string): Promise<QuotaScope> {
  const d = quotaDefaults(ctx.env);
  const [student, family] = await Promise.all([ctx.db.get(keys.student(familyId, sid)), ctx.db.get(keys.family(familyId))]);
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : dflt);
  return { familyId, studentId: sid, month, studentLimit: num(student?.quotaPages, d.studentPages), familyLimit: num(family?.quotaPages, d.familyPages) };
}

/** Rend les pages reservees, une seule fois (le drapeau `quotaState` passe de reserved a released avant l'ecriture du quota). */
export async function releaseQuotaOnce(ctx: Ctx, job: Item): Promise<void> {
  const won = await ctx.db.update(jobKey(job.studentId as string, job.SK.slice(4)), { set: { quotaState: 'released' }, cond: { exists: true, eq: { quotaState: 'reserved' } } });
  if (!won) return;
  const scope = await quotaScope(ctx, job.familyId as string, job.studentId as string, job.quotaMonth as string);
  await releasePages(ctx.quota, scope, job.pages as number);
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
  await releaseQuotaOnce(ctx, job);
  await ctx.s3.deleteAll(scansPrefix(sid, jobId));
  return true;
}

export const ALL_OPEN: JobState[] = ['en_attente_envoi', 'verification_fichier', 'transcription', 'a_confirmer', 'verification', 'generation'];

export { monthParis };
