// Scans multi-pages, matiere/sujet, dossiers et statut (contrat 1.3, docs/data-model.md "FEAT-A").
// Logique pure partagee: aucun acces reseau ni base. Les handlers (lot back) lisent DynamoDB puis appellent `listScans`.
// Aucun texte de cours dans les erreurs ni les journaux: seuls des identifiants et des compteurs.
import type { components } from './contract/generated/types.js';

export const SUBJECTS = ['maths', 'physique', 'svt', 'histoire_geo', 'francais', 'autre'] as const;
export type Subject = (typeof SUBJECTS)[number];
export const MAX_PAGES_PER_SCAN = 10;
export const MAX_FOLDERS_PER_STUDENT = 50;
export const MAX_FOLDER_NAME = 60;
export const MAX_TOPIC = 80;
export const MAX_FOLDER_SCANS_PER_CALL = 50;
/** Sections (donc fiches) par scan: plafond propose, une section = un appel d'extraction, de verification et de generation. */
export const MAX_SECTIONS = 6;
/** Limites d'un COURS (F10): plusieurs scans (le cours d'origine et ses ajouts de pages). Un scan reste borne par MAX_PAGES_PER_SCAN et MAX_SECTIONS. */
export const MAX_COURS_PAGES = 30;
export const MAX_COURS_SECTIONS = 20;
/** Plafonds de la couche de mise en forme d'un cours (`COURS#<id>#B`): `CoursBlocksItemSchema`. */
export const MAX_COURS_FIGURES = 24;
export const MAX_COURS_BLOCKS = 1200;
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;
export const TOPIC_FACETS_MAX = 100;
/**
 * Delai de confirmation de l'eleve (photo gardee pendant ce temps): 12 h. Promesse a tenir: photo supprimee au plus tard 1 jour apres l'envoi
 * (docs/decisions.md D10) = 20 min d'attente d'envoi + lecture (5 min au plus) + 12 h << 24 h. Source unique, lue par la machine d'etats
 * (infra/lib/pipeline-stack.ts, lot I) et par l'etape `awaitConfirm` (lot B1). Ne pas depasser 20 h.
 */
export const CONFIRM_TIMEOUT_S = 12 * 3600;
/** « Expire bientot »: il reste 2 h ou moins avant l'expiration. */
export const EXPIRES_SOON_S = 2 * 3600;

export const STAGES = ['envoi', 'lecture', 'a_confirmer', 'fiche', 'verification', 'qcm', 'termine', 'echec'] as const;
export type Stage = (typeof STAGES)[number];

export type ScanSummary = components['schemas']['ScanSummary'];
export type ScanList = components['schemas']['ScanList'];

/** Comparaison sans casse, sans accents, espaces ecrases: sert aux noms de dossier et aux sujets. */
export function labelKey(s: string): string {
  return s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

/** Nettoie un libelle saisi ou propose par le modele: sans caracteres de controle ni chevrons, espaces ecrases. Vide => undefined. */
export function cleanLabel(raw: unknown, max: number): string | undefined {
  if (typeof raw !== 'string') return undefined;
  // Controles C0 et C1, marques bidirectionnelles et invisibles (\u200b-\u200f, \u202a-\u202e, \u2066-\u2069, \ufeff), chevrons.
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || undefined;
}
export const cleanTopic = (raw: unknown) => cleanLabel(raw, MAX_TOPIC);
export const cleanFolderName = (raw: unknown) => cleanLabel(raw, MAX_FOLDER_NAME);

const JOB_STATES = ['en_attente_envoi', 'verification_fichier', 'transcription', 'a_confirmer', 'verification', 'generation', 'termine', 'rejete', 'echec', 'expire'] as const;
const isJobState = (x: unknown): x is (typeof JOB_STATES)[number] => (JOB_STATES as readonly unknown[]).includes(x);
const isSubject = (x: unknown): x is Subject => (SUBJECTS as readonly string[]).includes(x as string);

/** Item DynamoDB lu par la liste (champs facultatifs: les anciens elements n'ont pas les champs 1.3). */
export type ScanItem = Record<string, unknown> & { PK: string; SK: string };

const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);
const num = (x: unknown): number | undefined => (typeof x === 'number' && Number.isFinite(x) ? x : undefined);

