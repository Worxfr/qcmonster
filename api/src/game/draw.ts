// Q1 (docs/Q1-design.md section 6): tirage des questions d'un test, sur une ou plusieurs fiches de l'eleve. Lectures seulement.
// Une `Query` de questions par type et une `Query` `ATT#<docId>:` par fiche; jamais de cle ni de mot attendu dans ce qui sort.
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema } from '../../../shared/items.js';
import { DEFAULT_SIZE, SIZES, drawQuestions, type DrawCandidate, type Rng } from '../../../shared/pool.js';
import type { Deps } from '../lib/deps.js';
import { badRequest } from '../lib/http.js';
import type { Item } from '../lib/store.js';
import { DOC_XP_CAP, paidXp } from './rules.js';

export interface QuestionView {
  questionId: string;
  kind: 'qcm' | 'gap';
  prompt: string;
  choices?: string[];
  docId?: string;
  docTitle?: string;
}

/** `size` demande: 5, 10, 15 ou 20 (defaut 10); autre valeur: 400. */
export function parseSize(raw: string | number | undefined): number {
  if (raw === undefined) return DEFAULT_SIZE;
  const n = typeof raw === 'number' ? raw : /^\d{1,2}$/.test(raw) ? Number(raw) : NaN;
  if (!(SIZES as readonly number[]).includes(n)) throw badRequest();
  return n;
}

export interface DocDraw {
  docId: string;
  title: string;
  /** Questions lisibles de la fiche, tirables. */
  candidates: DrawCandidate[];
  views: Map<string, QuestionView>;
  xpRemaining: number;
}

/** Lit la banque d'une fiche de l'eleve: questions valides, derniere reponse de chacune, points deja payes. */
export async function loadDoc(deps: Deps, sid: string, fiche: Item): Promise<DocDraw> {
  const docId = fiche.SK.slice('DOC#'.length);
  const title = String(fiche.titre ?? '').slice(0, 200);
  const [qcms, gaps, att] = await Promise.all([deps.store.query(`DOC#${docId}`, 'QCM#'), deps.store.query(`DOC#${docId}`, 'GAP#'), deps.store.query(`STUDENT#${sid}`, `ATT#${docId}:`)]);
  const lastSeen = new Map<string, string>();
  for (const a of att) {
    const cut = a.SK.lastIndexOf('#');
    const qid = a.SK.slice('ATT#'.length, cut);
    const day = a.SK.slice(cut + 1);
    if (day > (lastSeen.get(qid) ?? '')) lastSeen.set(qid, day);
  }
  const candidates: DrawCandidate[] = [];
  const views = new Map<string, QuestionView>();
  const base = { docId, docTitle: title };
  for (const i of qcms) {
    const r = QcmItemSchema.safeParse(i);
    if (!r.success) continue;
    const d = r.data;
    candidates.push({ id: d.questionId, docId, claimId: d.claimId, kind: 'qcm', texte: d.enonce, reponse: d.choix[d.cle], ...(lastSeen.has(d.questionId) ? { lastSeen: lastSeen.get(d.questionId) } : {}) });
    views.set(d.questionId, { questionId: d.questionId, kind: 'qcm', prompt: d.enonce, choices: [...d.choix], ...base });
  }
  for (const i of gaps) {
    const r = GapItemSchema.safeParse(i);
    if (!r.success) continue;
    const d = r.data;
    candidates.push({ id: d.questionId, docId, claimId: d.claimId, kind: 'gap', texte: d.phrase, reponse: d.attendu, ...(lastSeen.has(d.questionId) ? { lastSeen: lastSeen.get(d.questionId) } : {}) });
    views.set(d.questionId, { questionId: d.questionId, kind: 'gap', prompt: d.phrase, ...base });
  }
  return { docId, title, candidates, views, xpRemaining: Math.max(0, DOC_XP_CAP - paidXp(att)) };
}

export interface Drawn {
  questions: QuestionView[];
  draw: string[];
  available: number;
  short: boolean;
}

/** Tire `size` questions sur les fiches lues. `withDocInfo` = false pour une seule fiche (comme avant: pas de titre sur chaque question). */
export function drawFrom(docs: DocDraw[], size: number, withDocInfo: boolean, rng: Rng = Math.random): Drawn {
  const r = drawQuestions(docs.flatMap((d) => d.candidates), size, rng);
  const views = new Map(docs.flatMap((d) => [...d.views]));
  const questions = r.ids.map((id) => {
    const { docId, docTitle, ...rest } = views.get(id) as QuestionView;
    return withDocInfo ? { ...rest, docId, docTitle } : rest;
  });
  return { questions, draw: r.ids, available: r.available, short: r.short };
}

/** Jour (Paris) de la derniere reponse par fiche, d'apres les passages `TEST#` (100 au plus, du plus recent): sert a choisir les fiches d'un grand dossier. */
export async function lastWorked(deps: Deps, sid: string): Promise<Map<string, string>> {
  const tests = (await deps.store.query(`STUDENT#${sid}`, 'TEST#')).sort((a, b) => b.SK.localeCompare(a.SK)).slice(0, 100);
  const out = new Map<string, string>();
  for (const t of tests) {
    const at = String(t.endedAt ?? t.startedAt ?? '');
    const ids = Array.isArray(t.docIds) ? (t.docIds as string[]) : [String(t.docId ?? '')];
    for (const d of ids) if (at && at > (out.get(d) ?? '')) out.set(d, at);
  }
  return out;
}

export const folderKey = (sid: string, folderId: string) => keys.folder(sid, folderId);
