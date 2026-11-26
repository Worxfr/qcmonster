import { API_URL } from './env';
import { getToken, signOut } from './auth';
import type {
  AnswerResult, PracticeRequest, PracticeSession, Dashboard, Doc, DocSummary, Job, Leaderboard, Me, Progress, ReadResult, ScanCreateResponse, Session,
  Student, ActivationResponse, FamilyCreateRequest, InvitationCreated, StudentCreateRequest, StudentCreateResponse, Transcription, Sentence,
  ScanList, Cours, Folder, ConfirmSection, ScanQuery, Subject,
  TestPage, TestDetail, TestParentDetail, StudentProgressView, ExportArchive, TestQuery, ConfirmFigure, AddedSentence, ExportState, ReviseRequest, Revision,
  Exercice, ExerciceResume, ExerciceCreated, ExerciceHint, ExerciceSolution, CopieCreateResponse, CopieSubmitResponse, Copie,
} from './types';

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public resetDate?: string) {
    super(message);
  }
}

async function call<T>(method: string, path: string, body?: unknown, auth = true): Promise<T> {
  const token = auth ? await getToken() : null;
  const res = await fetch(API_URL + path, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body !== undefined ? { 'content-type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  if (res.status === 401 && auth) signOut();
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { code?: string; message?: string; resetDate?: string };
    throw new ApiError(res.status, e.code ?? 'erreur', e.message ?? `Erreur ${res.status}`, e.resetDate);
  }
  return res.status === 204 ? (undefined as T) : ((await res.json()) as T);
}

const e = encodeURIComponent;
function testQs(q: TestQuery): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
  const qs = p.toString();
  return qs ? `?${qs}` : '';
}
export const api = {
  me: () => call<Me>('GET', '/me'),
  progress: () => call<Progress>('GET', '/me/progress'),
  /** `coursId`: ajout de pages a la fin d'un cours existant (contrat 1.6). */
  createScan: (contentTypes: string[], folderId?: string, coursId?: string) =>
    call<ScanCreateResponse>('POST', '/scans', { pages: contentTypes.length, contentType: contentTypes[0], contentTypes, ...(folderId ? { folderId } : {}), ...(coursId ? { coursId } : {}) }),
  listScans: (q: ScanQuery) => {
    const p = new URLSearchParams();
    for (const [k, v] of Object.entries(q)) if (v !== undefined && v !== '') p.set(k, String(v));
    const qs = p.toString();
    return call<ScanList>('GET', `/scans${qs ? `?${qs}` : ''}`);
  },
  folders: (studentId?: string) => call<{ items: Folder[] }>('GET', `/folders${studentId ? `?studentId=${e(studentId)}` : ''}`),
  createFolder: (name: string) => call<Folder>('POST', '/folders', { name }),
  renameFolder: (id: string, name: string) => call<Folder>('PATCH', `/folders/${e(id)}`, { name }),
  deleteFolder: (id: string) => call<void>('DELETE', `/folders/${e(id)}`),
  addToFolder: (id: string, docIds: string[]) => call<void>('POST', `/folders/${e(id)}/scans`, { docIds }),
  removeFromFolder: (id: string, docId: string) => call<void>('DELETE', `/folders/${e(id)}/scans/${e(docId)}`),
  cours: (id: string) => call<Cours>('GET', `/cours/${e(id)}`),
  deleteCours: (id: string, fiches: 'garder' | 'supprimer') => call<void>('DELETE', `/cours/${e(id)}?fiches=${fiches}`),
  /** M1 #90: modifier un cours confirme. 200 = deja fait (aucune fiche touchee), 202 = en cours. */
  createRevision: (coursId: string, b: ReviseRequest) => call<Revision>('POST', `/cours/${e(coursId)}/revisions`, b),
  revision: (coursId: string, revisionId: string) => call<Revision>('GET', `/cours/${e(coursId)}/revisions/${e(revisionId)}`),
  cancelRevision: (coursId: string, revisionId: string) => call<void>('POST', `/cours/${e(coursId)}/revisions/${e(revisionId)}/cancel`),
  updateDoc: (id: string, b: { subject?: Subject; topic?: string | null }) => call<DocSummary>('PATCH', `/docs/${e(id)}`, b),
  job: (id: string) => call<Job>('GET', `/jobs/${e(id)}`),
  transcription: (id: string) => call<Transcription>('GET', `/jobs/${e(id)}/transcription`),
  confirm: (id: string, corrections: Sentence[], extra: { sections?: ConfirmSection[]; subject?: Subject; topic?: string; folderId?: string; figures?: ConfirmFigure[]; removed?: string[]; added?: AddedSentence[] } = {}) =>
    call<Job>('POST', `/jobs/${e(id)}/confirm`, { corrections, ...extra }),
  cancel: (id: string) => call<Job>('POST', `/jobs/${e(id)}/cancel`),
  deleteScan: (id: string) => call<void>('DELETE', `/scans/${e(id)}`),
  docs: () => call<{ items: DocSummary[] }>('GET', '/docs'),
  doc: (id: string) => call<Doc>('GET', `/docs/${e(id)}`),
  deleteDoc: (id: string) => call<void>('DELETE', `/docs/${e(id)}`),
  report: (id: string, comment: string, claimId?: string) =>
    call<{ reportId: string; status: string }>('POST', `/docs/${e(id)}/report`, { comment, ...(claimId ? { claimId } : {}) }),
  /** `size` (v1.7): 5, 10, 15 ou 20 (defaut 10). */
  session: (docId: string, size?: number) => call<Session>('GET', `/docs/${e(docId)}/session${size ? `?size=${size}` : ''}`),
  /** S'entrainer sur plusieurs fiches ou un dossier (v1.7). */
  practice: (b: PracticeRequest) => call<PracticeSession>('POST', '/practice/session', b),
  answer: (questionId: string, choice: string) => call<AnswerResult>('POST', '/answers', { questionId, choice }),
  createStudent: (b: StudentCreateRequest) => call<StudentCreateResponse>('POST', '/students', b),
  activationLink: (sid: string) => call<{ url: string; expiresAt: string }>('POST', `/students/${e(sid)}/activation-link`),
  updateStudent: (sid: string, b: { status?: 'actif' | 'suspendu'; pageQuota?: number; schoolLevel?: Student['schoolLevel']; displayName?: string }) => call<Student>('PATCH', `/students/${e(sid)}`, b),
  deleteStudent: (sid: string) => call<void>('DELETE', `/students/${e(sid)}`),
  dashboard: () => call<Dashboard>('GET', '/family/dashboard'),
  markRead: (docId: string) => call<ReadResult>('POST', `/docs/${e(docId)}/read`),
  createFamily: (b: FamilyCreateRequest) => call<Me>('POST', '/family', b),
  deleteFamily: () => call<void>('DELETE', '/family'),
  exportFamily: () => call<unknown>('GET', '/family/export'),
  /** Route publique (sans JWT). Le jeton et le mot de passe ne sont ni journalises ni repris dans une erreur. */
  /** 200 avec l'identifiant (contrat 1.8); une ancienne API repond 204 sans corps: `undefined` (l'ecran dit alors de demander l'identifiant au parent). */
  activate: (token: string, password: string, displayName?: string) =>
    call<ActivationResponse | undefined>('POST', '/activation', { token, password, ...(displayName ? { displayName } : {}) }, false),
  regenerateLoginId: (sid: string) => call<{ loginId: string }>('POST', `/students/${e(sid)}/login-id`),
  /** Administrateur seulement (403 sinon). Le code n'est renvoye qu'une fois. */
  createInvitation: () => call<InvitationCreated>('POST', '/admin/invitations'),
  /** Historique des tests (H1). Eleve: les siens. Parent: ceux d'un eleve de sa famille (resultats sans texte ni reponse). */
  myTests: (q: TestQuery = {}) => call<TestPage>('GET', `/me/tests${testQs(q)}`),
  myTest: (testId: string) => call<TestDetail>('GET', `/me/tests/${e(testId)}`),
  studentProgress: (sid: string) => call<StudentProgressView>('GET', `/students/${e(sid)}/progress`),
  studentTests: (sid: string, q: TestQuery = {}) => call<TestPage>('GET', `/students/${e(sid)}/tests${testQs(q)}`),
  studentTest: (sid: string, testId: string) => call<TestParentDetail>('GET', `/students/${e(sid)}/tests/${e(testId)}`),
  exportArchive: () => call<ExportArchive>('POST', '/family/export/archive'),
  /** Export de l'eleve (asynchrone, lot A): demande, puis lecture de l'etat jusqu'a `pret`. */
  startMyExport: () => call<{ exportId: string }>('POST', '/me/export/archive'),
  myExport: (exportId: string) => call<ExportState>('GET', `/me/export/archive/${e(exportId)}`),
  /** Re-acceptation de la politique en vigueur (parent). */
  acceptPolicy: (b: FamilyCreateRequest) => call<void>('POST', '/family/policy', b),
  leaderboard: () => call<Leaderboard>('GET', '/family/leaderboard'),
  /** Exercices (E1, eleve seul: 403 pour un parent). */
  exercices: (docId: string) => call<{ items: ExerciceResume[] }>('GET', `/docs/${e(docId)}/exercices`),
  createExercice: (docId: string) => call<ExerciceCreated>('POST', `/docs/${e(docId)}/exercices`),
  exercice: (exoId: string) => call<Exercice>('GET', `/exercices/${e(exoId)}`),
  exerciceHint: (exoId: string) => call<ExerciceHint>('POST', `/exercices/${e(exoId)}/indice`),
  exerciceSolution: (exoId: string) => call<ExerciceSolution>('POST', `/exercices/${e(exoId)}/solution`),
  createCopie: (exoId: string, pages: number, contentType: string) => call<CopieCreateResponse>('POST', `/exercices/${e(exoId)}/copies`, { pages, contentType }),
  /** Aucun corps: le serveur calcule lui-meme l'empreinte des pages. */
  submitCopie: (copieId: string) => call<CopieSubmitResponse>('POST', `/copies/${e(copieId)}/submit`),
  copie: (copieId: string) => call<Copie>('GET', `/copies/${e(copieId)}`),
  deleteCopie: (copieId: string) => call<void>('DELETE', `/copies/${e(copieId)}`),
};

/** Envoi direct vers S3 avec l'URL POST pre-signee: les champs d'abord, le fichier en dernier (exigence S3). */
export async function uploadScan(upload: { url: string; fields: Record<string, string> }, file: Blob): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(upload.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Envoi impossible (${res.status})`);
}

