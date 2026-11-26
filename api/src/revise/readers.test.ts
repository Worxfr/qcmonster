// M1 #90 partie 2 (docs/M1-design.md 3.2 et 4): les lecteurs de questions et d'affirmations ignorent ce qu'une modification du cours a retire.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { retiredClaims } from '../../../shared/items.js';
import { exportFamily } from '../family/family.js';
import { postAnswer } from '../game/answers.js';
import { getSession, practiceSession } from '../game/session.js';
import { getTest, getTestStatus, type PlayProfile } from '../game/tests.js';
import { guarded } from '../pipeline/http.js';
import { coursMarks } from '../cours/view.js';
import { docsRead } from '../docs/docs.js';
import { body, ev, putDoc, world } from '../scans/kit.js';
import { FID, SID, seed, testDeps, type TestEnv } from '../lib/testkit.js';

type Ctx = Parameters<typeof postAnswer>[1];
const answer = (t: TestEnv, ctx: Ctx, q: string, choice = 'B') => postAnswer(t.deps, ctx, { questionId: q, choice });
const retire = async (t: TestEnv, kind: 'qcm' | 'gap', nn: number) => {
  const k = kind === 'qcm' ? keys.qcm('doc1', nn) : keys.gap('doc1', nn);
  await t.store.commit([{ item: { ...(await t.store.get(k))!, retiree: true }, when: 'any' }]);
};
const ids = (s: { questions: { questionId: string }[] }) => s.questions.map((q) => q.questionId).sort();

describe('M1-C: tirage', () => {
  it('une question retiree n\'est jamais tiree (session-get), meme si la banque est petite; available et xpRemaining suivent', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 6, nGap: 2 });
    await retire(t, 'qcm', 1);
    await retire(t, 'qcm', 2);
    await retire(t, 'gap', 1);
    const s = await getSession(t.deps, ctx, 'doc1', '20');
    expect(s.available).toBe(5);
    expect(ids(s)).toEqual(['doc1:gap:02', 'doc1:qcm:03', 'doc1:qcm:04', 'doc1:qcm:05', 'doc1:qcm:06']);
  });
  it('S\'entrainer sur plusieurs fiches ignore aussi les questions retirees', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 4 });
    await seed(t, { docId: 'doc2', nQcm: 4 });
    await retire(t, 'qcm', 1);
    await retire(t, 'qcm', 2);
    await retire(t, 'qcm', 3);
    await retire(t, 'qcm', 4);
    const s = await practiceSession(t.deps, ctx, { docIds: ['doc1', 'doc2'], size: 10 } as never);
    expect(ids(s).every((q) => q.startsWith('doc2:'))).toBe(true);
    expect(s.questions).toHaveLength(4);
  });
  it('une fiche dont toutes les questions sont retirees: session vide (comme une fiche sans question)', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1 });
    await retire(t, 'qcm', 1);
    expect(await getSession(t.deps, ctx, 'doc1', '5')).toMatchObject({ questions: [], available: 0, short: true });
  });
});

