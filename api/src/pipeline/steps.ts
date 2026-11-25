// Etapes du workflow Step Functions (design-v2 4.1), partie 1: envoi, controle, transcription, confirmation, echec.
// Aucun texte de cours dans l'etat de la machine: seuls jobId, sid, docId et des compteurs circulent.
// Chaque etape est idempotente (une relance ne double ni le quota ni le cout). Suite: steps-doc.ts.
import { z } from 'zod';
import { keys } from '../../../shared/ddb/keys.js';
import { callModel, DAY_S, dayParis, iso, jobKey, mapLimit, ttlIn, type Ctx } from './ctx.js';
import { ALL_OPEN, endWithoutDoc, isTerminal, scansPrefix, transition } from './job.js';
import { releaseQuotaOnce } from './quota-ops.js';
import { SYSTEM_JSON, transcribePrompt } from './prompts.js';
import type { Item } from './ports.js';
import { parseModelJson, sentenceId, splitSentences, words } from './text.js';

export interface WfInput {
  jobId: string;
  sid: string;
}

export const MIN_WORDS = 40;
export const MAX_TRANSCRIPTIONS_PER_DAY = 10;
export const CONFIRM_TIMEOUT_S = 30 * 60;
export const UPLOAD_TIMEOUT_S = 20 * 60;
const TRANSCRIBE_CONCURRENCY = 3;

export const MSG = {
  badFile: 'Fichier non reconnu : envoie une photo JPEG ou PNG',
  notCourse: 'Ce document ne ressemble pas à un cours : rien ne sera lu',
  tooShort: 'Le texte est trop court pour faire une fiche',
  dailyLimit: 'Limite de 10 transcriptions par jour atteinte, reviens demain',
  noClaims: 'Aucune affirmation exploitable dans ce cours',
  expiredUpload: 'Aucune photo reçue, le traitement est annulé',
  expiredConfirm: 'Pas de confirmation après 30 minutes, la photo est supprimée',
  budget: 'Le service est en pause pour le moment, réessaie plus tard',
  failed: 'Le traitement a échoué, réessaie',
} as const;

// ---------------------------------------------------------------- 1. attente d'envoi
/** Evenement EventBridge « Object Created » du bucket des scans: compte les fichiers recus et debloque l'attente quand tout est la. */
export async function scanStart(ctx: Ctx, event: { detail?: { object?: { key?: string } } }): Promise<void> {
  const key = event.detail?.object?.key ? decodeURIComponent(event.detail.object.key.replace(/\+/g, ' ')) : '';
  const m = /^scans\/([A-Za-z0-9_-]{1,64})\/([A-Za-z0-9_-]{1,64})\/([0-9]{1,2})$/.exec(key);
  if (!m) return;
  const [, sid, jobId, idx] = m;
  const job = await ctx.db.get(jobKey(sid, jobId));
  if (!job || job.state !== 'en_attente_envoi' || Number(idx) >= (job.expectedFiles as number)) return;
  const upd = await ctx.db.update(jobKey(sid, jobId), { addSet: { uploadedKeys: [key] }, cond: { exists: true, eq: { state: 'en_attente_envoi' } } });
  await releaseUploadWait(ctx, upd);
}

async function releaseUploadWait(ctx: Ctx, job: Item | undefined): Promise<void> {
  if (!job || typeof job.uploadToken !== 'string') return;
  if (((job.uploadedKeys as string[] | undefined) ?? []).length >= (job.expectedFiles as number)) await ctx.sfn.taskSuccess(job.uploadToken);
}

/** Tache `waitForTaskToken`: enregistre le jeton, puis verifie si les fichiers sont deja arrives (course avec l'evenement S3). */
export async function awaitUpload(ctx: Ctx, i: WfInput & { token: string }): Promise<void> {
  const job = await ctx.db.update(jobKey(i.sid, i.jobId), { set: { uploadToken: i.token }, cond: { exists: true, eq: { state: 'en_attente_envoi' } } });
  if (!job) return ctx.sfn.taskFailure(i.token, 'Cancelled');
  await releaseUploadWait(ctx, job);
}

