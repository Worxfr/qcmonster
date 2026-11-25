// Handlers HTTP du pipeline (routes owner=pipeline): scans-create, jobs-get, jobs-transcription, jobs-confirm, jobs-cancel.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ConfirmRequestSchema, ScanCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { costGateFor } from '../../../shared/cost.js';
import { keys, monthParis } from '../../../shared/ddb/keys.js';
import { cleanLabel, cleanTopic, planSections, statusOfJob, SUBJECTS, type SectionError } from '../../../shared/scans.js';
import { CoursItemSchema, CoursTextItemSchema } from '../../../shared/items.js';
import { releasePages, reservePages } from '../../../shared/quota.js';
import { log } from '../../../shared/log/index.js';
import { bodyOf, callerOf, fail, json, pathId, requireStudent, resetDate } from './http.js';
import { centsFromMicros, DAY_S, iso, jobKey, ttlIn, type Ctx } from './ctx.js';
import { endWithoutDoc, loadJob, scansPrefix, sentencesOf, sortedTexts, transition } from './job.js';
import { MIN_WORDS } from './steps.js';
import { words } from './text.js';
import { quotaScope } from './quota-ops.js';
import type { Item } from './ports.js';

/** Limites d'envoi (design-v2 4.1 etape 1): 5 Mo par image. Les PDF ne sont pas pris en charge dans cette version (voir L2a-report.md). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_WINDOW_S = 15 * 60;
export const MESSAGES = { cancelled: "Annule par l'eleve" } as const;

type Res = Promise<APIGatewayProxyStructuredResultV2>;

/** Job au format du contrat (Job). Le cout vient du compteur en micro-euros, converti en centimes (arrondi au-dessus). */
export function jobView(j: Item, now: Date = new Date()) {
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
    status: statusOfJob(j, now),
    ...(j.state === 'termine' && Array.isArray(j.docIds) && j.docIds.length ? { docIds: j.docIds } : {}),
  };
}

