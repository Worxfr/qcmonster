import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { encodeCursor, newTestId, testIdStartedAt } from '../../../shared/tests-history.js';
import { deleteDocTree } from '../../../shared/delete-tree.js';
import { HttpError } from '../lib/http.js';
import { storeTreeDb } from '../lib/store.js';
import { FID, SID, qid, seed, testDeps, type TestEnv } from '../lib/testkit.js';
import { postAnswer } from './answers.js';
import { getSession } from './session.js';
import { getTest, listTests, type PlayProfile } from './tests.js';

type Ctx = Parameters<typeof postAnswer>[1];
const answer = (t: TestEnv, ctx: Ctx, q: string, choice: string) => postAnswer(t.deps, ctx, { questionId: q, choice });
const rejects = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
};
const tests = async (t: TestEnv, sid = SID) => (await t.store.query(`STUDENT#${sid}`, 'TEST#')).sort((a, b) => a.SK.localeCompare(b.SK));
const prof = async (t: TestEnv) => (await t.store.get(keys.profile(SID))) as unknown as PlayProfile;
const good = 'B'; // bonne reponse du QCM du jeu d'essai

/** Un passage complet: ouvre la session puis repond aux questions 1..n (bonnes). */
async function pass(t: TestEnv, ctx: Ctx, docId: string, n: number, choice = good) {
  await getSession(t.deps, ctx, docId);
  for (let i = 1; i <= n; i++) {
    t.clk.advance(2000);
    await answer(t, ctx, qid(docId, 'qcm', i), choice);
  }
}

describe('ecriture: passage de test', () => {
  it('session-get pose le pointeur, sans creer d\'entree TEST#', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3, nGap: 1 });
    await getSession(t.deps, ctx, 'doc1', '20');
    expect(await tests(t)).toHaveLength(0);
    const p = await prof(t);
    expect(p.currentTest).toMatchObject({ docId: 'doc1', total: 4, mode: 'mixte', openedAt: t.clk.t });
    expect(p.currentTest?.sk).toMatch(/^TEST#2026-12-01T09:00:00Z#[0-9A-Z]{26}$/);
  });

  it('les reponses d\'une session alimentent UN passage: lignes, rang, compteurs, annee scolaire', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 1), good);
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 2), 'A'); // faux, 1er essai
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 2), good); // juste au 2e
    const [it, ...rest] = await tests(t);
    expect(rest).toHaveLength(0);
    expect(it).toMatchObject({ docId: 'doc1', titre: 'Titre', matiere: 'svt', mode: 'qcm', anneeScolaire: '2026-2027', startedAt: '2026-12-01T09:00:00Z', total: 3, answered: 2, correct: 2, firstTry: 1, xpGained: 7 });
    expect(it.items).toMatchObject([{ q: 'doc1:qcm:01', r: 1, ok: true, n: 1, f: true, xp: 5, c: 'B' }, { q: 'doc1:qcm:02', r: 2, ok: true, n: 2, f: false, xp: 2, c: 'B' }]);
    expect((await prof(t)).anneesScolaires).toEqual(['2026-2027']);
    expect(it.ttl).toBeUndefined(); // conserve jusqu'a suppression
  });

  it('une reponse SANS session ouverte cree un passage (implicite), puis les suivantes le continuent', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 4, nGap: 2 });
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 1), good);
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'gap', 1), 'energie');
    const all = await tests(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ total: 6, mode: 'mixte', answered: 2 });
    expect(all[0].items).toMatchObject([{ r: 1, k: 'qcm' }, { r: 5, k: 'gap', ok: true }]);
  });

  it('autre fiche, ou plus de 3 h sans reponse: nouveau passage; une session rouverte aussi', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    await seed(t, { docId: 'doc2', nQcm: 2 });
    await pass(t, ctx, 'doc1', 1);
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc2', 'qcm', 1), good); // autre fiche, session de doc1 encore ouverte
    expect(await tests(t)).toHaveLength(2);
    t.clk.advance(3 * 3_600_000 + 1000);
    await answer(t, ctx, qid('doc2', 'qcm', 2), good); // 3 h plus tard
    expect(await tests(t)).toHaveLength(3);
    await pass(t, ctx, 'doc1', 1); // rouvre la fiche
    expect(await tests(t)).toHaveLength(4);
  });

  it('sans reponse, ouvrir une fiche ne laisse rien', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await getSession(t.deps, ctx, 'doc1', '20');
    await getSession(t.deps, ctx, 'doc1', '20');
    expect(await tests(t)).toHaveLength(0);
  });

  it('deux reponses simultanees ne perdent aucune ligne (ecriture conditionnelle, relecture au conflit)', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    await getSession(t.deps, ctx, 'doc1', '20');
    // Horloge qui avance de 1,1 s a chaque lecture: la perdante, relancee apres le conflit, n'est plus « trop rapide ».
    t.deps.now = () => new Date((t.clk.t += 1100));
    await Promise.all([answer(t, ctx, qid('doc1', 'qcm', 1), good), answer(t, ctx, qid('doc1', 'qcm', 2), good)]);
    const all = await tests(t);
    expect(all).toHaveLength(1);
    expect((all[0].items as { q: string }[]).map((l) => l.q).sort()).toEqual(['doc1:qcm:01', 'doc1:qcm:02']);
    expect(all[0]).toMatchObject({ answered: 2, correct: 2 });
  });

  it('une transaction perdue (conflit) n\'ecrit ni la ligne ni la tentative', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    t.store.failNextCommits(3);
    await rejects(answer(t, ctx, qid('doc1', 'qcm', 1), good), 409);
    expect(await tests(t)).toHaveLength(0);
  });
});