/** Etape affichee. `stage` ecrit par le traitement prime s'il est coherent avec l'etat; sinon on deduit de l'etat. */
export function stageOf(job: Record<string, unknown>): Stage {
  const state = job.state;
  const fine = job.stage;
  switch (state) {
    case 'en_attente_envoi':
      return 'envoi';
    case 'verification_fichier':
    case 'transcription':
      return 'lecture';
    case 'a_confirmer':
      return 'a_confirmer';
    case 'verification':
      return fine === 'fiche' || fine === 'verification' ? fine : 'verification';
    case 'generation':
      return 'qcm';
    case 'termine':
      return 'termine';
    default:
      return 'echec'; // rejete, echec, expire, et tout etat inconnu
  }
}
/** Un job annule est `rejete` avec « Annule par l'eleve » (accents et casse ignores). */
export const isCancelled = (job: Record<string, unknown>): boolean =>
  job.state === 'rejete' && typeof job.message === 'string' && job.message.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase().startsWith("annule par l'eleve");
export const isFinalStage = (s: Stage): boolean => s === 'termine' || s === 'echec';

const FAIL_MESSAGE = 'Le traitement a échoué, réessaie';

/** Statut detaille d'un job (Job.status et ScanSummary.status). */
export function statusOfJob(job: ScanItem, now: Date = new Date()): components['schemas']['ScanStatus'] {
  const total = Math.min(MAX_PAGES_PER_SCAN, Math.max(1, num(job.pages) ?? 1));
  const stage = stageOf(job);
  const uploaded = Array.isArray(job.uploadedKeys) ? job.uploadedKeys.length : 0;
  const read = Array.isArray(job.readPages) ? new Set(job.readPages).size : 0; // ensemble: une reprise de l'etape ne compte pas deux fois
  const done = stage === 'envoi' ? uploaded : stage === 'lecture' ? read : total;
  const createdAt = str(job.createdAt) ?? new Date(0).toISOString();
  return {
    stage,
    pagesDone: Math.max(0, Math.min(total, Math.trunc(done))),
    pagesTotal: total,
    startedAt: createdAt,
    ...(isFinalStage(stage) && str(job.finishedAt) ? { finishedAt: str(job.finishedAt)! } : {}),
    ...(stage === 'echec' ? { message: str(job.message) ?? FAIL_MESSAGE } : {}),
    ...expiryOf(job, stage, now),
  };
}

/** Echeance de la confirmation. Seulement a l'etape a_confirmer et si le job porte `confirmExpiresAt` (ecrit par `awaitConfirm`): un job d'avant 1.3 n'a pas d'echeance affichee (sa machine garde l'ancien delai de 30 min). */
function expiryOf(job: ScanItem, stage: Stage, now: Date): { expiresAt?: string; expiresSoon?: boolean } {
  const at = str(job.confirmExpiresAt);
  if (stage !== 'a_confirmer' || !at || Number.isNaN(Date.parse(at))) return {};
  return { expiresAt: at, expiresSoon: Date.parse(at) - now.getTime() <= EXPIRES_SOON_S * 1000 };
}

export type ScanQuery = {
  subject?: Subject | 'none';
  topic?: string;
  folderId?: string; // identifiant ou 'none'
  status?: 'en_cours' | 'a_confirmer' | 'termine' | 'echec';
  sort?: 'date' | 'subject' | 'topic' | 'status';
  order?: 'asc' | 'desc';
  limit?: number;
  cursor?: string;
};

export class UnknownFolderError extends Error {}
export class BadCursorError extends Error {}

export interface ListInput {
  /** Items `JOB#` lus (partition `STUDENT#<sid>`), tous eleves visibles confondus. */
  jobs: ScanItem[];
  /** Items `DOC#` lus (partition `STUDENT#<sid>`). */
  docs: ScanItem[];
  /** Dossiers des eleves visibles (jamais ceux d'un autre eleve: le handler ne lit que les partitions autorisees). */
  folders: { studentId: string; folderId: string }[];
  query: ScanQuery;
  /** Heure du serveur (calcul de `expiresSoon`); injectee pour les tests. */
  now?: Date;
}