describe('M1-C: answers-post et historique', () => {
  async function open(t: TestEnv, ctx: Ctx, retiredNn?: number) {
    const s = await getSession(t.deps, ctx, 'doc1', '5');
    if (retiredNn) await retire(t, 'qcm', retiredNn); // retiree PENDANT que le test est ouvert
    return s;
  }
  it('une question retiree dans un test deja ouvert est corrigee normalement, sans point, retired:true, sans avancer la serie', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 5 });
    const s = await open(t, ctx);
    const q = s.questions[0].questionId;
    await retire(t, 'qcm', Number(q.slice(-2)));
    t.clk.advance(2500);
    const r = await answer(t, ctx, q, 'B');
    expect(r).toMatchObject({ correct: true, xpGained: 0, retired: true });
    expect(r.capped).toBeUndefined();
    const p = (await t.store.get(keys.profile(SID))) as unknown as PlayProfile;
    expect(p.series.n).toBe(0);
    const att = await t.store.query(`STUDENT#${SID}`, 'ATT#doc1:');
    expect(att.filter((a) => a.rewarded === true)).toHaveLength(0);
    t.clk.advance(2500);
    const r2 = await answer(t, ctx, s.questions[1].questionId, 'B'); // une autre question paie toujours
    expect(r2.xpGained).toBeGreaterThan(0);
    expect(r2.retired).toBeUndefined();
  });
  it('une mauvaise reponse a une question retiree est corrigee: faux, retired, rien de revele avant la fin des essais', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 5 });
    const s = await open(t, ctx);
    const q = s.questions[0].questionId;
    await retire(t, 'qcm', Number(q.slice(-2)));
    t.clk.advance(2500);
    const r = await answer(t, ctx, q, 'A');
    expect(r).toMatchObject({ correct: false, xpGained: 0, retired: true });
    expect(r.correctAnswer).toBeUndefined();
  });
  it('les points deja gagnes avant la retraite comptent toujours dans les 50 de la fiche', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 5 });
    const s = await getSession(t.deps, ctx, 'doc1', '5');
    t.clk.advance(2500);
    await answer(t, ctx, s.questions[0].questionId, 'B');
    await retire(t, 'qcm', Number(s.questions[0].questionId.slice(-2)));
    expect((await getSession(t.deps, ctx, 'doc1')).xpRemaining).toBe(45); // 5 points payes, la ligne ATT# reste comptee
  });
  it('l\'historique garde le texte d\'une question retiree (retired:true); le parent ne recoit jamais de texte', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 5 });
    const s = await getSession(t.deps, ctx, 'doc1', '5');
    const q = s.questions[0].questionId;
    t.clk.advance(2500);
    await answer(t, ctx, q, 'B');
    await retire(t, 'qcm', Number(q.slice(-2)));
    const tests = await t.store.query(`STUDENT#${SID}`, 'TEST#');
    const id = tests[0].SK.slice(tests[0].SK.lastIndexOf('#') + 1);
    const d = await getTest(t.deps, ctx, id);
    const line = d.questions.find((x) => x.questionId === q)!;
    expect(line.retired).toBe(true);
    expect(line.prompt).toMatch(/^Question /);
    expect(d.questions.filter((x) => x.retired)).toHaveLength(1);
    expect(JSON.stringify(await getTestStatus(t.deps, SID, id))).not.toMatch(/Question |retired/);
  });
});

describe('M1-C: affirmations retirees', () => {
  it('retiredClaims lit un tableau de numeros, ignore le reste', () => {
    expect([...retiredClaims({ claimsRetired: [1, '2', 'x'] })].sort()).toEqual([1, 2]);
    expect(retiredClaims({ claimsRetired: 'oops' }).size).toBe(0);
    expect(retiredClaims(undefined).size).toBe(0);
  });
  it('docs-read ne rend plus les affirmations retirees (et la fiche reste lisible)', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { claimsRetired: [2] });
    for (const n of ['01', '02', '03']) await t.db.put({ PK: 'DOC#D1', SK: `CLAIM#${n}`, texte: `Phrase ${n}.`, aRisque: false });
    const r = await guarded(docsRead)(t.ctx, ev('s1', 'GET /docs/{docId}', { params: { docId: 'D1' } }));
    expect(body(r).claims.map((c: { claimId: string }) => c.claimId)).toEqual(['01', '03']);
  });
  it('les marques du cours ignorent les affirmations retirees', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { claimsRetired: [1] });
    await t.db.put({ PK: 'DOC#D1', SK: 'CLAIM#01', texte: 'Ancienne.', aRisque: false, origine: { phraseId: 'p1-s1' } });
    await t.db.put({ PK: 'DOC#D1', SK: 'CLAIM#02', texte: 'Nouvelle.', aRisque: false, origine: { phraseId: 'p1-s2' } });
    await t.db.put({ PK: 'DOC#D1', SK: 'VERDICT#01', statut: 'erreur', niveau: 2, secondeLecture: false, sources: [] });
    await t.db.put({ PK: 'DOC#D1', SK: 'VERDICT#02', statut: 'verifiee', niveau: 2, secondeLecture: false, sources: [] });
    const marks = await coursMarks(t.ctx, 's1', { sections: [{ docId: 'D1' }] });
    expect(marks.map((m) => m.sentenceId)).toEqual(['p1-s2']);
  });
  it('l\'export parent n\'inclut ni les affirmations ni les questions retirees', async () => {
    const t = testDeps();
    await seed(t, { nQcm: 3 });
    const k = keys.doc(SID, 'doc1');
    await t.store.commit([{ item: { ...(await t.store.get(k))!, claimsRetired: [1] }, when: 'any' }]);
    for (const n of [1, 2]) await t.store.commit([{ item: { ...keys.claim('doc1', n), texte: `Phrase ${n}`, origine: {}, type: 'factuelle', aRisque: false }, when: 'any' }]);
    await retire(t, 'qcm', 1);
    const out = JSON.stringify(await exportFamily(t.deps, { sub: 'sub-par1', username: 'par1', familyId: FID }));
    expect(out).not.toContain('Phrase 1');
    expect(out).toContain('Phrase 2');
    expect(out).not.toContain('doc1:qcm:01');
    expect(out).toContain('doc1:qcm:02');
  });
});
