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
export const LIST_DEFAULT_LIMIT = 50;
export const LIST_MAX_LIMIT = 100;
export const TOPIC_FACETS_MAX = 100;

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
  // eslint-disable-next-line no-control-regex
  const t = raw.replace(/[\u0000-\u001f\u007f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
  return t || undefined;
}
export const cleanTopic = (raw: unknown) => cleanLabel(raw, MAX_TOPIC);
export const cleanFolderName = (raw: unknown) => cleanLabel(raw, MAX_FOLDER_NAME);

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
export const isFinalStage = (s: Stage): boolean => s === 'termine' || s === 'echec';

const FAIL_MESSAGE = 'Le traitement a échoué, réessaie';

/** Statut detaille d'un job (Job.status et ScanSummary.status). */
export function statusOfJob(job: ScanItem): components['schemas']['ScanStatus'] {
  const total = Math.min(MAX_PAGES_PER_SCAN, Math.max(1, num(job.pages) ?? 1));
  const stage = stageOf(job);
  const uploaded = Array.isArray(job.uploadedKeys) ? job.uploadedKeys.length : 0;
  const done = stage === 'envoi' ? uploaded : stage === 'lecture' ? (num(job.pagesRead) ?? 0) : total;
  const createdAt = str(job.createdAt) ?? new Date(0).toISOString();
  return {
    stage,
    pagesDone: Math.max(0, Math.min(total, Math.trunc(done))),
    pagesTotal: total,
    startedAt: createdAt,
    ...(isFinalStage(stage) && str(job.finishedAt) ? { finishedAt: str(job.finishedAt)! } : {}),
    ...(stage === 'echec' ? { message: str(job.message) ?? FAIL_MESSAGE } : {}),
  };
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
}

const sidOf = (it: ScanItem): string => it.PK.replace(/^STUDENT#/, '');

type Entry = ScanSummary & { _topicKey?: string };

/** Fusionne jobs et fiches en scans, filtre, trie, pagine. Voir le contrat (GET /scans) pour les regles. */
export function listScans(input: ListInput): ScanList {
  const { query: q } = input;
  const knownFolders = new Set(input.folders.map((f) => `${f.studentId}/${f.folderId}`));
  const anyFolder = (id: string) => input.folders.some((f) => f.folderId === id);
  if (q.folderId && q.folderId !== 'none' && !anyFolder(q.folderId)) throw new UnknownFolderError();

  const docsById = new Map(input.docs.map((d) => [d.SK.slice('DOC#'.length), d]));
  const usedDocs = new Set<string>();
  const entries: Entry[] = [];
  const folderOf = (sid: string, id: unknown): string | undefined => (typeof id === 'string' && knownFolders.has(`${sid}/${id}`) ? id : undefined); // dossier supprime ou inconnu => hors dossier

  for (const job of input.jobs) {
    const sid = sidOf(job);
    const jobId = job.SK.slice('JOB#'.length);
    const docId = str(job.docId);
    const doc = docId ? docsById.get(docId) : undefined;
    const status = statusOfJob(job);
    // Job termine dont la fiche a ete supprimee: on ne montre pas un fantome.
    if (status.stage === 'termine' && !doc) continue;
    if (doc) usedDocs.add(docId!);
    const subjectRaw = doc ? doc.matiere : (job.subjectChoice ?? job.suggestedSubject ?? job.draftSubject);
    const topic = cleanTopic(doc ? doc.sujet : (job.topicChoice ?? job.suggestedTopic));
    const title = str(doc ? doc.titre : job.draftTitle);
    const folderId = folderOf(sid, doc ? doc.dossierId : job.folderId);
    entries.push({
      scanId: jobId,
      studentId: sid,
      ...(doc ? { docId } : {}),
      ...(title ? { title: title.slice(0, 200) } : {}),
      ...(isSubject(subjectRaw) ? { subject: subjectRaw } : {}),
      ...(topic ? { topic } : {}),
      ...(folderId ? { folderId } : {}),
      pages: status.pagesTotal,
      createdAt: status.startedAt,
      status,
      _topicKey: topic ? labelKey(topic) : undefined,
    });
  }

  for (const [docId, doc] of docsById) {
    if (usedDocs.has(docId)) continue;
    const sid = sidOf(doc);
    const createdAt = str(doc.createdAt) ?? new Date(0).toISOString();
    const pages = Math.min(MAX_PAGES_PER_SCAN, Math.max(1, num(doc.pages) ?? num(doc.pagesConsommees) ?? 1));
    const topic = cleanTopic(doc.sujet);
    const folderId = folderOf(sid, doc.dossierId);
    entries.push({
      scanId: str(doc.jobId) ?? docId,
      studentId: sid,
      docId,
      ...(str(doc.titre) ? { title: str(doc.titre)!.slice(0, 200) } : {}),
      ...(isSubject(doc.matiere) ? { subject: doc.matiere } : {}),
      ...(topic ? { topic } : {}),
      ...(folderId ? { folderId } : {}),
      pages,
      createdAt,
      status: { stage: 'termine', pagesDone: pages, pagesTotal: pages, startedAt: createdAt, finishedAt: createdAt },
      _topicKey: topic ? labelKey(topic) : undefined,
    });
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

  const dir = q.order === 'asc' ? 1 : -1;
  const dateDesc = (a: Entry, b: Entry) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : a.scanId < b.scanId ? -1 : 1);
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
    const m = /^o(\d{1,6})$/.exec(Buffer.from(q.cursor, 'base64url').toString('utf8'));
    if (!m) throw new BadCursorError();
    offset = Number(m[1]);
  }
  const page = kept.slice(offset, offset + limit);
  const next = offset + limit < kept.length ? Buffer.from(`o${offset + limit}`).toString('base64url') : undefined;
  return {
    items: page.map(({ _topicKey, ...e }) => (void _topicKey, e)),
    ...(next ? { nextCursor: next } : {}),
    inProgress,
    facets,
  };
}
