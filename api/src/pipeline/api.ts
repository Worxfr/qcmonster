// Handlers HTTP du pipeline (routes owner=pipeline): scans-create, jobs-get, jobs-transcription, jobs-confirm, jobs-cancel.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ConfirmRequestSchema, ScanCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { costGateFor } from '../../../shared/cost.js';
import { keys, monthParis } from '../../../shared/ddb/keys.js';
import { releasePages, reservePages } from '../../../shared/quota.js';
import { bodyOf, callerOf, fail, json, pathId, requireStudent, resetDate } from './http.js';
import { centsFromMicros, DAY_S, iso, jobKey, ttlIn, type Ctx } from './ctx.js';
import { endWithoutDoc, loadJob, quotaScope, scansPrefix, transition } from './job.js';
import type { Item } from './ports.js';

/** Limites d'envoi (design-v2 4.1 etape 1): 5 Mo par image. Les PDF ne sont pas pris en charge dans cette version (voir L2a-report.md). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_WINDOW_S = 15 * 60;
export const MESSAGES = { cancelled: "Annule par l'eleve" } as const;

type Res = Promise<APIGatewayProxyStructuredResultV2>;

/** Job au format du contrat (Job). Le cout vient du compteur en micro-euros, converti en centimes (arrondi au-dessus). */
export function jobView(j: Item) {
  const started = typeof j.confirmedAt === 'string' ? Date.parse(j.confirmedAt) : NaN;
  const ended = typeof j.finishedAt === 'string' ? Date.parse(j.finishedAt) : NaN;
  const micros = (j.coutMicros as number | undefined) ?? 0;
  return {
    jobId: j.SK.slice('JOB#'.length),
    state: j.state,
    pages: j.pages,
    createdAt: j.createdAt,
    ...(Number.isFinite(started) && Number.isFinite(ended) ? { durationSeconds: Math.max(0, Math.round((ended - started) / 1000)) } : {}),
    ...(micros > 0 ? { costCents: centsFromMicros(micros) } : {}),
    ...(typeof j.docId === 'string' ? { docId: j.docId } : {}),
    ...(typeof j.message === 'string' ? { message: j.message } : {}),
  };
}

export async function scansCreate(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const parsed = ScanCreateRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  const { pages, contentType } = parsed.data;
  if (contentType === 'application/pdf') return fail('requete_invalide', 'Les PDF ne sont pas encore pris en charge: envoie des photos');

  const totals = await ctx.costStore.read();
  if (costGateFor(ctx.env, totals) !== 'ok') return fail('budget_epuise', 'Le service est en pause pour le moment', { resetDate: resetDate(ctx.now()) });

  const month = monthParis(ctx.now());
  const scope = await quotaScope(ctx, caller.familyId, sid, month);
  if (!(await reservePages(ctx.quota, scope, pages))) return fail('quota_epuise', 'Quota de pages epuise', { resetDate: resetDate(ctx.now()) });

  const jobId = ctx.newId();
  try {
    await ctx.db.put(
      {
        ...jobKey(sid, jobId),
        familyId: caller.familyId,
        studentId: sid,
        state: 'en_attente_envoi',
        pages,
        expectedFiles: pages,
        contentType,
        quotaMonth: month,
        quotaState: 'reserved',
        coutMicros: 0,
        coutCentimes: 0,
        createdAt: iso(ctx),
        ttl: ttlIn(ctx, 7 * DAY_S),
      },
      true,
    );
    // Le workflow demarre tout de suite: s'il n'y a pas d'envoi dans les 15 min, il rend le quota (aucune reservation orpheline).
    await ctx.sfn.start(`job-${jobId}`, { jobId, sid });
    const upload = await ctx.s3.presignPost({ prefix: scansPrefix(sid, jobId), firstKey: `${scansPrefix(sid, jobId)}0`, contentType, maxBytes: MAX_IMAGE_BYTES, expiresSec: UPLOAD_WINDOW_S });
    const q = await ctx.quota.get(keys.quota(caller.familyId, month, sid));
    return json(201, {
      jobId,
      upload,
      expiresAt: new Date(ctx.now().getTime() + UPLOAD_WINDOW_S * 1000).toISOString(),
      pagesRemaining: typeof q?.restant === 'number' ? q.restant : 0,
    });
  } catch (e) {
    // Echec apres reservation: on rend les pages et on ferme le job s'il a ete cree.
    const job = await ctx.db.get(jobKey(sid, jobId));
    if (job) await endWithoutDoc(ctx, sid, jobId, ['en_attente_envoi'], 'echec', 'Creation impossible');
    else await releasePages(ctx.quota, scope, pages);
    throw e;
  }
}

