// H1-B: vue parent. Famille du jeton seule (404 sinon), jamais de texte ni de reponse donnee, agregats, annees scolaires.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { newTestId, schoolYearOf } from '../../../shared/tests-history.js';
import { HttpError } from '../lib/http.js';
import { FID, SID, parentCtx, seed, testDeps, type TestEnv } from '../lib/testkit.js';
import { getStudentProgress, getStudentTest, listStudentTests } from './family-progress.js';
import { listTests } from './tests.js';

const SECRET = 'REPONSE-SECRETE-ELEVE';
const rejects = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
};
async function addTest(t: TestEnv, sid: string, iso: string, o: { docId?: string; correct?: number; total?: number; matiere?: string } = {}) {
  const ms = Date.parse(iso);
  const id = newTestId(ms);
  const startedAt = iso.replace('.000Z', 'Z');
  await t.store.commit([
    {
      item: {
        ...keys.test(sid, startedAt, id),
        docId: o.docId ?? 'doc1', titre: 'Titre', matiere: o.matiere ?? 'svt', mode: 'qcm', anneeScolaire: schoolYearOf(new Date(ms)), startedAt, endedAt: startedAt, total: o.total ?? 2, answered: 2, correct: o.correct ?? 1, firstTry: 1, xpGained: 5,
        items: [
          { q: 'doc1:qcm:02', r: 2, k: 'qcm', ok: false, n: 2, f: false, xp: 0, at: startedAt, c: SECRET },
          { q: 'doc1:qcm:01', r: 1, k: 'qcm', ok: true, n: 1, f: true, xp: 5, at: startedAt, c: SECRET },
        ],
      },
      when: 'any',
    },
  ]);
  return id;
}

describe('vue parent: acces', () => {
  it('eleve d\'une autre famille ou inconnu: 404 identique sur les 3 routes (aucune lecture de ses passages)', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    const other = await addTest(t, 'stu2', '2026-12-01T09:00:00.000Z', { docId: 'doc2' });
    const mine = await addTest(t, SID, '2026-12-01T09:00:00.000Z');
    await rejects(getStudentProgress(t.deps, parentCtx, 'stu2'), 404);
    await rejects(listStudentTests(t.deps, parentCtx, 'stu2', {}), 404);
    await rejects(getStudentTest(t.deps, parentCtx, 'stu2', other), 404);
    await rejects(getStudentProgress(t.deps, parentCtx, 'inconnu'), 404);
    await rejects(getStudentTest(t.deps, parentCtx, SID, other), 404); // passage d'un autre eleve: la cle est refaite dans la partition du eleve demande
    await expect(getStudentTest(t.deps, parentCtx, SID, mine)).resolves.toMatchObject({ testId: mine });
    // Le parent de l'autre famille lit le sien, pas le notre.
    await rejects(getStudentTest(t.deps, { ...parentCtx, familyId: 'fam2' }, SID, mine), 404);
  });
  it('testId mal forme ou inconnu: 404', async () => {
    const t = testDeps();
    await seed(t);
    await rejects(getStudentTest(t.deps, parentCtx, SID, 'x'), 404);
    await rejects(getStudentTest(t.deps, parentCtx, SID, newTestId(Date.now())), 404);
  });
  it('un eleve suspendu reste lisible par son parent', async () => {
    const t = testDeps();
    await seed(t, { status: 'suspendu' });
    await expect(getStudentProgress(t.deps, parentCtx, SID)).resolves.toMatchObject({ student: { status: 'suspendu' } });
  });
});