describe('lecture: GET /me/tests', () => {
  async function history() {
    const t = testDeps();
    const s = await seed(t, { nQcm: 3 });
    await seed(t, { docId: 'doc2', nQcm: 2 });
    for (let i = 0; i < 3; i++) {
      await pass(t, s.ctx, 'doc1', 2);
      t.clk.advance(4 * 3_600_000);
    }
    await pass(t, s.ctx, 'doc2', 1);
    return { t, ctx: s.ctx };
  }

  it('du plus recent au plus ancien, pagination par curseur sans doublon ni trou, annees sur la 1re page', async () => {
    const { t, ctx } = await history();
    const p1 = await listTests(t.deps, ctx, { limit: '3' });
    expect(p1.items).toHaveLength(3);
    expect(p1.items[0]).toMatchObject({ docId: 'doc2', schoolYear: '2026-2027', status: 'incomplet', scorePct: 50 }); // 1 reponse sur 2 questions
    expect(p1.schoolYears).toEqual(['2026-2027']);
    expect(p1.nextCursor).toBeDefined();
    const p2 = await listTests(t.deps, ctx, { limit: '3', cursor: p1.nextCursor });
    expect(p2.items).toHaveLength(1);
    expect(p2.nextCursor).toBeUndefined();
    expect(p2.schoolYears).toBeUndefined();
    const ids = [...p1.items, ...p2.items].map((i) => i.testId);
    expect(new Set(ids).size).toBe(4);
    expect([...p1.items, ...p2.items].map((i) => i.startedAt)).toEqual([...ids].map((id) => testIdStartedAt(id)));
  });

  it('filtre par fiche, par annee scolaire et par dates (heure de Paris)', async () => {
    const { t, ctx } = await history();
    expect((await listTests(t.deps, ctx, { docId: 'doc1' })).items).toHaveLength(3);
    expect((await listTests(t.deps, ctx, { schoolYear: '2026-2027' })).items).toHaveLength(4);
    expect((await listTests(t.deps, ctx, { schoolYear: '2025-2026' })).items).toHaveLength(0);
    const day1 = (await listTests(t.deps, ctx, { from: '2026-12-01', to: '2026-12-01' })).items.length;
    const after = (await listTests(t.deps, ctx, { from: '2026-12-02' })).items.length;
    expect(day1).toBeGreaterThan(0);
    expect(day1 + after).toBe(4); // les passages se repartissent sans trou ni doublon autour de minuit (Paris)
    expect((await listTests(t.deps, ctx, { to: '2026-11-30' })).items).toHaveLength(0);
  });

  it('annee scolaire: un passage du 31 aout 23:30 (Paris) est dans l\'annee qui finit, pas dans la suivante', async () => {
    const t = testDeps({ iso: '2027-08-31T23:30:00+02:00' });
    const { ctx } = await seed(t, { nQcm: 1 });
    await pass(t, ctx, 'doc1', 1);
    t.clk.set('2027-09-01T00:30:00+02:00');
    await pass(t, ctx, 'doc1', 1);
    expect((await listTests(t.deps, ctx, { schoolYear: '2026-2027' })).items).toHaveLength(1);
    expect((await listTests(t.deps, ctx, { schoolYear: '2027-2028' })).items).toHaveLength(1);
    expect((await listTests(t.deps, ctx, {})).schoolYears).toEqual(['2027-2028', '2026-2027']);
  });

  it('curseur trafique: 400, ou liste vide; jamais les passages d\'un autre eleve', async () => {
    const { t, ctx } = await history();
    const other = await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'docx', nQcm: 1 });
    await pass(t, other.ctx, 'docx', 1);
    const theirs = (await tests(t, 'stu2'))[0];
    const mine = (await listTests(t.deps, ctx, {})).items.map((i) => i.testId);
    // SK d'un autre eleve (forme valide): la partition vient du jeton, donc seulement les passages de l'eleve du jeton.
    const r = await listTests(t.deps, ctx, { cursor: encodeCursor(theirs.SK) });
    expect(r.items.every((i) => mine.includes(i.testId))).toBe(true);
    expect(JSON.stringify(r)).not.toContain('docx');
    for (const bad of [encodeCursor('STUDENT#stu2'), encodeCursor('PROFILE'), encodeCursor(`TEST#../${theirs.PK}`), encodeCursor(`${theirs.PK}|${theirs.SK}`), '%%%', 'A'.repeat(600)]) await rejects(listTests(t.deps, ctx, { cursor: bad }), 400);
  });

  it('parametres mal formes: 400', async () => {
    const { t, ctx } = await history();
    for (const q of [{ limit: '0' }, { limit: '51' }, { limit: 'x' }, { schoolYear: '2026-2028' }, { from: '2026-02-30' }, { to: 'demain' }, { docId: '../x' }]) await rejects(listTests(t.deps, ctx, q), 400);
  });

  it('une entree expiree (ttl passe) n\'est jamais renvoyee, ni en liste ni en detail', async () => {
    const { t, ctx } = await history();
    const all = await tests(t);
    const target = all[0];
    await t.store.commit([{ item: { ...target, ttl: Math.floor(t.clk.t / 1000) - 10 }, when: 'any' }]);
    const ids = (await listTests(t.deps, ctx, {})).items.map((i) => i.testId);
    expect(ids).toHaveLength(3);
    expect(ids).not.toContain(target.SK.slice(target.SK.lastIndexOf('#') + 1));
    await rejects(getTest(t.deps, ctx, target.SK.slice(target.SK.lastIndexOf('#') + 1)), 404);
  });

  it('le resume ne contient ni texte de question ni reponse donnee', async () => {
    const { t, ctx } = await history();
    const text = JSON.stringify(await listTests(t.deps, ctx, {}));
    for (const banned of ['prompt', '"choice"', 'choices', 'correctAnswer', '"items":[{"q"', 'Question 1']) expect(text).not.toContain(banned);
  });

  it('un eleve suspendu: 403', async () => {
    const t = testDeps();
    const s = await seed(t, { status: 'suspendu' });
    await rejects(listTests(t.deps, s.ctx, {}), 403);
  });
});