const sidOf = (it: ScanItem): string => it.PK.replace(/^STUDENT#/, '');

type Entry = ScanSummary & { _topicKey?: string; _count?: number };

/** Fusionne jobs et fiches en scans, filtre, trie, pagine. Voir le contrat (GET /scans) pour les regles. */
export function listScans(input: ListInput): ScanList {
  const { query: q } = input;
  const knownFolders = new Set(input.folders.map((f) => `${f.studentId}/${f.folderId}`));
  const anyFolder = (id: string) => input.folders.some((f) => f.folderId === id);
  if (q.folderId && q.folderId !== 'none' && !anyFolder(q.folderId)) throw new UnknownFolderError();

  const docsById = new Map(input.docs.map((d) => [`${sidOf(d)}/${d.SK.slice('DOC#'.length)}`, d])); // sid/docId: plusieurs partitions (parent)
  const usedDocs = new Set<string>();
  const entries: Entry[] = [];
  const folderOf = (sid: string, id: unknown): string | undefined => (typeof id === 'string' && knownFolders.has(`${sid}/${id}`) ? id : undefined); // dossier supprime ou inconnu => hors dossier

  const docEntry = (sid: string, scanId: string, doc: ScanItem, status: components['schemas']['ScanStatus'], state: ScanSummary['state'], idx: number): Entry => {
    const docId = doc.SK.slice('DOC#'.length);
    const topic = cleanTopic(doc.sujet);
    const title = str(doc.titre);
    const folderId = folderOf(sid, doc.dossierId);
    const pages = status.pagesTotal;
    const coursId = str(doc.coursId);
    return {
      scanId,
      studentId: sid,
      state,
      docId,
      ...(title ? { title: title.slice(0, 200) } : {}),
      ...(isSubject(doc.matiere) ? { subject: doc.matiere } : {}),
      ...(topic ? { topic } : {}),
      ...(folderId ? { folderId } : {}),
      pages,
      createdAt: status.startedAt,
      status,
      ...(coursId ? { coursId } : {}),
      ...(num(doc.sectionIndex) !== undefined || num(doc.sectionCount) !== undefined ? { sectionIndex: Math.trunc(num(doc.sectionIndex) ?? idx) } : {}),
      _topicKey: topic ? labelKey(topic) : undefined,
      _count: num(doc.sectionCount),
    };
  };

  for (const job of input.jobs) {
    if (isCancelled(job)) continue; // annule par l'eleve: rien a montrer (ses pages sont rendues), plus de « Pas reussi » dans la liste
    const sid = sidOf(job);
    const jobId = job.SK.slice('JOB#'.length);
    // Un scan peut donner plusieurs fiches (`docIds`); un job d'avant 1.3 n'a que `docId`.
    const ids = Array.isArray(job.docIds) ? (job.docIds as unknown[]).filter((x): x is string => typeof x === 'string') : str(job.docId) ? [str(job.docId)!] : [];
    const docs = ids.map((id) => docsById.get(`${sid}/${id}`)).filter((d): d is ScanItem => d !== undefined);
    for (const d of docs) usedDocs.add(`${sid}/${d.SK.slice('DOC#'.length)}`);
    const status = statusOfJob(job, input.now);
    const state = isJobState(job.state) ? job.state : 'echec';
    if (status.stage === 'termine') {
      // Job termine dont toutes les fiches ont ete supprimees: on ne montre pas un fantome.
      docs.sort((a, b) => (num(a.sectionIndex) ?? 0) - (num(b.sectionIndex) ?? 0));
      docs.forEach((d, k) => entries.push(docEntry(sid, jobId, d, status, state, k)));
      continue;
    }
    const doc = docs[0];
    const subjectRaw = doc ? doc.matiere : (job.subjectChoice ?? job.suggestedSubject ?? job.draftSubject);
    const topic = cleanTopic(doc ? doc.sujet : (job.topicChoice ?? job.suggestedTopic));
    const title = str(doc ? doc.titre : job.draftTitle);
    const folderId = folderOf(sid, doc ? doc.dossierId : job.folderId);
    const coursId = str(job.coursId);
    entries.push({
      scanId: jobId,
      studentId: sid,
      state,
      ...(doc ? { docId: doc.SK.slice('DOC#'.length) } : {}),
      ...(title ? { title: title.slice(0, 200) } : {}),
      ...(isSubject(subjectRaw) ? { subject: subjectRaw } : {}),
      ...(topic ? { topic } : {}),
      ...(folderId ? { folderId } : {}),
      pages: status.pagesTotal,
      createdAt: status.startedAt,
      status,
      ...(coursId ? { coursId } : {}),
      _topicKey: topic ? labelKey(topic) : undefined,
    });
  }

  for (const [dkey, doc] of docsById) {
    if (usedDocs.has(dkey)) continue;
    const sid = sidOf(doc);
    const createdAt = str(doc.createdAt) ?? new Date(0).toISOString();
    const pages = Math.min(MAX_PAGES_PER_SCAN, Math.max(1, num(doc.pages) ?? num(doc.pagesConsommees) ?? 1));
    const status = { stage: 'termine' as const, pagesDone: pages, pagesTotal: pages, startedAt: createdAt, finishedAt: createdAt };
    entries.push(docEntry(sid, str(doc.jobId) ?? doc.SK.slice('DOC#'.length), doc, status, 'termine', 0));
  }

  // Regroupement: toutes les fiches d'un meme scan se connaissent (`docIds`, `sectionCount`), dans l'ordre des sections.
  const siblings = new Map<string, Entry[]>();
  for (const e of entries) if (e.docId) siblings.set(`${e.studentId}/${e.scanId}`, [...(siblings.get(`${e.studentId}/${e.scanId}`) ?? []), e]);
  for (const group of siblings.values()) {
    group.sort((a, b) => (a.sectionIndex ?? 0) - (b.sectionIndex ?? 0));
    for (const [k, e] of group.entries()) {
      const count = Math.max(group.length, e._count ?? 0);
      // Sans `coursId` ni `sectionCount` sur la fiche (cours supprime en gardant les fiches), le scan n'est plus un cours groupe.
      if ((e.coursId || e._count !== undefined) && (count > 1 || e.sectionIndex !== undefined)) {
        e.sectionIndex = e.sectionIndex ?? k;
        e.sectionCount = Math.min(MAX_SECTIONS, count);
        e.docIds = group.map((g) => g.docId!).slice(0, MAX_SECTIONS);
      }
    }
  }

  // Menus: sur tout ce qui est visible, sans les filtres.
  const subjectCount = new Map<Subject, number>();
  const topicCount = new Map<string, { topic: string; count: number }>();
  for (const e of entries) {
    if (e.subject) subjectCount.set(e.subject, (subjectCount.get(e.subject) ?? 0) + 1);
    if (e.topic && e._topicKey) {
      const t = topicCount.get(e._topicKey);
      if (t) t.count++;
      else topicCount.set(e._topicKey, { topic: e.topic, count: 1 });
    }
  }
  const facets = {
    subjects: SUBJECTS.filter((s) => subjectCount.has(s)).map((s) => ({ subject: s, count: subjectCount.get(s)! })),
    topics: [...topicCount.values()].sort((a, b) => b.count - a.count || a.topic.localeCompare(b.topic, 'fr')).slice(0, TOPIC_FACETS_MAX),
  };
  const inProgress = entries.filter((e) => !isFinalStage(e.status.stage)).length;
  const toReview = entries.filter((e) => e.status.stage === 'a_confirmer').length;

  const wantTopic = q.topic ? labelKey(q.topic) : undefined;
  const kept = entries.filter((e) => {
    if (q.subject === 'none' ? e.subject !== undefined : q.subject && e.subject !== q.subject) return false;
    if (wantTopic !== undefined && e._topicKey !== wantTopic) return false;
    if (q.folderId === 'none' ? e.folderId !== undefined : q.folderId && e.folderId !== q.folderId) return false;
    const st = e.status.stage;
    if (q.status === 'en_cours' && isFinalStage(st)) return false;
    if (q.status === 'a_confirmer' && st !== 'a_confirmer') return false;
    if (q.status === 'termine' && st !== 'termine') return false;
    if (q.status === 'echec' && st !== 'echec') return false;
    return true;
  });

  // Sens par defaut: croissant pour matiere et sujet (ordre alphabetique), decroissant pour date et statut.
  const dir = (q.order ?? (q.sort === 'subject' || q.sort === 'topic' ? 'asc' : 'desc')) === 'asc' ? 1 : -1;
  const dateDesc = (a: Entry, b: Entry) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.scanId !== b.scanId ? (a.scanId < b.scanId ? -1 : 1) : (a.sectionIndex ?? 0) - (b.sectionIndex ?? 0)); // fiches d'un meme scan cote a cote, dans l'ordre des sections
  const absentLast = (a: number | string | undefined, b: number | string | undefined, cmp: (x: never, y: never) => number): number =>
    a === undefined && b === undefined ? 0 : a === undefined ? 1 : b === undefined ? -1 : dir * cmp(a as never, b as never);
  const subjIdx = (e: Entry) => (e.subject ? SUBJECTS.indexOf(e.subject) : undefined);
  const byStr = (x: string, y: string) => (x < y ? -1 : x > y ? 1 : 0);
  const byNum = (x: number, y: number) => x - y;
  kept.sort((a, b) => {
    let c = 0;
    if (q.sort === 'date' || !q.sort) c = dir * byStr(a.createdAt, b.createdAt) || 0;
    else if (q.sort === 'status') c = dir * byNum(STAGES.indexOf(a.status.stage), STAGES.indexOf(b.status.stage));
    else if (q.sort === 'topic') c = absentLast(a._topicKey, b._topicKey, byStr);
    else c = absentLast(subjIdx(a), subjIdx(b), byNum) || absentLast(a._topicKey, b._topicKey, byStr);
    return c || dateDesc(a, b);
  });

  // shortcut: curseur = decalage dans la liste triee (tout est relu a chaque page). A remplacer par une cle de tri si un eleve depasse ~1000 fiches.
  const limit = Math.min(LIST_MAX_LIMIT, Math.max(1, Math.trunc(q.limit ?? LIST_DEFAULT_LIMIT)));
  let offset = 0;
  if (q.cursor !== undefined) {
    const raw = Buffer.from(q.cursor, 'base64url').toString('utf8');
    const m = /^o(\d{1,6})$/.exec(raw);
    if (!m || Buffer.from(raw).toString('base64url') !== q.cursor) throw new BadCursorError(); // refuse les caracteres en trop que base64url ignore
    offset = Number(m[1]);
  }
  const page = kept.slice(offset, offset + limit);
  const next = offset + limit < kept.length ? Buffer.from(`o${offset + limit}`).toString('base64url') : undefined;
  return {
    items: page.map(({ _topicKey, _count, ...e }) => (void _topicKey, void _count, e)),
    ...(next ? { nextCursor: next } : {}),
    inProgress,
    toReview,
    facets,
  };
}

