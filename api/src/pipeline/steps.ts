// Etapes du workflow Step Functions (design-v2 4.1), partie 1: envoi, controle, transcription, confirmation, echec.
// Aucun texte de cours dans l'etat de la machine: seuls jobId, sid, docId et des compteurs circulent.
// Chaque etape est idempotente (une relance ne double ni le quota ni le cout). Suite: steps-doc.ts.
import { z } from 'zod';
import { keys } from '../../../shared/ddb/keys.js';
import { deleteCoursTree, deleteDocTree } from '../../../shared/delete-tree.js';
import { CONFIRM_TIMEOUT_S, cleanLabel, cleanTopic, MAX_SECTIONS, MAX_TOPIC, planSections, SUBJECTS } from '../../../shared/scans.js';
import { BEDROCK_MAX_IMAGE_BYTES } from '../../../shared/bedrock.js';
import { callModel, DAY_S, dayParis, iso, jobKey, mapLimit, ttlIn, type Ctx } from './ctx.js';
import { ALL_OPEN, endWithoutDoc, isTerminal, scansPrefix, transition } from './job.js';
import { returnQuotaOnce } from './quota-ops.js';
import { classifyPrompt, readPrompt, SYSTEM_JSON } from './prompts.js';
import { treeDbFrom, type Item } from './ports.js';
import { assemblePages, ModelOutputError, parseModelJson, type ReadPage, words } from './text.js';
import { addVerifyCostOnce } from './steps-cost.js';

export interface WfInput {
  jobId: string;
  sid: string;
  /** Rang de la section (Map de la machine d'etats, sections non ignorees dans l'ordre du plan). Absent: job sans plan (avant 1.3), une seule section. */
  index?: number;
}

export const MIN_WORDS = 40;
export const MAX_TRANSCRIPTIONS_PER_DAY = 10;
export const UPLOAD_TIMEOUT_S = 20 * 60;
const TRANSCRIBE_CONCURRENCY = 3;