describe('lecture: GET /me/tests/{testId}', () => {
  it('detail: reponse donnee, texte relu dans la fiche, bonne reponse seulement si la question est terminee', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3, nGap: 1 });
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 1), 'A'); // faux, 1er essai: pas terminee
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 2), good);
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'gap', 1), 'faux');
    const id = (await tests(t))[0].SK.split('#').pop() as string;
    const d = await getTest(t.deps, ctx, id);
    expect(d).toMatchObject({ testId: id, total: 4, answered: 3, correct: 1, status: 'incomplet', scorePct: 25 });
    const [q1, q2, g1] = d.questions;
    expect(q1).toMatchObject({ rank: 1, correct: false, choice: 'A', prompt: 'Question 1 ?', choices: ['A', 'B', 'C', 'D'] });
    expect(q1.correctAnswer).toBeUndefined();
    expect(q2).toMatchObject({ rank: 2, correct: true, choice: 'B', correctAnswer: 'B' });
    expect(g1).toMatchObject({ rank: 4, kind: 'gap', correct: false, choice: 'faux', prompt: 'Le ____ 1', correctAnswer: 'Énergie' });
  });

  it('fiche supprimee: la ligne reste sans texte', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1 });
    await pass(t, ctx, 'doc1', 1);
    await t.store.remove(keys.qcm('doc1', 1));
    const id = (await tests(t))[0].SK.split('#').pop() as string;
    const q = (await getTest(t.deps, ctx, id)).questions[0];
    expect(q.prompt).toBeUndefined();
    expect(q.choice).toBe('B');
  });

  it('le passage d\'un autre eleve, un identifiant inconnu ou mal forme: 404', async () => {
    const t = testDeps();
    const a = await seed(t, { nQcm: 1 });
    const b = await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'docb', nQcm: 1 });
    await pass(t, b.ctx, 'docb', 1);
    const idB = (await tests(t, 'stu2'))[0].SK.split('#').pop() as string;
    await rejects(getTest(t.deps, a.ctx, idB), 404);
    await rejects(getTest(t.deps, a.ctx, newTestId(Date.now())), 404);
    for (const bad of ['x', '..', 'PROFILE', '01JEXAMPLE0TEST000000000AA']) await rejects(getTest(t.deps, a.ctx, bad), 404);
    expect(FID).toBeDefined();
  });

  it('une ligne q d\'une autre fiche n\'est jamais relue: pas de texte de l\'autre fiche', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1 });
    await seed(t, { docId: 'doc2', nQcm: 1 });
    await pass(t, ctx, 'doc1', 1);
    const it = (await tests(t))[0];
    await t.store.commit([{ item: { ...it, items: [{ ...(it.items as object[])[0], q: 'doc2:qcm:01' }] }, when: 'any' }]);
    const q = (await getTest(t.deps, ctx, it.SK.split('#').pop() as string)).questions[0];
    expect(q.questionId).toBe('doc2:qcm:01');
    expect(q.prompt).toBeUndefined();
    expect(q.correctAnswer).toBeUndefined();
  });

  it('une erreur d\'infrastructure en relisant la fiche remonte (500), elle n\'est pas avalee', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1 });
    await pass(t, ctx, 'doc1', 1);
    const id = (await tests(t))[0].SK.split('#').pop() as string;
    const real = t.store.get.bind(t.store);
    t.store.get = async (k) => {
      if (k.PK.startsWith('DOC#')) throw new Error('AccessDeniedException');
      return real(k);
    };
    await expect(getTest(t.deps, ctx, id)).rejects.toThrow('AccessDeniedException');
  });
});

describe('schoolYears: jamais une annee sans passage', () => {
  it('apres suppression de la fiche, l\'annee disparait de la liste (PROFILE la garde, la lecture filtre)', async () => {
    const t = testDeps({ iso: '2026-06-10T10:00:00+02:00' });
    const { ctx } = await seed(t, { nQcm: 1 });
    await seed(t, { docId: 'doc2', nQcm: 1 });
    await pass(t, ctx, 'doc1', 1); // 2025-2026
    t.clk.set('2026-12-01T10:00:00+01:00');
    await pass(t, ctx, 'doc2', 1); // 2026-2027
    expect((await listTests(t.deps, ctx, {})).schoolYears).toEqual(['2026-2027', '2025-2026']);
    await deleteDocTree(storeTreeDb(t.store), ctx.studentId, 'doc1');
    expect((await prof(t)).anneesScolaires).toContain('2025-2026');
    expect((await listTests(t.deps, ctx, {})).schoolYears).toEqual(['2026-2027']);
  });
});