/** Seuil de mots du texte retenu (decision du 2026-11-25, Q6): meme valeur que `MIN_WORDS` de la transcription; il s'applique au TOTAL des sections non ignorees, pas a chaque section. */
export const MIN_WORDS_RETAINED = 40;
export type SectionError = 'inconnu' | 'ordre' | 'debut' | 'trop' | 'aucune_fiche' | 'vide' | 'trop_court';
/** Au plus 2 sections par page du scan (et 6 en tout): 6 fiches pour 1 page depasseraient le plafond de cout du job. */
export const maxSectionsFor = (pages: number, room: number = MAX_COURS_SECTIONS): number => Math.min(MAX_SECTIONS, room, 2 * Math.max(1, Math.trunc(Number.isFinite(pages) ? pages : 1)));
export interface SectionInput {
  fromSentenceId: string;
  ignore?: boolean;
}
/**
 * Decoupage de la relecture: `ids` = identifiants de TOUTES les phrases du cours, dans l'ordre du texte (pages triees numeriquement,
 * phrases dans l'ordre; une phrase recollee compte une fois). Renvoie, pour chaque section, l'intervalle [start, end[ d'indices.
 * Regles (voir `POST /jobs/{jobId}/confirm`): au plus MAX_SECTIONS; la premiere commence a la premiere phrase; coupes connues,
 * strictement croissantes; au moins une section non ignoree; aucune section vide; si `wordCounts` (mots par phrase, meme ordre que `ids`)
 * est fourni, le total des sections non ignorees atteint `minWords` (40 par defaut); si `pages` est fourni, au plus `maxSectionsFor(pages)`
 * sections (2 par page, 6 au plus).
 */
