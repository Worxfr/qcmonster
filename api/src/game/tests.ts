// Historique des tests de l'eleve (H1, docs/H1-design.md). Ecriture: `openPassage` (session-get) et `recordTest` (answers-post, dans la
// transaction existante). Lecture: `listTests` et `getTest` (handler tests-read), pour l'eleve seul: la partition vient du jeton.
// Un passage ne contient aucun texte de question ni de cours; la reponse donnee (`c`) n'est lue que par `getTest`.
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema, parseQuestionId } from '../../../shared/items.js';
import {
  MAX_ITEMS, MAX_TITLE, TEST_GAP_MS, addDay, decodeCursor, encodeCursor, isTestSk, isoSeconds, lineDone, newTestId, parisDayStartUtc, recount, schoolYearBounds,
  schoolYearOf, testIdOfSk, testIdStartedAt, toParentDetail, toSummary, upsertLine, validDay, type TestItem, type TestLine, type TestSummary,
} from '../../../shared/tests-history.js';
import type { Deps } from '../lib/deps.js';
import { badRequest, notFound, type StudentCtx } from '../lib/http.js';
import type { Item, Write } from '../lib/store.js';
import { activeStudent } from './access.js';
import type { Profile, State } from './state.js';

/** Pointeur de passage ouvert (PROFILE.currentTest), pose par session-get. */
export interface CurrentTest {
  testId: string;
  sk: string;
  docId: string;
  openedAt: number;
  total: number;
  mode: string;
}
/** PROFILE vu par H1: champs en plus de `Profile` (state.ts n'est pas modifie par ce lot; les champs inconnus sont conserves a l'ecriture). */
export type PlayProfile = Profile & { currentTest?: CurrentTest; anneesScolaires?: string[] };

const modeOf = (kinds: Iterable<'qcm' | 'gap'>): string => {
  const s = new Set(kinds);
  return s.size > 1 ? 'mixte' : s.has('gap') ? 'gap' : 'qcm';
};

/** Questions valides d'une fiche dans l'ordre de la session (QCM puis textes a trous): `rank` = position + 1. */
export async function docQuestions(deps: Deps, docId: string): Promise<{ questionId: string; kind: 'qcm' | 'gap' }[]> {
  const bySk = (a: { SK: string }, b: { SK: string }) => a.SK.localeCompare(b.SK);
  const out: { questionId: string; kind: 'qcm' | 'gap' }[] = [];
  for (const i of (await deps.store.query(`DOC#${docId}`, 'QCM#')).sort(bySk)) {
    const r = QcmItemSchema.safeParse(i);
    if (r.success) out.push({ questionId: r.data.questionId, kind: 'qcm' });
  }
  for (const i of (await deps.store.query(`DOC#${docId}`, 'GAP#')).sort(bySk)) {
    const r = GapItemSchema.safeParse(i);
    if (r.success) out.push({ questionId: r.data.questionId, kind: 'gap' });
  }
  return out;
}

/** session-get: ouvre un passage (pointeur seulement; aucune entree TEST# tant qu'aucune reponse n'est donnee). */
export function openPassage(st: State, docId: string, questions: { kind: 'qcm' | 'gap' }[]): void {
  const testId = newTestId(st.now);
  (st.profile as PlayProfile).currentTest = {
    testId,
    sk: keys.test(st.sid, isoSeconds(st.now), testId).SK,
    docId,
    openedAt: st.now,
    total: Math.min(MAX_ITEMS, Math.max(1, questions.length)),
    mode: modeOf(questions.map((q) => q.kind)),
  };
}

export interface AnswerFacts {
  docId: string;
  questionId: string;
  kind: 'qcm' | 'gap';
  fiche: Item;
  correct: boolean;
  choice: string;
  gained: number;
  /** Dernier evenement « question affichee » AVANT cette reponse (ms), ou undefined. */
  previousTick: number | undefined;
  /** Questions de la fiche dans l'ordre de la session (docQuestions). */
  order: { questionId: string; kind: 'qcm' | 'gap' }[];
}

/**
 * answers-post, dans `mutate` (donc relu et rejoue a chaque conflit): ecrit la ligne de la question dans le passage en cours, ou cree un
 * passage implicite (pas de session ouverte, autre fiche, ou plus de 3 h sans reponse). L'ecriture est conditionnelle a la version lue,
 * dans la meme transaction que PROFILE: deux reponses simultanees ne s'ecrasent pas, la perdante relit et recommence.
 */