export const MSG = {
  badFile: 'Fichier non reconnu : envoie une photo JPEG ou PNG',
  imageTooBig: 'Une photo est trop lourde (3,7 Mo au plus) : reprends-la en plus petit',
  notCourse: 'Ce document ne ressemble pas à un cours : rien ne sera lu',
  tooShort: 'Le texte est trop court pour faire une fiche',
  dailyLimit: 'Limite de 10 transcriptions par jour atteinte, reviens demain',
  noClaims: 'Aucune affirmation exploitable dans ce cours',
  expiredUpload: 'Aucune photo reçue, le traitement est annulé',
  expiredConfirm: `Pas de confirmation après ${CONFIRM_TIMEOUT_S / 3600} heures, la photo est supprimée`,
  budget: 'Le service est en pause pour le moment, réessaie plus tard',
  failed: 'Le traitement a échoué, rescanne ton cours',
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
  let tooBig = false;
  for (let n = 0; n < (job.expectedFiles as number); n++) {
    const h = await ctx.s3.head(`${prefix}${n}`, 16);
    const f = h ? imageFormat(h.bytes) : undefined;
    // Le type annonce doit correspondre au contenu (jpeg ou png), pas a l'en-tete HTTP.
    const expected = (job.contentTypes as string[] | undefined)?.[n] ?? job.contentType; // type de CETTE page (v1.3), a defaut celui du job
    if (!h || h.size < 1 || !f || `image/${f}` !== expected) valid = false;
    // L'envoi accepte 5 Mo, mais Bedrock (Converse) refuse une image de plus de 3,75 Mo: refus lisible ici plutot qu'un echec plus loin.
    else if (h.size > BEDROCK_MAX_IMAGE_BYTES) tooBig = true;
  }
  if (!valid || tooBig) {
    await endWithoutDoc(ctx, i.sid, i.jobId, ['verification_fichier'], 'rejete', valid ? MSG.imageTooBig : MSG.badFile);
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------- 3. transcription: le scan est lu comme UN document
const ReadOut = z.object({
  pages: z.array(z.object({ page: z.number().int().min(1).max(10), lines: z.array(z.string().max(2000)).max(400), suite: z.boolean().default(false) })).max(10),
});
const ClassifyOut = z.object({
  docType: z.enum(['cours', 'exercice', 'autre']),
  matiere: z.string().optional(),
  sujet: z.string().optional(),
  sections: z.array(z.object({ fromSentenceId: z.string(), matiere: z.string().optional(), sujet: z.string().optional(), titre: z.string().optional() })).max(50).default([]),
});
/** Jusqu'a 4 pages: un seul appel. Au-dela, fenetres de 3 pages nouvelles + la page precedente en contexte (4 images au plus par appel). */
export const SINGLE_CALL_PAGES = 4;
const WINDOW_NEW_PAGES = 3;
/** Texte envoye a l'appel de classement: 12 000 caracteres au plus (le debut et la fin d'un texte plus long, phrases reduites a un extrait). */
const CLASSIFY_CHARS = 12_000;

/** Fenetres de lecture: pages nouvelles (`pages`) et page de contexte eventuelle (`context`, non retranscrite). */
export function readWindows(total: number): { pages: number[]; context?: number }[] {
  const all = Array.from({ length: total }, (_, n) => n + 1);
  if (total <= SINGLE_CALL_PAGES) return [{ pages: all }];
  const out = [{ pages: all.slice(0, SINGLE_CALL_PAGES) }] as { pages: number[]; context?: number }[];
  for (let n = SINGLE_CALL_PAGES; n < total; n += WINDOW_NEW_PAGES) out.push({ pages: all.slice(n, n + WINDOW_NEW_PAGES), context: n });
  return out;
}

async function readWindow(ctx: Ctx, i: WfInput, w: { pages: number[]; context?: number }): Promise<ReadPage[]> {
  const prefix = scansPrefix(i.sid, i.jobId);
  const numbers = w.context ? [w.context, ...w.pages] : w.pages;
  const images = await Promise.all(numbers.map(async (p) => {
    const bytes = await ctx.s3.getBytes(`${prefix}${p - 1}`);
    return { format: imageFormat(bytes) ?? 'jpeg', bytes };
  }));
  const raw = await callModel(ctx, i, 'transcription', 'haiku', {
    system: SYSTEM_JSON,
    prompt: readPrompt(numbers.map((p) => ({ page: p, context: p === w.context }))),
    maxTokens: numbers.length > 1 ? 8000 : 4096,
    images,
  });
  const out = parseModelJson(raw, ReadOut);
  const byPage = new Map(out.pages.map((p) => [p.page, p]));
  // Toutes les pages demandees doivent etre rendues (la page de contexte est ignoree si le modele la transcrit quand meme).
  const got = w.pages.map((p) => byPage.get(p));
  if (got.some((g) => !g)) throw new ModelOutputError('sortie du modele: page manquante');
  return got as ReadPage[];
}

/** Lecture d'une fenetre; sortie illisible ou tronquee: un seul essai de repli, page par page (une image par appel). */
async function readWindowWithFallback(ctx: Ctx, i: WfInput, w: { pages: number[]; context?: number }): Promise<ReadPage[]> {
  try {
    return await readWindow(ctx, i, w);
  } catch (e) {
    if (!(e instanceof ModelOutputError) || (w.pages.length === 1 && !w.context)) throw e;
    const out: ReadPage[] = [];
    for (const p of w.pages) out.push(...(await readWindow(ctx, i, { pages: [p] })));
    return out;
  }
}

/** Texte envoye a l'appel de classement: complet jusqu'a 12 000 caracteres, sinon extraits courts par phrase puis debut et fin. */
export function classifyInput(lines: { id: string; text: string }[]): string {
  const full = lines.map((l) => `[${l.id}] ${l.text}`);
  if (full.join('\n').length <= CLASSIFY_CHARS) return full.join('\n');
  const short = lines.map((l) => `[${l.id}] ${l.text.split(/\s+/).slice(0, 12).join(' ')}`);
  if (short.join('\n').length <= CLASSIFY_CHARS) return short.join('\n');
  const half = Math.floor(CLASSIFY_CHARS / 2);
  const joined = short.join('\n');
  return `${joined.slice(0, half)}\n...\n${joined.slice(-half)}`;
}

const subjectOrUndef = (x: unknown) => ((SUBJECTS as readonly string[]).includes(x as string) ? (x as (typeof SUBJECTS)[number]) : undefined);

/** Decoupage propose valide par `planSections` (premiere phrase, ordre, matiere connue); sinon ignore (une seule section). */
export function suggestedSections(raw: z.infer<typeof ClassifyOut>['sections'], ids: string[], wordCounts: number[], pages: number) {
  const secs = raw.slice(0, MAX_SECTIONS).map((s) => ({ fromSentenceId: s.fromSentenceId, subject: subjectOrUndef(s.matiere), topic: cleanTopic(s.sujet), title: cleanLabel(s.titre, 200) }));
  if (secs.length < 2 || secs.some((s) => !s.subject)) return undefined;
  const plan = planSections(ids, secs.map((s) => ({ fromSentenceId: s.fromSentenceId })), { wordCounts, pages });
  if (!plan.ok) return undefined;
  return secs.map((s) => ({ fromSentenceId: s.fromSentenceId, subject: s.subject!, ...(s.topic ? { topic: s.topic } : {}), ...(s.title ? { title: s.title } : {}) }));
}

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

  const total = job.expectedFiles as number;
  // Les fenetres sont independantes (le recollage est fait par le code), 3 en parallele au plus; `readPages` (ensemble) apres chaque fenetre.
  const read = (
    await mapLimit(readWindows(total), TRANSCRIBE_CONCURRENCY, async (w) => {
      const pages = await readWindowWithFallback(ctx, i, w);
      await ctx.db.update(jobKey(i.sid, i.jobId), { addSet: { readPages: pages.map((p) => p.page) } });
      return pages;
    })
  ).flat();

  const texts = assemblePages(read);
  const lines = texts.flatMap((t) => t.sentences);
  const wordCounts = lines.map((s) => words(s.text).length);
  const wordCount = wordCounts.reduce((a, b) => a + b, 0);
  // Une seule decision pour tout le scan, par un appel de texte seul (jamais un vote entre pages).
  if (wordCount < MIN_WORDS) return reject(MSG.tooShort); // seuil sur l'ensemble du scan, sans appel de plus
  const verdict = parseModelJson(await callModel(ctx, i, 'classement', 'haiku', { system: SYSTEM_JSON, prompt: classifyPrompt(classifyInput(lines)), maxTokens: 1500 }), ClassifyOut);
  if (verdict.docType === 'autre') return reject(MSG.notCourse);

  const suggestedSubject = subjectOrUndef(verdict.matiere);
  const suggestedTopic = cleanTopic(verdict.sujet);
  const sections = suggestedSections((verdict.sections ?? []), lines.map((s) => s.id), wordCounts, total);
  // Le job porte le type et les suggestions AVANT le texte: la presence de `TEXT#1` marque la fin de l'etape (reprise).
  await ctx.db.update(jobKey(i.sid, i.jobId), { set: { docType: verdict.docType, wordCount, ...(suggestedSubject ? { suggestedSubject } : {}), ...(suggestedTopic ? { suggestedTopic: suggestedTopic.slice(0, MAX_TOPIC) } : {}), ...(sections ? { suggestedSections: sections } : {}) } });
  const ttl = ttlIn(ctx, 7 * DAY_S);
  for (const t of [...texts].reverse()) await ctx.db.put({ PK: `JOB#${i.jobId}`, SK: `TEXT#${t.page}`, page: t.page, sentences: t.sentences, ttl }); // `TEXT#1` en dernier
  return { ok: true };
}

// ---------------------------------------------------------------- 4. attente de la confirmation de l'eleve
export async function awaitConfirm(ctx: Ctx, i: WfInput & { token: string }): Promise<void> {
  // L'echeance est ecrite a la meme transition: une relance (job deja `a_confirmer`) ne la change pas.
  const job = await transition(ctx, i.sid, i.jobId, ['transcription'], 'a_confirmer', { confirmToken: i.token, awaitingSince: iso(ctx), confirmExpiresAt: new Date(ctx.now().getTime() + CONFIRM_TIMEOUT_S * 1000).toISOString() });
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
/**
 * Supprime tout ce qu'un scan non abouti a laisse: fiches (toutes les sections), elements orphelins de fiche, cours durable (en-tete, textes,
 * copie de travail `TEXT#`). Idempotent. Un echec supprime tout, sans cas particulier: le texte corrige est perdu avec la photo, l'eleve rescanne.
 */
export async function purgeScan(ctx: Ctx, sid: string, jobId: string, job: Item): Promise<void> {
  const ids = new Set<string>();
  if (typeof job.docId === 'string') ids.add(job.docId);
  for (const d of (job.docIds as string[] | undefined) ?? []) ids.add(d);
  for (const s of (job.sections as { docId?: string }[] | undefined) ?? []) if (s.docId) ids.add(s.docId);
  const tree = treeDbFrom(ctx.db);
  for (const docId of ids) {
    await deleteDocTree(tree, sid, docId); // la fiche et ses CLAIM, VERDICT, QCM, GAP
    const rest = await ctx.db.query(`DOC#${docId}`); // fiche jamais ecrite: restes de l'extraction (dont le brouillon)
    if (rest.length) await ctx.db.remove(rest.map((o) => ({ PK: o.PK, SK: o.SK })));
  }
  if (typeof job.coursId === 'string') await deleteCoursTree(tree, sid, job.coursId, { jobId });
}

/** Toute erreur d'etape: etat `echec`, quota rendu s'il est encore reserve, photos, fiches et cours supprimes. */
export async function failJob(ctx: Ctx, i: WfInput & { error?: { Error?: string } }): Promise<void> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job) return;
  if (isTerminal(job.state)) {
    // Fin deja decidee: on repare seulement un nettoyage interrompu (quota encore reserve, photos et cours restants).
    if (job.state !== 'termine') {
      // Trois nettoyages independants: une panne du rendu ne doit jamais empecher la suppression des donnees de l'eleve (photos, cours). Erreur relevee a la fin.
      const results = await Promise.allSettled([returnQuotaOnce(ctx, i.sid, i.jobId), ctx.s3.deleteAll(scansPrefix(i.sid, i.jobId)), purgeScan(ctx, i.sid, i.jobId, job)]);
      const failed = results.find((r) => r.status === 'rejected');
      if (failed) throw (failed as PromiseRejectedResult).reason;
    }
    return;
  }
  // Cout de L2b: `verify-run` le porte dans ses VERDICT# (premier verdict du lot). S'il a echoue apres des appels, on le recupere ici (une fois par fiche).
  if (job.quotaState === 'reserved') {
    const docIds = new Set<string>([...(typeof job.docId === 'string' ? [job.docId] : []), ...((job.docIds as string[] | undefined) ?? [])]);
    for (const docId of docIds) await addVerifyCostOnce(ctx, i.sid, i.jobId, docId);
  }
  const msg = i.error?.Error === 'CostBlockedError' ? MSG.budget : MSG.failed;
  // Meme regle: si le rendu des pages echoue (endWithoutDoc leve), le cours et les fiches sont quand meme supprimes, puis l'erreur est relevee (la relance rend).
  const ended = await endWithoutDoc(ctx, i.sid, i.jobId, ALL_OPEN, 'echec', msg).then(() => undefined, (e: unknown) => ({ e }));
  await purgeScan(ctx, i.sid, i.jobId, job);
  if (ended) throw ended.e;
}