export function planSections(ids: string[], sections: SectionInput[], opts: { wordCounts?: number[]; minWords?: number; pages?: number; room?: number } = {}): { ok: true; ranges: { start: number; end: number; ignore: boolean }[] } | { ok: false; error: SectionError } {
  if (sections.length === 0) return { ok: false, error: 'aucune_fiche' };
  if (sections.length > (opts.pages === undefined ? Math.min(MAX_SECTIONS, opts.room ?? MAX_COURS_SECTIONS) : maxSectionsFor(opts.pages, opts.room))) return { ok: false, error: 'trop' };
  const pos = new Map(ids.map((id, k) => [id, k]));
  const starts: number[] = [];
  for (const sec of sections) {
    const k = pos.get(sec.fromSentenceId);
    if (k === undefined) return { ok: false, error: 'inconnu' };
    starts.push(k);
  }
  if (starts[0] !== 0) return { ok: false, error: 'debut' };
  for (let n = 1; n < starts.length; n++) if (starts[n] <= starts[n - 1]) return { ok: false, error: 'ordre' };
  const ranges = starts.map((start, n) => ({ start, end: n + 1 < starts.length ? starts[n + 1] : ids.length, ignore: sections[n].ignore === true }));
  if (ranges.some((r) => r.end <= r.start)) return { ok: false, error: 'vide' }; // garde de defense: des coupes strictement croissantes ne donnent jamais une section vide
  if (ranges.every((r) => r.ignore)) return { ok: false, error: 'aucune_fiche' };
  // Q6: le total de mots des sections retenues (non ignorees) doit atteindre le seuil; une petite section isolee n'est pas refusee pour autant.
  if (opts.wordCounts) {
    if (opts.wordCounts.length !== ids.length) return { ok: false, error: 'inconnu' };
    const kept = ranges.filter((r) => !r.ignore).reduce((n, r) => n + opts.wordCounts!.slice(r.start, r.end).reduce((a, b) => a + b, 0), 0);
    if (kept < (opts.minWords ?? MIN_WORDS_RETAINED)) return { ok: false, error: 'trop_court' };
  }
  return { ok: true, ranges };
}