async function ownJob(ctx: Ctx, event: APIGatewayProxyEventV2): Promise<{ sid: string; jobId: string; job: Item }> {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const jobId = pathId(event, 'jobId');
  const job = await ctx.db.get(jobKey(sid, jobId));
  if (!job) return fail('introuvable', 'Introuvable');
  return { sid, jobId, job };
}

export async function jobsGet(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { job } = await ownJob(ctx, event);
  return json(200, jobView(job));
}

const PHOTO_URL_TTL_S = 300;

export async function jobsTranscription(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  if (job.state !== 'a_confirmer') return fail('etat_invalide', "Le job n'est pas a confirmer");
  const texts = (await ctx.db.query(`JOB#${jobId}`, 'TEXT#')).sort((a, b) => Number(a.page) - Number(b.page));
  const keysList = await ctx.s3.list(scansPrefix(sid, jobId));
  const photoUrls = await Promise.all(keysList.map((k) => ctx.s3.presignGet(k, PHOTO_URL_TTL_S)));
  return json(200, {
    jobId,
    docType: job.docType ?? 'cours',
    pages: texts.map((t) => ({ page: t.page, sentences: t.sentences })),
    photoUrls,
    photoUrlsExpireAt: new Date(ctx.now().getTime() + PHOTO_URL_TTL_S * 1000).toISOString(),
  });
}

export async function jobsConfirm(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  const parsed = ConfirmRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  if (job.state !== 'a_confirmer') return fail('etat_invalide', "Le job n'est pas a confirmer");

  // Corrections: chaque identifiant doit exister; on remplace le texte de la phrase (jamais d'ajout ni de suppression).
  const texts = await ctx.db.query(`JOB#${jobId}`, 'TEXT#');
  const byId = new Map<string, Item>();
  for (const t of texts) for (const s of t.sentences as { id: string }[]) byId.set(s.id, t);
  const changed = new Map<string, Item>();
  for (const c of parsed.data.corrections) {
    const page = byId.get(c.id);
    if (!page) return fail('requete_invalide', 'Phrase inconnue');
    const text = c.text.trim();
    if (!text) return fail('requete_invalide', 'Phrase vide');
    const sentences = (changed.get(page.SK) ?? page).sentences as { id: string; text: string }[];
    changed.set(page.SK, { ...(changed.get(page.SK) ?? page), sentences: sentences.map((s) => (s.id === c.id ? { id: s.id, text } : s)) });
  }
  for (const item of changed.values()) await ctx.db.put(item);

  // Le premier qui change l'etat gagne la course contre une annulation ou l'expiration.
  const moved = await transition(ctx, sid, jobId, ['a_confirmer'], 'verification', { confirmedAt: iso(ctx) });
  if (!moved) return fail('etat_invalide', "Le job n'est plus a confirmer");
  await ctx.s3.deleteAll(scansPrefix(sid, jobId)); // la photo disparait a la confirmation
  if (typeof moved.confirmToken === 'string') await ctx.sfn.taskSuccess(moved.confirmToken);
  return json(200, jobView(moved));
}

export async function jobsCancel(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  if (job.state !== 'en_attente_envoi' && job.state !== 'a_confirmer') return fail('etat_invalide', 'Ce traitement ne peut plus etre annule');
  const won = await endWithoutDoc(ctx, sid, jobId, ['en_attente_envoi', 'a_confirmer'], 'rejete', MESSAGES.cancelled);
  if (!won) return fail('etat_invalide', 'Ce traitement ne peut plus etre annule');
  const after = await loadJob(ctx, sid, jobId);
  // Libere l'attente du workflow (envoi ou confirmation); un jeton deja termine est ignore par l'adaptateur Step Functions.
  for (const token of [after.confirmToken, after.uploadToken]) if (typeof token === 'string') await ctx.sfn.taskFailure(token, 'Cancelled');
  return json(200, jobView(after));
}
