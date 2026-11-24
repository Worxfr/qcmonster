import { API_URL } from './env';
import { getToken, signOut } from './auth';
import type {
  AnswerResult, Dashboard, Doc, DocSummary, Job, Leaderboard, Me, Progress, ReadResult, ScanCreateResponse, Session,
  Student, StudentCreateRequest, StudentCreateResponse, Transcription, Sentence,
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
export const api = {
  me: () => call<Me>('GET', '/me'),
  progress: () => call<Progress>('GET', '/me/progress'),
  createScan: (pages: number, contentType: string) => call<ScanCreateResponse>('POST', '/scans', { pages, contentType }),
  job: (id: string) => call<Job>('GET', `/jobs/${e(id)}`),
  transcription: (id: string) => call<Transcription>('GET', `/jobs/${e(id)}/transcription`),
  confirm: (id: string, corrections: Sentence[]) => call<Job>('POST', `/jobs/${e(id)}/confirm`, { corrections }),
  cancel: (id: string) => call<Job>('POST', `/jobs/${e(id)}/cancel`),
  docs: () => call<{ items: DocSummary[] }>('GET', '/docs'),
  doc: (id: string) => call<Doc>('GET', `/docs/${e(id)}`),
  deleteDoc: (id: string) => call<void>('DELETE', `/docs/${e(id)}`),
  report: (id: string, comment: string, claimId?: string) =>
    call<{ reportId: string; status: string }>('POST', `/docs/${e(id)}/report`, { comment, ...(claimId ? { claimId } : {}) }),
  session: (docId: string) => call<Session>('GET', `/docs/${e(docId)}/session`),
  answer: (questionId: string, choice: string) => call<AnswerResult>('POST', '/answers', { questionId, choice }),
  createStudent: (b: StudentCreateRequest) => call<StudentCreateResponse>('POST', '/students', b),
  activationLink: (sid: string) => call<{ url: string; expiresAt: string }>('POST', `/students/${e(sid)}/activation-link`),
  updateStudent: (sid: string, b: { status?: 'actif' | 'suspendu'; pageQuota?: number }) => call<Student>('PATCH', `/students/${e(sid)}`, b),
  deleteStudent: (sid: string) => call<void>('DELETE', `/students/${e(sid)}`),
  dashboard: () => call<Dashboard>('GET', '/family/dashboard'),
  markRead: (docId: string) => call<ReadResult>('POST', `/docs/${e(docId)}/read`),
  createFamily: () => call<Me>('POST', '/family'),
  /** Route publique (sans JWT). Le jeton et le mot de passe ne sont ni journalises ni repris dans une erreur. */
  activate: (token: string, password: string) => call<void>('POST', '/activation', { token, password }, false),
  leaderboard: () => call<Leaderboard>('GET', '/family/leaderboard'),
};

/** Envoi direct vers S3 avec l'URL POST pre-signee: les champs d'abord, le fichier en dernier (exigence S3). */
export async function uploadScan(upload: ScanCreateResponse['upload'], file: Blob): Promise<void> {
  const form = new FormData();
  for (const [k, v] of Object.entries(upload.fields)) form.append(k, v);
  form.append('file', file);
  const res = await fetch(upload.url, { method: 'POST', body: form });
  if (!res.ok) throw new Error(`Envoi impossible (${res.status})`);
}