export async function scansCreate(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const parsed = ScanCreateRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  const { pages, contentType, contentTypes, folderId } = parsed.data;
  if (contentType === 'application/pdf') return fail('requete_invalide', 'Les PDF ne sont pas encore pris en charge: envoie des photos');
  // Tout est controle AVANT la reservation des pages: un refus ne laisse rien a rendre.
  if (contentTypes && contentTypes.length !== pages) return fail('requete_invalide', 'Un type par page est attendu');
  if (folderId !== undefined && !(await ctx.db.get(keys.folder(sid, folderId)))) return fail('introuvable', 'Dossier introuvable');
  const typeOf = (n: number): string => contentTypes?.[n] ?? contentType;

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
        ...(contentTypes ? { contentTypes } : {}),
        ...(folderId ? { folderId } : {}),
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
    // Une URL pre-signee PAR page: cle exacte scans/<eleve>/<job>/<p-1>, type fige pour cette page.
    const uploads = [];
    for (let n = 0; n < pages; n++) {
      const target = await ctx.s3.presignPost({ prefix: scansPrefix(sid, jobId), firstKey: `${scansPrefix(sid, jobId)}${n}`, contentType: typeOf(n), maxBytes: MAX_IMAGE_BYTES, expiresSec: UPLOAD_WINDOW_S });
      uploads.push({ page: n + 1, ...target });
    }
    const upload = uploads[0];
    const q = await ctx.quota.get(keys.quota(caller.familyId, month, sid));
    return json(201, {
      jobId,
      upload: { url: upload.url, fields: upload.fields },
      uploads,
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
  return json(200, jobView(job, ctx.now()));
}

const PHOTO_URL_TTL_S = 300;

export async function jobsTranscription(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  if (job.state !== 'a_confirmer') return fail('etat_invalide', "Le job n'est pas a confirmer");
  const texts = await sortedTexts(ctx, jobId); // tri NUMERIQUE des pages
  // Seules les photos attendues (indices < nombre de pages): un envoi en trop sous le prefixe n'est jamais montre. Tri numerique: « 10 » apres « 2 ».
  const prefix = scansPrefix(sid, jobId);
  const keysList = (await ctx.s3.list(prefix))
    .filter((k) => /^\d{1,2}$/.test(k.slice(prefix.length)) && Number(k.slice(prefix.length)) < (job.expectedFiles as number))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  const photoUrls = await Promise.all(keysList.map((k) => ctx.s3.presignGet(k, PHOTO_URL_TTL_S)));
  return json(200, {
    jobId,
    docType: job.docType ?? 'cours',
    pages: texts.map((t) => ({ page: t.page, sentences: t.sentences })),
    ...(typeof job.suggestedSubject === 'string' ? { suggestedSubject: job.suggestedSubject } : {}),
    ...(typeof job.suggestedTopic === 'string' ? { suggestedTopic: job.suggestedTopic } : {}),
    ...(Array.isArray(job.suggestedSections) && job.suggestedSections.length ? { suggestedSections: job.suggestedSections } : {}),
    photoUrls,
    photoUrlsExpireAt: new Date(ctx.now().getTime() + PHOTO_URL_TTL_S * 1000).toISOString(),
  });
}

/** Messages des refus de decoupage: des constantes, jamais le texte d'une phrase. */
const SECTION_MESSAGES: Record<SectionError, string> = {
  inconnu: 'Phrase de depart inconnue',
  ordre: 'Les sections doivent suivre l\'ordre du texte',
  debut: 'La premiere section commence a la premiere phrase',
  trop: 'Trop de sections pour ce scan',
  aucune_fiche: 'Garde au moins une section',
  vide: 'Une section est vide',
  trop_court: 'Il faut au moins 40 mots dans les parties gardees',
};

interface Chosen {
  fromSentenceId: string;
  subject: string;
  topic?: string;
  title?: string;
  folderId?: string;
  ignore: boolean;
}

export async function jobsConfirm(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  const parsed = ConfirmRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  if (job.state !== 'a_confirmer') return fail('etat_invalide', "Le job n'est pas a confirmer");
  const req = parsed.data;

  // Corrections: chaque identifiant doit exister; on remplace le texte de la phrase (jamais d'ajout ni de suppression).
  const texts = await sortedTexts(ctx, jobId);
  const byId = new Map<string, Item>();
  for (const t of texts) for (const s of t.sentences as { id: string }[]) byId.set(s.id, t);
  const changed = new Map<string, Item>();
  for (const c of req.corrections) {
    const page = byId.get(c.id);
    if (!page) return fail('requete_invalide', 'Phrase inconnue');
    const text = c.text.trim();
    if (!text) return fail('requete_invalide', 'Phrase vide');
    const sentences = (changed.get(page.SK) ?? page).sentences as { id: string; text: string; pages?: number[] }[];
    // Les pages d'une phrase recollee restent celles de la lecture: la correction ne change que le texte.
    changed.set(page.SK, { ...(changed.get(page.SK) ?? page), sentences: sentences.map((s) => (s.id === c.id ? { ...s, text } : s)) });
  }
  const finalTexts = texts.map((t) => changed.get(t.SK) ?? t);
  const all = sentencesOf(finalTexts);

  // Choix de l'eleve, valides AVANT toute ecriture (400 et 404 ne laissent rien derriere eux).
  const jobFolder = typeof job.folderId === 'string' ? job.folderId : undefined;
  const fallbackSubject = SUBJECTS.find((x) => x === job.suggestedSubject) ?? SUBJECTS.find((x) => x === job.draftSubject) ?? 'autre';
  const folderExists = async (id: string | undefined) => id === undefined || !!(await ctx.db.get(keys.folder(sid, id)));
  let chosen: Chosen[];
  let single: { subjectChoice?: string; topicChoice?: string; folderId?: string } | undefined;
  if (req.sections) {
    if (req.subject !== undefined || req.topic !== undefined || req.folderId !== undefined) return fail('requete_invalide', 'Choisis soit des sections, soit une matiere pour tout le cours');
    chosen = [];
    for (const s of req.sections) {
      const topic = s.topic === undefined ? undefined : cleanTopic(s.topic);
      const title = s.title === undefined ? undefined : cleanLabel(s.title, 200);
      if (s.topic !== undefined && !topic) return fail('requete_invalide', 'Sujet vide');
      if (s.title !== undefined && !title) return fail('requete_invalide', 'Titre vide');
      if (!(await folderExists(s.folderId))) return fail('introuvable', 'Dossier introuvable');
      chosen.push({ fromSentenceId: s.fromSentenceId, subject: s.subject, ...(topic ? { topic } : {}), ...(title ? { title } : {}), ...(s.folderId ?? jobFolder ? { folderId: s.folderId ?? jobFolder } : {}), ignore: s.ignore === true });
    }
  } else {
    const topic = req.topic === undefined ? undefined : cleanTopic(req.topic);
    if (req.topic !== undefined && !topic) return fail('requete_invalide', 'Sujet vide'); // « <> » ou des espaces: le schema les laisse passer
    if (!(await folderExists(req.folderId))) return fail('introuvable', 'Dossier introuvable');
    const folderId = req.folderId ?? jobFolder;
    single = { ...(req.subject ? { subjectChoice: req.subject } : {}), ...(topic ? { topicChoice: topic } : {}), ...(folderId ? { folderId } : {}) };
    chosen = [{ fromSentenceId: all[0]?.id ?? '', subject: req.subject ?? fallbackSubject, ...(topic ?? (job.suggestedTopic as string | undefined) ? { topic: topic ?? (job.suggestedTopic as string) } : {}), ...(folderId ? { folderId } : {}), ignore: false }];
  }
  const plan = planSections(all.map((s) => s.id), chosen, { wordCounts: all.map((s) => words(s.text).length), minWords: MIN_WORDS, pages: job.pages as number });
  if (!plan.ok) return fail('requete_invalide', SECTION_MESSAGES[plan.error]);

  // (a) identifiants: un docId par section non ignoree; le cours porte l'identifiant du job (deterministe: une relance ne laisse pas d'orphelin).
  const coursId = jobId;
  const sections = chosen.map((c) => ({ ...c, ...(c.ignore ? {} : { docId: ctx.newId() }) }));
  const docIds = sections.flatMap((s) => (s.docId ? [s.docId] : []));
  // (b) cours durable (sans TTL), corrections appliquees, section ignoree conservee. Une ecriture identique rejouee est sans effet.
  const createdAt = iso(ctx);
  await ctx.db.put(CoursItemSchema.parse({ ...keys.cours(sid, coursId), jobId, pages: job.pages, createdAt, nbPhrases: all.length, sections: sections.map((s) => ({ ...s, statut: s.ignore ? 'ignoree' : 'fiche' })) }));
  for (const t of finalTexts) await ctx.db.put(CoursTextItemSchema.parse({ ...keys.coursText(sid, coursId, t.page as number), page: t.page, sentences: t.sentences }));
  // (c) le plan sur le job et la transition, en une seule ecriture conditionnelle: le premier qui change l'etat gagne la course
  // contre une annulation ou l'expiration.
  const moved = await transition(ctx, sid, jobId, ['a_confirmer'], 'verification', { confirmedAt: iso(ctx), coursId, docIds, sections, ...(single ?? {}) });
  if (!moved) return fail('etat_invalide', "Le job n'est plus a confirmer");
  const token = typeof moved.confirmToken === 'string' ? moved.confirmToken : undefined;
  try {
    // (d) copie de travail corrigee, puis (e) reprise de la machine.
    for (const item of changed.values()) await ctx.db.put(item);
    if (token) await ctx.sfn.taskSuccess(token);
  } catch (e) {
    // Etat deja change: on libere la machine par un echec (job `echec`, quota rendu, cours supprime par `fail`): ce handler ne supprime rien.
    if (token) await ctx.sfn.taskFailure(token, 'ConfirmFailed');
    throw e;
  }
  // La reprise est deja partie: un echec de suppression ne la bloque pas (le cycle de vie S3 efface la photo au plus tard sous 1 jour).
  try {
    await ctx.s3.deleteAll(scansPrefix(sid, jobId));
  } catch {
    log({ jobId, step: 'photo-suppression', status: 'error' });
  }
  return json(200, jobView(moved, ctx.now()));
}

export async function jobsCancel(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  if (job.state !== 'en_attente_envoi' && job.state !== 'a_confirmer') return fail('etat_invalide', 'Ce traitement ne peut plus etre annule');
  const won = await endWithoutDoc(ctx, sid, jobId, ['en_attente_envoi', 'a_confirmer'], 'rejete', MESSAGES.cancelled);
  if (!won) return fail('etat_invalide', 'Ce traitement ne peut plus etre annule');
  const after = await loadJob(ctx, sid, jobId);
  // Libere l'attente du workflow (envoi ou confirmation); un jeton deja termine est ignore par l'adaptateur Step Functions.
  for (const token of [after.confirmToken, after.uploadToken]) if (typeof token === 'string') await ctx.sfn.taskFailure(token, 'Cancelled');
  return json(200, jobView(after, ctx.now()));
}