describe('vue parent: detail par question, sans texte', () => {
  it('juste ou faux par question, triees par rang; ni choix, ni reponse donnee, ni texte, ni bonne reponse', async () => {
    const t = testDeps();
    await seed(t, { nQcm: 2 });
    const id = await addTest(t, SID, '2026-12-01T09:00:00.000Z');
    const d = await getStudentTest(t.deps, parentCtx, SID, id);
    expect(d.questions.map((q) => [q.questionId, q.rank, q.correct, q.attempts])).toEqual([['doc1:qcm:01', 1, true, 1], ['doc1:qcm:02', 2, false, 2]]);
    const raw = JSON.stringify(d);
    expect(raw).not.toContain(SECRET);
    expect(raw).not.toMatch(/"(prompt|choices?|correctAnswer|c)":/);
    expect(raw).not.toContain('Question 1'); // texte de la fiche
    // L'eleve, lui, lit sa reponse: la separation tient a la route, pas aux donnees.
    const own = await listTests(t.deps, { sub: 'sub-stu1', studentId: SID, familyId: FID }, {});
    expect(own.items).toHaveLength(1);
  });
  it('liste: resumes seulement, regroupables par annee scolaire (filtre, schoolYears), curseur borne a l\'eleve', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await addTest(t, SID, '2026-12-01T09:00:00.000Z');
    await addTest(t, SID, '2027-09-02T09:00:00.000Z');
    await addTest(t, 'stu2', '2026-12-05T09:00:00.000Z', { docId: 'doc2' });
    await t.store.commit([{ item: { ...keys.profile(SID), anneesScolaires: ['2027-2028', '2026-2027'] }, when: 'any' }]);
    const all = await listStudentTests(t.deps, parentCtx, SID, {});
    expect(all.items).toHaveLength(2);
    expect(all.schoolYears).toEqual(['2027-2028', '2026-2027']);
    expect(JSON.stringify(all)).not.toContain(SECRET);
    expect(all.items[0]).not.toHaveProperty('questions');
    const y = await listStudentTests(t.deps, parentCtx, SID, { schoolYear: '2026-2027' });
    expect(y.items.map((i) => i.schoolYear)).toEqual(['2026-2027']);
    const p1 = await listStudentTests(t.deps, parentCtx, SID, { limit: '1' });
    expect(p1.nextCursor).toBeDefined();
    const p2 = await listStudentTests(t.deps, parentCtx, SID, { limit: '1', cursor: p1.nextCursor });
    expect(p2.items[0].testId).not.toBe(p1.items[0].testId);
    await rejects(listStudentTests(t.deps, parentCtx, SID, { cursor: 'zzz' }), 400);
  });
});

describe('vue parent: avancement', () => {
  it('fiches (meilleur et dernier score), semaines, matieres, scans, annees, derniers tests', async () => {
    const t = testDeps(); // 2026-12-01 (mardi, semaine 49)
    await seed(t, { nQcm: 2, pages: 3 });
    await t.store.commit([{ item: { ...keys.profile(SID), xp: 110 }, when: 'any' }]);
    await t.store.commit([{ item: { ...keys.job(SID, 'J1'), state: 'generation', pages: 2, createdAt: '2026-12-01T08:00:00.000Z' }, when: 'any' }]);
    await t.store.commit([{ item: { ...keys.job(SID, 'J2'), state: 'rejete', message: "Annulé par l'élève", pages: 1, createdAt: '2026-12-01T08:30:00.000Z' }, when: 'any' }]);
    await addTest(t, SID, '2026-11-30T09:00:00.000Z', { correct: 2 }); // lundi, 100 %
    await addTest(t, SID, '2026-12-01T09:00:00.000Z', { correct: 1 }); // mardi, 50 %
    await addTest(t, SID, '2026-12-01T09:30:00.000Z', { correct: 0, matiere: 'maths' }); // 0 %
    await addTest(t, SID, '2026-01-10T09:00:00.000Z', { correct: 2 }); // hors des 12 semaines
    const v = await getStudentProgress(t.deps, parentCtx, SID);
    expect(v.student).toMatchObject({ studentId: SID, status: 'actif' });
    expect(v.progress.xp).toBe(110);
    expect(v.docs).toHaveLength(1);
    expect(v.docs[0]).toMatchObject({ docId: 'doc1', pages: 3, tests: 4, bestScorePct: 100, lastScorePct: 0 });
    expect(v.scans).toEqual([{ scanId: 'J1', stage: 'qcm', pages: 2, createdAt: '2026-12-01T08:00:00.000Z' }]); // l'annule est absent
    expect(v.weeks).toHaveLength(12);
    expect(v.weeks[0]).toMatchObject({ week: '2026-W49', tests: 3, avgScorePct: 50, activeDays: 2 });
    expect(v.subjects).toEqual([{ matiere: 'maths', tests: 1, avgScorePct: 0 }, { matiere: 'svt', tests: 2, avgScorePct: 75 }]);
    expect(v.schoolYears).toEqual(['2026-2027', '2025-2026']);
    expect(v.recentTests.map((x) => x.startedAt)).toEqual(['2026-12-01T09:30:00Z', '2026-12-01T09:00:00Z', '2026-11-30T09:00:00Z', '2026-01-10T09:00:00Z']);
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });
  it('eleve sans passage: listes vides, 12 semaines a zero', async () => {
    const t = testDeps();
    await seed(t);
    const v = await getStudentProgress(t.deps, parentCtx, SID);
    expect(v.recentTests).toEqual([]);
    expect(v.weeks.every((w) => w.tests === 0 && w.avgScorePct === 0)).toBe(true);
    expect(v.docs[0]).toMatchObject({ tests: 0 });
    expect(v.docs[0]).not.toHaveProperty('bestScorePct');
  });
});
