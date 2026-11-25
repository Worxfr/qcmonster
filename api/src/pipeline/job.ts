// Job: lecture, transitions conditionnelles et sorties communes (rejet, echec, expiration). Un seul ecrivain: L2a.
import { monthParis } from '../../../shared/ddb/keys.js';
import { centsFromMicros, iso, jobKey, type Ctx } from './ctx.js';
import { returnQuotaOnce } from './quota-ops.js';
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
  const results = await Promise.allSettled([returnQuotaOnce(ctx, sid, jobId), ctx.s3.deleteAll(scansPrefix(sid, jobId))]);
  const failed = results.find((r) => r.status === 'rejected');
  if (failed) throw (failed as PromiseRejectedResult).reason;
  return true;
}

export const ALL_OPEN: JobState[] = ['en_attente_envoi', 'verification_fichier', 'transcription', 'a_confirmer', 'verification', 'generation'];

export { monthParis };

// ---------------------------------------------------------------- texte du scan et plan de sections
/** Phrase du texte de travail (`JOB#.../TEXT#`). */
export interface TextSentence {
  id: string;
  text: string;
  pages?: number[];
}
/** Pages du texte de travail, triees NUMERIQUEMENT par numero de page (`TEXT#10` passerait avant `TEXT#2` en tri lexical). */
export async function sortedTexts(ctx: Ctx, jobId: string): Promise<Item[]> {
  return (await ctx.db.query(`JOB#${jobId}`, 'TEXT#')).sort((a, b) => Number(a.page) - Number(b.page));
}
/** Toutes les phrases du cours, dans l'ordre du texte (une phrase recollee compte une fois). Pas de numeros supposes consecutifs. */
export const sentencesOf = (texts: Item[]): TextSentence[] => texts.flatMap((t) => t.sentences as TextSentence[]);

/** Section du plan ecrit sur le job a la confirmation (`Job.sections`). */
export interface PlanSection {
  fromSentenceId: string;
  subject: string;
  topic?: string;
  title?: string;
  folderId?: string;
  ignore: boolean;
  docId?: string;
}
/** Intervalle [start, end[ de phrases de chaque section du plan, dans l'ordre du texte. */
export function rangesOf(ids: string[], plan: PlanSection[]): { start: number; end: number }[] {
  const starts = plan.map((s) => ids.indexOf(s.fromSentenceId));
  return starts.map((start, n) => ({ start, end: n + 1 < starts.length ? starts[n + 1] : ids.length }));
}
/** Sections avec fiche prevue (non ignorees), avec leur rang dans le plan. */
export const keptSections = (plan: PlanSection[]): { section: PlanSection; planIndex: number }[] =>
  plan.map((section, planIndex) => ({ section, planIndex })).filter((x) => !x.section.ignore);
