// Handler `scans-delete` (DELETE /scans/{scanId}, contrat 1.3 additif): l'eleve supprime un scan NON confirme, a tout moment.
// Reutilise les sorties communes du pipeline (`endWithoutDoc`, `returnQuotaOnce`): les pages sont rendues une seule fois (marqueurs QUOTAOP).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { isCancelled } from '../../../shared/scans.js';
import { MESSAGES } from '../pipeline/api.js';
import { iso, jobKey, type Ctx } from '../pipeline/ctx.js';
import { callerOf, fail, noContent, pathId, requireStudent } from '../pipeline/http.js';
import { endWithoutDoc, scansPrefix, type JobState } from '../pipeline/job.js';
import { returnQuotaOnce } from '../pipeline/quota-ops.js';
import { restoreAfterFailedAppend } from '../pipeline/append.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;

/** Pas encore confirme: l'eleve peut tout arreter. */
const OPEN: JobState[] = ['en_attente_envoi', 'verification_fichier', 'transcription', 'a_confirmer'];
/** Fini sans fiche (rejet, echec, expiration): reste liste 7 jours, l'eleve peut le retirer. */
const ENDED: JobState[] = ['rejete', 'echec', 'expire'];

export async function scansDelete(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller); // le parent a 403; l'eleve ne lit que sa partition: un scan d'un autre eleve est introuvable
  const jobId = pathId(event, 'scanId');
  const key = jobKey(sid, jobId);
  let job = await ctx.db.get(key);
  if (!job) return fail('introuvable', 'Introuvable');
  const alreadyGone = isCancelled(job); // supprime ou annule avant cet appel

  if (OPEN.includes(job.state as JobState) && job.confirmStartedAt !== undefined) return fail('etat_invalide', 'La confirmation est en cours, réessaie dans un instant'); // ajout de pages
  if (OPEN.includes(job.state as JobState)) {
    // Le premier qui change l'etat gagne la course contre une confirmation, l'expiration ou une autre suppression.
    await endWithoutDoc(ctx, sid, jobId, OPEN, 'rejete', MESSAGES.cancelled);
    job = (await ctx.db.get(key)) ?? job;
  } else if (ENDED.includes(job.state as JobState) && !alreadyGone) {
    // Echec ou expiration encore liste: on le retire de la liste (meme marque qu'une annulation: `rejete` + message) et on rejoue le nettoyage.
    await ctx.db.update(key, { set: { state: 'rejete', message: MESSAGES.cancelled, finishedAt: job.finishedAt ?? iso(ctx) }, cond: { exists: true, in: { state: ENDED } } });
    job = (await ctx.db.get(key)) ?? job;
  }
  if (!ENDED.includes(job.state as JobState)) return fail('etat_invalide', 'Ce scan est déjà confirmé');

  // Nettoyage rejouable (une suppression interrompue se termine au prochain appel): quota rendu une fois, photos, texte de travail,
  // puis liberation de la machine (jeton d'envoi ou de confirmation) pour qu'aucune reprise tardive ne recree de donnees.
  await returnQuotaOnce(ctx, sid, jobId);
  await ctx.s3.deleteAll(scansPrefix(sid, jobId));
  const texts = (await ctx.db.query(`JOB#${jobId}`)).filter((t) => t.SK.startsWith('TEXT#') || t.SK === 'BLOCKS').map((t) => ({ PK: t.PK, SK: t.SK })); // TEXT# et BLOCKS (R1)
  if (texts.length) await ctx.db.remove(texts);
  // Ajout de pages: la restauration est rejouee seulement si le pipeline ne l'a pas faite (`restoredAt` pose = rien a rejouer, pas d'appel superflu).
  if (job.appendTo && typeof job.restoredAt !== 'string') await restoreAfterFailedAppend(ctx, sid, job);
  for (const token of [job.confirmToken, job.uploadToken]) if (typeof token === 'string') await ctx.sfn.taskFailure(token, 'Cancelled');

  // Premiere suppression: 204. Un scan deja supprime ou annule avant cet appel est introuvable (le nettoyage ci-dessus n'a alors rien rendu de plus).
  return alreadyGone ? fail('introuvable', 'Introuvable') : noContent();
}