export async function recordTest(deps: Deps, s: State, f: AnswerFacts): Promise<Write> {
  const p = s.profile as PlayProfile;
  const cur = p.currentTest;
  const open = cur !== undefined && cur.docId === f.docId && f.previousTick !== undefined && s.now - f.previousTick < TEST_GAP_MS;
  let pointer: CurrentTest;
  if (open) pointer = cur;
  else {
    const testId = newTestId(s.now);
    pointer = {
      testId,
      sk: keys.test(s.sid, isoSeconds(s.now), testId).SK,
      docId: f.docId,
      openedAt: s.now,
      total: Math.min(MAX_ITEMS, Math.max(1, f.order.length)),
      mode: modeOf(f.order.map((q) => q.kind)),
    };
    p.currentTest = pointer;
  }
  const key = { PK: `STUDENT#${s.sid}`, SK: pointer.sk };
  const existing = open ? await deps.store.get(key) : undefined;
  const startedAt = pointer.sk.slice('TEST#'.length, pointer.sk.indexOf('#', 5));
  const base: TestItem = existing
    ? (existing as unknown as TestItem)
    : {
        docId: f.docId,
        titre: String(f.fiche.titre ?? '').slice(0, MAX_TITLE),
        matiere: String(f.fiche.matiere ?? 'autre'),
        mode: pointer.mode,
        anneeScolaire: schoolYearOf(new Date(Date.parse(startedAt))),
        startedAt,
        total: pointer.total,
        answered: 0,
        correct: 0,
        firstTry: 0,
        xpGained: 0,
        items: [],
      };
  if (!existing) {
    // Premier passage de cette annee scolaire: la liste des annees se lit sur PROFILE, sans lire l'historique.
    const years = new Set(p.anneesScolaires ?? []);
    years.add(base.anneeScolaire);
    p.anneesScolaires = [...years].sort().reverse();
  }
  const rank = f.order.findIndex((q) => q.questionId === f.questionId) + 1;
  const items = upsertLine(base.items, { q: f.questionId, rank: rank > 0 ? rank : base.items.length + 1, k: f.kind, correct: f.correct, xp: f.gained, at: new Date(s.now).toISOString(), choice: f.choice });
  const item = { ...base, ...recount(items), items, endedAt: new Date(s.now).toISOString() };
  return { item: { ...key, ...item } as unknown as Item, when: existing ? (existing.v ?? 'any') : 'absent' };
}

// ---------------------------------------------------------------- lecture (eleve seul)

export interface TestQuery {
  limit?: string;
  cursor?: string;
  schoolYear?: string;
  docId?: string;
  from?: string;
  to?: string;
}
export interface TestPageView {
  items: TestSummary[];
  nextCursor?: string;
  schoolYears?: string[];
}

const SK_TIME = (sk: string): string => sk.slice('TEST#'.length, sk.indexOf('#', 5));
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const expired = (it: Item, nowMs: number): boolean => typeof it.ttl === 'number' && it.ttl * 1000 <= nowMs; // TTL DynamoDB: la suppression est differee, la lecture l'ignore

/**
 * GET /me/tests. Du plus recent au plus ancien, `limit` (1 a 50, defaut 20), curseur = cle de tri seulement (la partition vient du jeton).
 * Curseur, annee, dates ou limite mal formes: 400.
 * shortcut: la partition `TEST#` de l'eleve est lue en entier puis decoupee en memoire (le port Store n'a pas de requete bornee ni de page);
 * au plus ~1 100 passages par an. A remplacer par une requete SK between + ExclusiveStartKey au-dela de 6 000 passages (design section 4).
 */
export async function listTests(deps: Deps, ctx: StudentCtx, q: TestQuery): Promise<TestPageView> {
  await activeStudent(deps, ctx);
  return listTestsOf(deps, ctx.studentId, q);
}

