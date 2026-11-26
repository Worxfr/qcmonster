// Vue parent en lecture seule de l'historique des tests (H1-B, docs/H1-design.md sections 5 et 8): GET /students/{sid}/progress, /tests, /tests/{testId}.
// Regles: l'eleve doit etre de la famille DU JETON (lien FAMILY#<fid>/STUDENT#<sid> lu en base), sinon 404, identique a un eleve inconnu.
// Le parent ne voit jamais un texte de question ou de cours, un choix, la reponse donnee ni la bonne reponse: seuls des champs en liste blanche sortent.
import { keys } from '../../../shared/ddb/keys.js';
import { isCancelled, statusOfJob } from '../../../shared/scans.js';
import { isTestSk, testIdOfSk, toSummary, type TestSummary } from '../../../shared/tests-history.js';
import type { Deps } from '../lib/deps.js';
import { notFound, type ParentCtx } from '../lib/http.js';
import type { Item } from '../lib/store.js';
import { studentView, type StudentView } from './access.js';
import { expired, getTestStatus, listTestsOf, type TestPageView, type TestQuery } from './tests.js';
import { progressOf, readProfile, type Progress } from './state.js';
import { addDays, isoWeek, parisDate } from './time.js';

const WEEKS = 12;
const MAX_DOCS = 200;
const MAX_SCANS = 20;
const MAX_RECENT = 10;

/** Eleve de la famille du jeton, sinon 404 (pas 403: on ne revele pas l'existence d'un eleve d'une autre famille). */
async function familyStudent(deps: Deps, ctx: ParentCtx, sid: string): Promise<Item> {
  const s = await deps.store.get(keys.student(ctx.familyId, sid));
  if (!s) throw notFound();
  return s;
}

export async function listStudentTests(deps: Deps, ctx: ParentCtx, sid: string, q: TestQuery): Promise<TestPageView> {
  await familyStudent(deps, ctx, sid);
  return listTestsOf(deps, sid, q);
}

export async function getStudentTest(deps: Deps, ctx: ParentCtx, sid: string, testId: string) {
  await familyStudent(deps, ctx, sid);
  return getTestStatus(deps, sid, testId);
}

export interface DocProgress {
  docId: string;
  titre: string;
  matiere: string;
  sujet?: string;
  pages: number;
  createdAt: string;
  tests: number;
  bestScorePct?: number;
  lastScorePct?: number;
  lastTestAt?: string;
}
export interface StudentProgressView {
  student: StudentView;
  progress: Progress;
  docs: DocProgress[];
  scans: { scanId: string; stage: string; pages: number; createdAt: string }[];
  weeks: { week: string; tests: number; avgScorePct: number; activeDays: number }[];
  subjects: { matiere: string; tests: number; avgScorePct: number }[];
  schoolYears: string[];
  recentTests: TestSummary[];
}

const avg = (xs: number[]): number => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : 0);
const str = (x: unknown): string => (typeof x === 'string' ? x : '');

/**
 * GET /students/{sid}/progress. Une seule lecture de la partition `TEST#` de l'eleve, agregee en memoire (design section 4).
 * Fenetre des semaines et des matieres: 12 semaines ISO (Europe/Paris), la semaine en cours comprise.
 * shortcut: lecture complete de la partition `TEST#` (au plus ~1 100 passages par an); a remplacer par un agregat hebdomadaire
 * `WEEKSTAT#` au-dela de 6 000 passages ou 300 ms (design section 4).
 */
export async function getStudentProgress(deps: Deps, ctx: ParentCtx, sid: string): Promise<StudentProgressView> {
  const s = await familyStudent(deps, ctx, sid);
  const now = deps.now();
  const today = parisDate(now);
  const view = studentView(s);
  const [profile, rawTests, rawDocs, rawJobs] = await Promise.all([
    readProfile(deps, sid),
    deps.store.query(`STUDENT#${sid}`, 'TEST#'),
    deps.store.query(`STUDENT#${sid}`, 'DOC#'),
    deps.store.query(`STUDENT#${sid}`, 'JOB#'),
  ]);
  const progress = await progressOf(deps, ctx.familyId, sid, profile, view.pageQuota, today);
  const tests = rawTests
    .filter((i) => isTestSk(i.SK) && !expired(i, now.getTime()))
    .sort((a, b) => b.SK.localeCompare(a.SK))
    .map((i) => toSummary(i, testIdOfSk(i.SK)));

  const weekIds = Array.from({ length: WEEKS }, (_, k) => isoWeek(addDays(today, -7 * k)));
  const byWeek = new Map<string, TestSummary[]>(weekIds.map((w) => [w, []]));
  for (const t of tests) byWeek.get(isoWeek(parisDate(new Date(t.startedAt))))?.push(t);
  const weeks = weekIds.map((week) => {
    const ts = byWeek.get(week) ?? [];
    return { week, tests: ts.length, avgScorePct: avg(ts.map((t) => t.scorePct)), activeDays: Math.min(7, new Set(ts.map((t) => parisDate(new Date(t.startedAt)))).size) };
  });
  const inWindow = weekIds.flatMap((w) => byWeek.get(w) ?? []);
  const bySubject = new Map<string, number[]>();
  for (const t of inWindow) bySubject.set(t.matiere, [...(bySubject.get(t.matiere) ?? []), t.scorePct]);
  const subjects = [...bySubject].map(([matiere, xs]) => ({ matiere, tests: xs.length, avgScorePct: avg(xs) })).sort((a, b) => a.matiere.localeCompare(b.matiere));

  const docs: DocProgress[] = rawDocs
    .sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))
    .slice(0, MAX_DOCS)
    .map((d) => {
      const docId = d.SK.slice('DOC#'.length);
      const ts = tests.filter((t) => t.docId === docId); // plus recent d'abord
      return {
        docId,
        titre: str(d.titre).slice(0, 200),
        matiere: str(d.matiere) || 'autre',
        ...(str(d.sujet) ? { sujet: str(d.sujet) } : {}),
        pages: Math.max(1, Math.trunc(Number(d.pages ?? d.pagesConsommees) || 1)),
        createdAt: str(d.createdAt),
        tests: ts.length,
        ...(ts.length ? { bestScorePct: Math.max(...ts.map((t) => t.scorePct)), lastScorePct: ts[0].scorePct, lastTestAt: ts[0].endedAt ?? ts[0].startedAt } : {}),
      };
    });

  const scans = rawJobs
    .filter((j) => !isCancelled(j))
    .sort((a, b) => str(b.createdAt).localeCompare(str(a.createdAt)))
    .slice(0, MAX_SCANS)
    .map((j) => {
      const st = statusOfJob(j, now);
      return { scanId: j.SK.slice('JOB#'.length), stage: st.stage, pages: st.pagesTotal, createdAt: st.startedAt };
    });

  return {
    student: view,
    progress,
    docs,
    scans,
    weeks,
    subjects,
    schoolYears: [...new Set(tests.map((t) => t.schoolYear))].filter(Boolean).sort().reverse(),
    recentTests: tests.slice(0, MAX_RECENT),
  };
}