// ---------------------------------------------------------------- 2. controle du fichier (sur le contenu)
const MAGIC = {
  jpeg: [0xff, 0xd8, 0xff],
  png: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a],
} as const;
export function imageFormat(head: Uint8Array): 'jpeg' | 'png' | undefined {
  for (const f of ['jpeg', 'png'] as const) if (MAGIC[f].every((b, i) => head[i] === b)) return f;
  return undefined;
}

export async function scanCheck(ctx: Ctx, i: WfInput): Promise<{ ok: boolean }> {
  // Reprenable: une relance trouve le job deja en `verification_fichier` et refait le controle (sans effet de bord).
  const job = await transition(ctx, i.sid, i.jobId, ['en_attente_envoi', 'verification_fichier'], 'verification_fichier');
  if (!job) return { ok: false };
  const prefix = scansPrefix(i.sid, i.jobId);
  let valid = true;
  for (let n = 0; n < (job.expectedFiles as number); n++) {
    const h = await ctx.s3.head(`${prefix}${n}`, 16);
    const f = h ? imageFormat(h.bytes) : undefined;
    // Le type annonce doit correspondre au contenu (jpeg ou png), pas a l'en-tete HTTP.
    if (!h || h.size < 1 || !f || `image/${f}` !== job.contentType) valid = false;
  }
  if (!valid) {
    await endWithoutDoc(ctx, i.sid, i.jobId, ['verification_fichier'], 'rejete', MSG.badFile);
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 3. transcription
const TranscribeOut = z.object({ docType: z.enum(['cours', 'exercice', 'autre']), text: z.string().max(20_000) });

export async function transcribe(ctx: Ctx, i: WfInput): Promise<{ ok: boolean }> {
  // Reprenable (une relance ne double ni l'appel de modele ni le compteur du jour): etat deja `transcription` et texte ecrit = fait.
  const job = await transition(ctx, i.sid, i.jobId, ['verification_fichier', 'transcription'], 'transcription', { transcribeStartedAt: iso(ctx) });
  if (!job) return { ok: false };
  if (await ctx.db.get({ PK: `JOB#${i.jobId}`, SK: 'TEXT#1' })) return { ok: true };
  const reject = async (msg: string) => {
    await endWithoutDoc(ctx, i.sid, i.jobId, ['transcription'], 'rejete', msg);
    return { ok: false };
  };
  // Plafond de 10 transcriptions par eleve et par jour (une transcription refusee coute un peu de Haiku: elle compte). Comptee une fois par job.
  if (await ctx.db.update(jobKey(i.sid, i.jobId), { set: { transcrCounted: true }, cond: { exists: true, absent: ['transcrCounted'] } })) {
    const counter = await ctx.db.update(keys.transcriptions(i.sid, dayParis(ctx.now())), { add: { n: 1 }, set: { ttl: ttlIn(ctx, 2 * DAY_S) }, cond: { lt: { n: MAX_TRANSCRIPTIONS_PER_DAY } } });
    if (!counter) return reject(MSG.dailyLimit);
  }

  const prefix = scansPrefix(i.sid, i.jobId);
  const idx = Array.from({ length: job.expectedFiles as number }, (_, n) => n);
  const pages = await mapLimit(idx, TRANSCRIBE_CONCURRENCY, async (n) => {
    const bytes = await ctx.s3.getBytes(`${prefix}${n}`);
    const format = imageFormat(bytes) ?? 'jpeg';
    const raw = await callModel(ctx, i, 'transcription', 'haiku', { system: SYSTEM_JSON, prompt: transcribePrompt(n + 1), maxTokens: 4096, images: [{ format, bytes }] });
    return { page: n + 1, ...parseModelJson(raw, TranscribeOut) };
  });

  const docType = pages.some((p) => p.docType === 'cours') ? 'cours' : pages.some((p) => p.docType === 'exercice') ? 'exercice' : 'autre';
  const texts = pages.map((p) => ({ page: p.page, sentences: splitSentences(p.text).map((text, k) => ({ id: sentenceId(p.page, k + 1), text })) }));
  const wordCount = texts.reduce((n, t) => n + t.sentences.reduce((m, s) => m + words(s.text).length, 0), 0);
  if (docType === 'autre') return reject(MSG.notCourse);
  if (wordCount < MIN_WORDS) return reject(MSG.tooShort);

  const ttl = ttlIn(ctx, 7 * DAY_S);
  for (const t of texts) await ctx.db.put({ PK: `JOB#${i.jobId}`, SK: `TEXT#${t.page}`, page: t.page, sentences: t.sentences, ttl });
  await ctx.db.update(jobKey(i.sid, i.jobId), { set: { docType, wordCount } });
  return { ok: true };
}

// ---------------------------------------------------------------- 4. attente de la confirmation de l'eleve
export async function awaitConfirm(ctx: Ctx, i: WfInput & { token: string }): Promise<void> {
  const job = await transition(ctx, i.sid, i.jobId, ['transcription'], 'a_confirmer', { confirmToken: i.token, awaitingSince: iso(ctx) });
  if (job) return;
  // Relance apres succes: meme jeton, l'attente continue. Sinon (annule, expire...) on libere la machine.
  const cur = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!(cur?.state === 'a_confirmer' && cur.confirmToken === i.token)) await ctx.sfn.taskFailure(i.token, 'Cancelled');
}

/** Delai depasse (envoi ou confirmation): etat `expire`, photo supprimee, quota rendu. */
export async function expire(ctx: Ctx, i: WfInput & { phase: 'upload' | 'confirm' }): Promise<void> {
  await endWithoutDoc(ctx, i.sid, i.jobId, ['en_attente_envoi', 'a_confirmer'], 'expire', i.phase === 'upload' ? MSG.expiredUpload : MSG.expiredConfirm);
}

// ---------------------------------------------------------------- erreur: filet commun de la machine
/** Toute erreur d'etape: etat `echec`, quota rendu s'il est encore reserve, photos et affirmations orphelines supprimees. */
export async function failJob(ctx: Ctx, i: WfInput & { error?: { Error?: string } }): Promise<void> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job) return;
  if (isTerminal(job.state)) {
    // Fin deja decidee: on repare seulement un nettoyage interrompu (quota encore reserve, photos restantes).
    if (job.state !== 'termine') {
      await releaseQuotaOnce(ctx, i.sid, i.jobId);
      await ctx.s3.deleteAll(scansPrefix(i.sid, i.jobId));
    }
    return;
  }
  // Cout de L2b: `verify-run` le porte dans ses VERDICT# (premier verdict du lot). S'il a echoue apres des appels, on le recupere ici (une fois).
  if (typeof job.docId === 'string' && job.quotaState === 'reserved') {
    const micros = (await ctx.db.query(`DOC#${job.docId}`, 'VERDICT#')).reduce((n, v) => n + (typeof v.coutMicros === 'number' && Number.isFinite(v.coutMicros) ? v.coutMicros : 0), 0);
    if (micros > 0) await ctx.db.update(jobKey(i.sid, i.jobId), { add: { coutMicros: micros }, set: { verifyCostAdded: true }, cond: { exists: true, absent: ['verifyCostAdded'] } });
  }
  const msg = i.error?.Error === 'CostBlockedError' ? MSG.budget : MSG.failed;
  await endWithoutDoc(ctx, i.sid, i.jobId, ALL_OPEN, 'echec', msg);
  if (typeof job.docId === 'string' && !(await ctx.db.get(keys.doc(i.sid, job.docId)))) {
    const orphans = await ctx.db.query(`DOC#${job.docId}`);
    if (orphans.length) await ctx.db.remove(orphans.map((o) => ({ PK: o.PK, SK: o.SK })));
  }
}
