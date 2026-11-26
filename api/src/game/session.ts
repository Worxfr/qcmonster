// GET /docs/{docId}/session (une fiche) et POST /practice/session (plusieurs fiches ou un dossier): tirage de la banque, SANS cle ni mot attendu
// (liste blanche de champs, jamais de spread). Ouvrir une session remet `tick` et la serie a zero et pose le pointeur de passage (H1) avec le tirage.
import { MAX_PRACTICE_DOCS } from '../../../shared/pool.js';
import { cleanLabel } from '../../../shared/scans.js';
import { keys } from '../../../shared/ddb/keys.js';
import type { Deps } from '../lib/deps.js';
import { HttpError, badRequest, conflict, notFound, type StudentCtx } from '../lib/http.js';
import type { Item } from '../lib/store.js';
import { activeStudent } from './access.js';
import { drawFrom, loadDoc, lastWorked, parseSize, type DocDraw, type QuestionView } from './draw.js';
import { mutate, newSeries } from './state.js';
import { openPassage } from './tests.js';

export type { QuestionView } from './draw.js';

export interface Session {
  docId: string;
  questions: QuestionView[];
  available: number;
  short: boolean;
  xpRemaining: number;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;

async function open(deps: Deps, ctx: StudentCtx, o: Parameters<typeof openPassage>[1]): Promise<void> {
  // Les questions sont « affichees » maintenant: point de depart du temps minimum par reponse et de la serie de 10.
  await mutate(deps, ctx.familyId, ctx.studentId, (st) => {
    st.profile.tick = st.now;
    st.profile.series = newSeries(st.now);
    openPassage(st, o); // pointeur du passage de test (H1) et tirage (Q1); l'entree TEST# naitra a la premiere reponse
    return { result: null };
  }, () => conflict('Réessaie'), ['profile']);
}

export async function getSession(deps: Deps, ctx: StudentCtx, docId: string, sizeRaw?: string, rng?: () => number): Promise<Session> {
  const size = parseSize(sizeRaw);
  await activeStudent(deps, ctx);
  const fiche = await deps.store.get(keys.doc(ctx.studentId, docId));
  if (!fiche) throw notFound();
  const doc = await loadDoc(deps, ctx.studentId, fiche);
  const d = drawFrom([doc], size, false, rng);
  await open(deps, ctx, { docIds: [docId], scope: 'fiche', draw: d.questions });
  return { docId, questions: d.questions, available: d.available, short: d.short, xpRemaining: doc.xpRemaining };
}

export interface PracticeBody {
  docIds?: string[];
  folderId?: string;
  size?: number;
}
export interface PracticeSession {
  scope: 'fiches' | 'dossier';
  title: string;
  docIds: string[];
  questions: QuestionView[];
  available: number;
  short: boolean;
  xpRemaining: { docId: string; xpRemaining: number }[];
  skipped: { docId: string; title?: string; reason: 'sans_question' | 'introuvable' }[];
}

/** Les 10 fiches les moins recemment travaillees (jamais travaillees d'abord), pour un dossier de plus de 10 fiches. */
async function leastRecent(deps: Deps, sid: string, docs: Item[]): Promise<Item[]> {
  const last = await lastWorked(deps, sid);
  return docs
    .slice()
    .sort((a, b) => (last.get(a.SK.slice(4)) ?? '').localeCompare(last.get(b.SK.slice(4)) ?? '') || String(a.createdAt).localeCompare(String(b.createdAt)))
    .slice(0, MAX_PRACTICE_DOCS);
}

export async function practiceSession(deps: Deps, ctx: StudentCtx, body: PracticeBody, rng?: () => number): Promise<PracticeSession> {
  const hasDocs = body.docIds !== undefined;
  if (hasDocs === (body.folderId !== undefined)) throw badRequest(); // exactement un des deux
  const size = parseSize(body.size);
  if (hasDocs) {
    const ids = body.docIds as string[];
    if (!Array.isArray(ids) || ids.length < 1 || ids.length > MAX_PRACTICE_DOCS || new Set(ids).size !== ids.length || !ids.every((x) => typeof x === 'string' && ID.test(x))) throw badRequest();
  } else if (typeof body.folderId !== 'string' || !ID.test(body.folderId)) throw badRequest();
  await activeStudent(deps, ctx);

  const skipped: PracticeSession['skipped'] = [];
  let fiches: Item[] = [];
  let scope: 'fiches' | 'dossier' = 'fiches';
  let folderName = '';
  if (hasDocs) {
    for (const id of body.docIds as string[]) {
      const f = await deps.store.get(keys.doc(ctx.studentId, id)); // seulement SES fiches; un autre eleve: meme reponse qu'un identifiant inconnu
      if (f) fiches.push(f);
      else skipped.push({ docId: id, reason: 'introuvable' });
    }
  } else {
    scope = 'dossier';
    const folder = await deps.store.get(keys.folder(ctx.studentId, body.folderId as string));
    if (!folder) throw notFound();
    folderName = (cleanLabel(folder.nom, 60) ?? '').slice(0, 200);
    const all = (await deps.store.query(`STUDENT#${ctx.studentId}`, 'DOC#')).filter((d) => d.dossierId === body.folderId);
    fiches = all.length > MAX_PRACTICE_DOCS ? await leastRecent(deps, ctx.studentId, all) : all;
  }

  const docs: DocDraw[] = [];
  for (const f of fiches) {
    const d = await loadDoc(deps, ctx.studentId, f);
    if (d.candidates.length === 0) skipped.push({ docId: d.docId, title: d.title, reason: 'sans_question' });
    else docs.push(d);
  }
  if (docs.length === 0) throw new HttpError(409, 'aucune_question', 'Aucune question pour le moment');

  const d = drawFrom(docs, size, true, rng);
  const docIds = docs.map((x) => x.docId);
  const single = scope === 'fiches' && docs.length === 1;
  const title = scope === 'dossier' ? folderName : single ? docs[0].title : `${docs.length} fiches`;
  await open(deps, ctx, { docIds, scope: single ? 'fiche' : scope, titre: title, draw: d.questions });
  return { scope, title, docIds, questions: d.questions, available: d.available, short: d.short, xpRemaining: docs.map((x) => ({ docId: x.docId, xpRemaining: x.xpRemaining })), skipped };
}