/** Meme liste pour un eleve dont l'appelant a deja ete verifie (eleve du jeton, ou eleve de la famille du parent: family-progress.ts). */
export async function listTestsOf(deps: Deps, studentId: string, q: TestQuery): Promise<TestPageView> {
  const limit = q.limit === undefined ? 20 : /^\d{1,2}$/.test(q.limit) ? Number(q.limit) : NaN;
  if (!(limit >= 1 && limit <= 50)) throw badRequest();
  let after: string | undefined;
  if (q.cursor !== undefined) {
    after = decodeCursor(q.cursor);
    if (!after) throw badRequest();
  }
  if (q.docId !== undefined && !ID.test(q.docId)) throw badRequest();
  let lo = '';
  let hi = '\uffff';
  if (q.schoolYear !== undefined) {
    const b = schoolYearBounds(q.schoolYear);
    if (!b) throw badRequest();
    lo = b.from;
    hi = b.to;
  }
  if (q.from !== undefined) {
    const d = validDay(q.from);
    if (!d) throw badRequest();
    const t = parisDayStartUtc(d);
    if (t > lo) lo = t;
  }
  if (q.to !== undefined) {
    const d = validDay(q.to);
    if (!d) throw badRequest();
    const t = parisDayStartUtc(addDay(d, 1)); // `to` inclus: jusqu'au debut du jour suivant
    if (t < hi) hi = t;
  }
  const now = deps.now().getTime();
  const all = (await deps.store.query(`STUDENT#${studentId}`, 'TEST#'))
    .filter((i) => isTestSk(i.SK) && !expired(i, now))
    .sort((a, b) => b.SK.localeCompare(a.SK));
  const rows = all.filter((i) => {
    const t = SK_TIME(i.SK);
    return t >= lo && t < hi && (q.docId === undefined || i.docId === q.docId) && (after === undefined || i.SK < after);
  });
  const page = rows.slice(0, limit);
  const out: TestPageView = { items: page.map((i) => toSummary(i, testIdOfSk(i.SK))) };
  if (rows.length > limit) out.nextCursor = encodeCursor(page[page.length - 1].SK);
  if (q.cursor === undefined) {
    const profile = (await deps.store.get(keys.profile(studentId))) as (Item & { anneesScolaires?: unknown }) | undefined;
    // Jamais une annee sans passage (fiche supprimee depuis): on ne garde que les annees de PROFILE qui ont encore un passage lisible.
    const present = new Set(all.map((i) => String(i.anneeScolaire ?? '')));
    out.schoolYears = Array.isArray(profile?.anneesScolaires) ? profile.anneesScolaires.filter((y): y is string => typeof y === 'string' && present.has(y)).sort().reverse() : [];
  }
  return out;
}

/** Passage d'un eleve verifie par l'appelant, vu sans aucun texte (parent). Inconnu, expire ou mal forme: 404. */
export async function getTestStatus(deps: Deps, studentId: string, testId: string): Promise<ReturnType<typeof toParentDetail>> {
  const startedAt = testIdStartedAt(testId);
  if (!startedAt) throw notFound();
  const it = await deps.store.get(keys.test(studentId, startedAt, testId));
  if (!it || expired(it, deps.now().getTime())) throw notFound();
  return toParentDetail(it, testId);
}

export interface QuestionResultView {
  questionId: string;
  rank: number;
  kind: 'qcm' | 'gap';
  correct: boolean;
  attempts: number;
  firstTry: boolean;
  xpGained: number;
  answeredAt: string;
  choice: string;
  prompt?: string;
  choices?: string[];
  correctAnswer?: string;
}

/** GET /me/tests/{testId}: la cle exacte se refait depuis le temps du testId, dans la partition du jeton. Autre eleve, inconnu, expire ou mal forme: 404. */
export async function getTest(deps: Deps, ctx: StudentCtx, testId: string): Promise<TestSummary & { questions: QuestionResultView[] }> {
  await activeStudent(deps, ctx);
  const startedAt = testIdStartedAt(testId);
  if (!startedAt) throw notFound();
  const it = await deps.store.get(keys.test(ctx.studentId, startedAt, testId));
  if (!it || expired(it, deps.now().getTime())) throw notFound();
  const docId = String(it.docId ?? '');
  const lines = (Array.isArray(it.items) ? (it.items as TestLine[]) : []).slice().sort((a, b) => a.r - b.r);
  // Texte relu dans la fiche au moment de la lecture (rien du cours n'est copie dans l'historique). Une question absente ou illisible
  // (fiche regeneree, ligne d'une autre fiche) reste sans texte; toute erreur d'infrastructure remonte (500), jamais avalee.
  const questions: QuestionResultView[] = await Promise.all(
    lines.map(async (l) => {
      const v: QuestionResultView = { questionId: l.q, rank: l.r, kind: l.k, correct: l.ok, attempts: l.n, firstTry: l.f, xpGained: l.xp, answeredAt: l.at, choice: l.c };
      let qid: ReturnType<typeof parseQuestionId> | undefined;
      try {
        qid = parseQuestionId(l.q);
      } catch {
        return v; // questionId mal forme
      }
      if (qid.docId !== docId) return v;
      const raw = await deps.store.get(qid.kind === 'qcm' ? keys.qcm(docId, qid.nn) : keys.gap(docId, qid.nn));
      const parsed = qid.kind === 'qcm' ? QcmItemSchema.safeParse(raw) : GapItemSchema.safeParse(raw);
      if (!parsed.success) return v;
      if ('cle' in parsed.data) {
        v.prompt = parsed.data.enonce;
        v.choices = [...parsed.data.choix];
        if (lineDone(l)) v.correctAnswer = parsed.data.choix[parsed.data.cle];
      } else {
        v.prompt = parsed.data.phrase;
        if (lineDone(l)) v.correctAnswer = parsed.data.attendu;
      }
      return v;
    }),
  );
  return { ...toSummary(it, testId), questions };
}