/**
 * Delai minimal de la machine d'etats pour qu'une execution tienne de l'envoi a la derniere fiche: attente d'envoi, lecture, attente de
 * confirmation (`CONFIRM_TIMEOUT_S`), puis `sections` x (extraction + verification + generation). Le lot I l'utilise avec ses delais de
 * taches (`TASK_TIMEOUT_S`) dans un test d'infra: `MACHINE_TIMEOUT >= machineTimeoutNeededS(...)` et au moins `MACHINE_TIMEOUT_MIN_S`.
 */
export function machineTimeoutNeededS(o: { uploadS: number; transcribeS: number; confirmS: number; sections: number; perSectionS: number }): number {
  return o.uploadS + o.transcribeS + o.confirmS + o.sections * o.perSectionS;
}
/** Plancher du delai de la machine (16 h): 12 h de confirmation, 20 min d'envoi, lecture et 6 sections, avec de la marge. */
export const MACHINE_TIMEOUT_MIN_S = 16 * 3600;

// --- M1 #90 (docs/M1-design.md 3 et 6, defauts P9 a P14): limites d'une modification de cours.
export const REVISION_MAX_CHANGES = 20;
export const REVISION_MAX_DOCS = 3;
export const REVISION_PER_COURS_PER_DAY = 1;
export const REVISION_PER_STUDENT_PER_DAY = 2;
/** Cout reserve a la creation (= plafond d'une modification, 0,10 EUR) puis regle au cout reel, en micro-euros. */
export const REVISION_RESERVE_MICROS = 100_000;
export const REVISION_MONTH_STUDENT_MICROS = 500_000;
export const REVISION_MONTH_FAMILY_MICROS = 1_500_000;
/** Capacite d'une fiche: numeros a deux chiffres, jamais reutilises. Une modification reserve ces numeros a la creation. */
export const REVISION_MAX_NN = 99;
export const REVISION_NEW_CLAIMS = 20;
export const REVISION_NEW_QUESTIONS = 10;
export const REVISION_BANK_MAX = 40;
export const REVISION_CLAIMS_RETIRED_MAX = 200;
/** Delai de la copie de travail et du job (secondes): 7 jours. */
export const REVISION_TTL_S = 7 * 86_400;
