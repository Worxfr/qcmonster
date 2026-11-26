// Q1 (docs/Q1-design.md section 12): tirage, controle `draw`, plafond de 50 XP par fiche, serie (B1), S'entrainer multi-fiches.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { HttpError } from '../lib/http.js';
import { SID, FID, parentCtx, qid, seed, testDeps, type TestEnv } from '../lib/testkit.js';
import { postAnswer } from './answers.js';
import { getSession, practiceSession } from './session.js';
import { DOC_XP_CAP } from './rules.js';
import { listStudentTests } from './family-progress.js';
import { exportFamily } from '../family/family.js';
import type { PlayProfile } from './tests.js';

type Ctx = Parameters<typeof postAnswer>[1];
const good = 'B';
const answer = (t: TestEnv, ctx: Ctx, q: string, choice = good) => postAnswer(t.deps, ctx, { questionId: q, choice });
const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (code) expect((e as HttpError).code).toBe(code);
};
const prof = async (t: TestEnv) => (await t.store.get(keys.profile(SID))) as unknown as PlayProfile & { xp: number };
const tests = async (t: TestEnv) => (await t.store.query(`STUDENT#${SID}`, 'TEST#')).sort((a, b) => a.SK.localeCompare(b.SK));
const seeded = (n = 1) => () => ((n = (Math.imul(n, 1664525) + 1013904223) >>> 0) / 2 ** 32);
/** Reponse juste a une question tiree (QCM: B, trou: Energie). */
const right = (q: string) => (q.includes(':gap:') ? 'energie' : good);
/** Repond a toutes les questions d'une liste, 2,5 s entre deux. */
async function answerAll(t: TestEnv, ctx: Ctx, ids: string[]): Promise<Awaited<ReturnType<typeof answer>>[]> {
  const out = [];
  for (const q of ids) {
    t.clk.advance(2500);
    out.push(await answer(t, ctx, q, right(q)));
  }
  return out;
}
const draw = async (t: TestEnv) => (await prof(t)).currentTest!.draw;

describe('Q1: session-get, banque et tirage', () => {
  it('size 5, 10, 15, 20: le bon nombre de questions, sans cle ni mot attendu; autre valeur: 400', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 20, nGap: 20 });
    for (const n of [5, 10, 15, 20]) {
      const s = await getSession(t.deps, ctx, 'doc1', String(n));
      expect(s.questions).toHaveLength(n);
      expect(s.available).toBeGreaterThanOrEqual(n);
      expect(s.short).toBe(false);
      expect(JSON.stringify(s)).not.toMatch(/"cle"|attendu|"answer"|correctAnswer/);
    }
    expect((await getSession(t.deps, ctx, 'doc1')).questions).toHaveLength(10); // defaut
    for (const bad of ['7', '0', 'abc', '-5', '100']) await rejects(getSession(t.deps, ctx, 'doc1', bad), 400);
  });

  it('deux tests de suite sur 20 questions ne partagent aucune question; le troisieme reprend les plus anciennes', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10, nGap: 10 });
    const s1 = await getSession(t.deps, ctx, 'doc1', '10', seeded(1));
    await answerAll(t, ctx, s1.questions.map((q) => q.questionId));
    t.clk.advance(24 * 3_600_000);
    const s2 = await getSession(t.deps, ctx, 'doc1', '10', seeded(2));
    const ids1 = s1.questions.map((q) => q.questionId);
    expect(s2.questions.map((q) => q.questionId).filter((q) => ids1.includes(q))).toEqual([]);
    await answerAll(t, ctx, s2.questions.map((q) => q.questionId));
    t.clk.advance(24 * 3_600_000);
    const s3 = await getSession(t.deps, ctx, 'doc1', '10', seeded(3));
    expect(s3.questions.map((q) => q.questionId).sort()).toEqual([...ids1].sort()); // les plus anciennes d'abord
  });

  it('une question vue sans reponse n\'est pas comptee comme posee', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 6 });
    const a = await getSession(t.deps, ctx, 'doc1', '5', seeded(5));
    const b = await getSession(t.deps, ctx, 'doc1', '5', seeded(5)); // rien repondu entre-temps
    expect(b.questions.map((q) => q.questionId).sort()).toEqual(a.questions.map((q) => q.questionId).sort());
  });

  it('banque trop petite: test plus court, short, available', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3, nGap: 1 });
    const s = await getSession(t.deps, ctx, 'doc1', '10');
    expect(s).toMatchObject({ short: true, available: 4 });
    expect(s.questions).toHaveLength(4);
  });

  it('jamais deux questions proches dans un meme test', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 4 });
    // question 2 = presque la question 1 (meme reponse, memes mots)
    const q1 = (await t.store.get(keys.qcm('doc1', 1)))!;
    await t.store.commit([{ item: { ...keys.qcm('doc1', 2), questionId: 'doc1:qcm:02', enonce: String(q1.enonce), choix: ['A', 'B', 'C', 'D'], cle: 1, claimId: '02' }, when: 'any' }]);
    for (let k = 0; k < 5; k++) {
      const ids = (await getSession(t.deps, ctx, 'doc1', '10', seeded(k + 1))).questions.map((q) => q.questionId);
      expect(ids.includes('doc1:qcm:01') && ids.includes('doc1:qcm:02')).toBe(false);
      expect(ids).toHaveLength(3);
    }
  });

  it('XP restants de la fiche', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    expect((await getSession(t.deps, ctx, 'doc1')).xpRemaining).toBe(50);
    const ids = await draw(t);
    await answerAll(t, ctx, ids.slice(0, 2));
    expect((await getSession(t.deps, ctx, 'doc1')).xpRemaining).toBe(40);
  });
});

describe('Q1 P10: answers-post n\'accepte que le tirage du test ouvert', () => {
  it('question hors tirage: 409, rien ecrit ni revele', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 12 });
    const s = await getSession(t.deps, ctx, 'doc1', '5', seeded(1));
    const inDraw = new Set(s.questions.map((q) => q.questionId));
    const outside = Array.from({ length: 12 }, (_, i) => qid('doc1', 'qcm', i + 1)).find((q) => !inDraw.has(q))!;
    t.clk.advance(2500);
    await rejects(answer(t, ctx, outside), 409, 'etat_invalide');
    expect(await t.store.query(`STUDENT#${SID}`, 'ATT#')).toHaveLength(0);
    expect(await tests(t)).toHaveLength(0);
    const ok = await answer(t, ctx, [...inDraw][0], right([...inDraw][0]));
    expect(ok.correct).toBe(true);
  });

  it('deux onglets: le dernier test ouvert gagne, le premier recoit 409; 429 reste distinct', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 20 });
    await getSession(t.deps, ctx, 'doc1', '5', seeded(1));
    const first = await draw(t);
    t.clk.advance(2500);
    await getSession(t.deps, ctx, 'doc1', '5', seeded(9)); // 2e onglet
    const second = await draw(t);
    const only = first.find((q) => !second.includes(q));
    if (only) {
      t.clk.advance(2500);
      await rejects(answer(t, ctx, only), 409);
    }
    t.clk.advance(2500);
    await answer(t, ctx, second[0], right(second[0]));
    await rejects(answer(t, ctx, second[1], right(second[1])), 429, 'etat_invalide'); // < 1 s: 429, pas 409
  });

  it('plus de 3 h sans reponse: 409', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 5 });
    await getSession(t.deps, ctx, 'doc1');
    const q = (await draw(t))[0];
    t.clk.advance(3 * 3_600_000 + 1000);
    await rejects(answer(t, ctx, q), 409);
  });

  it('fiche supprimee pendant le test: 404, aucune ligne cree', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    await getSession(t.deps, ctx, 'doc1');
    const q = (await draw(t))[0];
    await t.store.remove(keys.doc(SID, 'doc1'));
    t.clk.advance(2500);
    await rejects(answer(t, ctx, q), 404);
    expect(await tests(t)).toHaveLength(0);
  });
});

describe('Q1 P5: 50 XP au plus par fiche', () => {
  async function drain(t: TestEnv, ctx: Ctx, n: number): Promise<{ xp: number; capped: number; right: number }> {
    let xp = 0;
    let capped = 0;
    let rightN = 0;
    while (n > 0) {
      const s = await getSession(t.deps, ctx, 'doc1', '20');
      for (const q of s.questions.slice(0, n)) {
        t.clk.advance(2500);
        const r = await answer(t, ctx, q.questionId, right(q.questionId));
        xp += r.xpGained;
        if (r.capped) capped++;
        if (r.correct) rightN++;
        n--;
      }
      t.clk.advance(1000);
    }
    return { xp, capped, right: rightN };
  }

  it('fiche de 40 questions: les bonnes reponses paient 50 XP puis 0 (capped), la correction reste juste', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 20, nGap: 20 });
    const r = await drain(t, ctx, 40);
    expect(r.xp).toBe(DOC_XP_CAP + 20 + 30); // 50 de fiche + une serie de 10 parfaite (hors des 50)
    expect(r.right).toBe(40);
    expect(r.capped).toBe(30); // 10 questions payees, 30 refusees par le plafond
    const att = await t.store.query(`STUDENT#${SID}`, 'ATT#doc1:');
    expect(att.filter((a) => a.rewarded === true)).toHaveLength(10);
    expect(att.filter((a) => a.rewarded !== true)).toHaveLength(30);
    expect(att.reduce((n, a) => n + Number(a.xp ?? 0), 0)).toBe(DOC_XP_CAP);
    expect((await getSession(t.deps, ctx, 'doc1')).xpRemaining).toBe(0);
  });

  it('fiche de 10 questions: paie comme avant (10 x 5); un QCM paye 2 au 2e essai compte 2', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    const ids = (await getSession(t.deps, ctx, 'doc1', '10')).questions.map((q) => q.questionId);
    t.clk.advance(2500);
    await answer(t, ctx, ids[0], 'A'); // faux
    t.clk.advance(2500);
    expect((await answer(t, ctx, ids[0])).xpGained).toBe(2);
    const row = (await t.store.query(`STUDENT#${SID}`, `ATT#${ids[0]}#`))[0];
    expect(row.xp).toBe(2);
    await answerAll(t, ctx, ids.slice(1));
    expect((await prof(t)).xp).toBe(2 + 9 * 5 + 20); // 10 reponses de serie: +20 (plus de 20 s, pas parfaite: 1er essai rate)
    expect((await getSession(t.deps, ctx, 'doc1')).xpRemaining).toBe(3);
  });

  it('ancienne ligne sans xp: comptee 5 si rewarded, 0 sinon', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    for (let i = 1; i <= 9; i++) await t.store.commit([{ item: { ...keys.attempt(SID, qid('doc1', 'qcm', i), '2026-11-01'), attempts: 1, done: true, rewarded: true }, when: 'any' }]);
    await t.store.commit([{ item: { ...keys.attempt(SID, qid('doc1', 'qcm', 10), '2026-11-01'), attempts: 1, done: true, rewarded: false }, when: 'any' }]);
    expect((await getSession(t.deps, ctx, 'doc1')).xpRemaining).toBe(5); // 9 x 5 = 45 payes
  });

  it('le plafond est par fiche, pas global: deux fiches paient chacune 50', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    await seed(t, { docId: 'doc2', nQcm: 10 });
    let total = 0;
    for (const d of ['doc1', 'doc2']) {
      const s = await getSession(t.deps, ctx, d, '10');
      total += (await answerAll(t, ctx, s.questions.map((q) => q.questionId))).reduce((n, r) => n + r.xpGained, 0);
      t.clk.advance(1000);
    }
    expect(total).toBe(2 * (50 + 20 + 30)); // 2 x (50 de fiche + serie parfaite hors des 50)
    const att = await t.store.query(`STUDENT#${SID}`, 'ATT#');
    expect(att.reduce((n, a) => n + Number(a.xp ?? 0), 0)).toBe(100);
  });

  it('`xp` de la ligne = gain de fiche avant le plafond quotidien; il ne sort ni dans la reponse ni dans l\'export', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    // Le jour est deja a 250 XP: le gain reste compte dans la fiche mais n'est pas credite.
    const day = (await t.store.get(keys.day(SID, '2026-12-01'))) ?? { ...keys.day(SID, '2026-12-01') };
    await t.store.commit([{ item: { ...day, xp: 250, pagesPaid: 0, valid: true, reads: {} }, when: 'any' }]);
    const s = await getSession(t.deps, ctx, 'doc1');
    t.clk.advance(2500);
    const r = await answer(t, ctx, s.questions[0].questionId, right(s.questions[0].questionId));
    expect(r.xpGained).toBe(0);
    expect(Object.keys(r)).not.toContain('xp');
    const row = (await t.store.query(`STUDENT#${SID}`, 'ATT#doc1:'))[0];
    expect(row.xp).toBe(5);
    expect(row.rewarded).toBe(true);
    expect(JSON.stringify(await exportFamily(t.deps, { sub: 'sub-par1', username: 'par1', familyId: FID }))).not.toMatch(/"xp":5/);
  });

  it('serie (B1): 10 reponses sur une fiche pleine = 0 bonus et la serie n\'avance pas', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 20, nGap: 20 });
    for (let i = 1; i <= 10; i++) await t.store.commit([{ item: { ...keys.attempt(SID, qid('doc1', 'qcm', i), '2026-11-01'), attempts: 1, done: true, rewarded: true, xp: 5 }, when: 'any' }]);
    const s = await getSession(t.deps, ctx, 'doc1', '10');
    const rs = await answerAll(t, ctx, s.questions.map((q) => q.questionId));
    expect(rs.map((r) => r.xpGained)).toEqual(Array(10).fill(0));
    expect((await prof(t)).xp ?? 0).toBe(0);
    expect((await prof(t)).series.n).toBe(0);
  });

  it('serie (B1): une fiche pleine et une non pleine: seules les reponses de la seconde comptent', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    await seed(t, { docId: 'doc2', nQcm: 10 });
    for (let i = 1; i <= 10; i++) await t.store.commit([{ item: { ...keys.attempt(SID, qid('doc1', 'qcm', i), '2026-11-01'), attempts: 1, done: true, rewarded: true, xp: 5 }, when: 'any' }]);
    const s = await practiceSession(t.deps, ctx, { docIds: ['doc1', 'doc2'], size: 10 }, seeded(4));
    // doc1 est pleine: ses questions deja payees ne rapportent rien; doc2 en donne 5 sur 5
    await answerAll(t, ctx, s.questions.map((q) => q.questionId));
    expect((await prof(t)).series.n).toBe(5);
  });

  it('serie (B1): fiche presque pleine (restant 5): la reponse qui atteint 50 compte, les suivantes non', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 20 });
    for (let i = 1; i <= 9; i++) await t.store.commit([{ item: { ...keys.attempt(SID, qid('doc1', 'qcm', i), '2026-11-01'), attempts: 1, done: true, rewarded: true, xp: 5 }, when: 'any' }]);
    const s = await getSession(t.deps, ctx, 'doc1', '10', seeded(8));
    const fresh = s.questions.map((q) => q.questionId).filter((q) => parseInt(q.slice(-2), 10) > 9);
    const old = s.questions.map((q) => q.questionId).filter((q) => parseInt(q.slice(-2), 10) <= 9);
    await answerAll(t, ctx, [fresh[0], ...fresh.slice(1)]);
    expect((await prof(t)).series.n).toBe(1);
    expect(old.length).toBeGreaterThanOrEqual(0);
  });
});

describe('Q1: POST /practice/session', () => {
  async function folderWith(t: TestEnv, id: string, docIds: string[]) {
    await t.store.commit([{ item: { ...keys.folder(SID, id), nom: 'Histoire', nomCle: 'histoire', createdAt: 'x' }, when: 'any' }]);
    for (const d of docIds) {
      const it = (await t.store.get(keys.doc(SID, d)))!;
      await t.store.commit([{ item: { ...it, dossierId: id }, when: 'any' }]);
    }
  }

  it('plusieurs fiches: parts egales, fiche d\'origine, un seul passage multi-fiches dans l\'historique', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    await seed(t, { docId: 'doc2', nQcm: 10 });
    await seed(t, { docId: 'doc3', nQcm: 10 });
    const s = await practiceSession(t.deps, ctx, { docIds: ['doc1', 'doc2', 'doc3'], size: 15 }, seeded(3));
    expect(s.scope).toBe('fiches');
    expect(s.title).toBe('3 fiches');
    expect(s.questions).toHaveLength(15);
    for (const d of ['doc1', 'doc2', 'doc3']) expect(s.questions.filter((q) => q.docId === d)).toHaveLength(5);
    expect(s.questions.every((q) => q.docTitle === 'Titre')).toBe(true);
    expect(JSON.stringify(s)).not.toMatch(/"cle"|attendu|correctAnswer/);
    expect(s.xpRemaining).toEqual([{ docId: 'doc1', xpRemaining: 50 }, { docId: 'doc2', xpRemaining: 50 }, { docId: 'doc3', xpRemaining: 50 }]);
    await answerAll(t, ctx, s.questions.map((q) => q.questionId));
    const all = await tests(t);
    expect(all).toHaveLength(1);
    expect(all[0]).toMatchObject({ scope: 'fiches', docIds: ['doc1', 'doc2', 'doc3'], titre: '3 fiches', total: 15, answered: 15, docId: 'doc1' });
    expect((all[0].items as { q: string; r: number }[]).map((l) => [l.q, l.r])).toEqual(s.questions.map((q, i) => [q.questionId, i + 1]));
  });

  it('dossier: nom du dossier comme titre; fiche sans question ecartee et dite; une fiche d\'un autre eleve ou inconnue: introuvable sans titre', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 6 });
    await seed(t, { docId: 'vide', nQcm: 0 });
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'docb', nQcm: 3 });
    await folderWith(t, 'fo1', ['doc1', 'vide']);
    const s = await practiceSession(t.deps, ctx, { folderId: 'fo1', size: 5 });
    expect(s).toMatchObject({ scope: 'dossier', title: 'Histoire', docIds: ['doc1'] });
    expect(s.skipped).toEqual([{ docId: 'vide', title: 'Titre', reason: 'sans_question' }]);
    const o = await practiceSession(t.deps, ctx, { docIds: ['doc1', 'docb', 'inconnue'], size: 5 });
    expect(o.skipped).toEqual([{ docId: 'docb', reason: 'introuvable' }, { docId: 'inconnue', reason: 'introuvable' }]); // indiscernables, sans titre
    expect(JSON.stringify(o)).not.toContain('stu2');
  });

  it('legal: le parent voit, pour un passage de scope dossier, le nom du dossier comme titre (texte de la politique et du registre)', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 6 });
    await folderWith(t, 'fo1', ['doc1']);
    const s = await practiceSession(t.deps, ctx, { folderId: 'fo1', size: 5 });
    await answerAll(t, ctx, s.questions.map((q) => q.questionId));
    const page = await listStudentTests(t.deps, parentCtx, SID, {});
    expect(page.items.map((i) => i.titre)).toEqual(['Histoire']);
  });

  it('erreurs: les deux parametres ou aucun 400, 11 fiches 400, docId hors motif 400, doublon 400, size 400, dossier d\'un autre eleve 404, aucune question 409', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3 });
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'docb', nQcm: 3 });
    await t.store.commit([{ item: { ...keys.folder('stu2', 'foB'), nom: 'Autre', nomCle: 'autre', createdAt: 'x' }, when: 'any' }]);
    await rejects(practiceSession(t.deps, ctx, {}), 400);
    await rejects(practiceSession(t.deps, ctx, { docIds: ['doc1'], folderId: 'fo1' }), 400);
    await rejects(practiceSession(t.deps, ctx, { docIds: Array.from({ length: 11 }, (_, i) => `d${i}`) }), 400);
    await rejects(practiceSession(t.deps, ctx, { docIds: ['a#b'] }), 400);
    await rejects(practiceSession(t.deps, ctx, { docIds: ['doc1', 'doc1'] }), 400);
    await rejects(practiceSession(t.deps, ctx, { docIds: ['doc1'], size: 7 }), 400);
    await rejects(practiceSession(t.deps, ctx, { folderId: 'foB' }), 404);
    await rejects(practiceSession(t.deps, ctx, { folderId: 'vide' }), 404);
    await t.store.commit([{ item: { ...keys.folder(SID, 'fo2'), nom: 'Vide', nomCle: 'vide', createdAt: 'x' }, when: 'any' }]);
    await rejects(practiceSession(t.deps, ctx, { folderId: 'fo2' }), 409, 'aucune_question');
    await rejects(practiceSession(t.deps, ctx, { docIds: ['docb'] }), 409, 'aucune_question');
  });

  it('ouvrir une session remet tick et la serie a zero', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 10 });
    const s = await practiceSession(t.deps, ctx, { docIds: ['doc1'] });
    await answerAll(t, ctx, s.questions.slice(0, 3).map((q) => q.questionId));
    expect((await prof(t)).series.n).toBe(3);
    t.clk.advance(5000);
    await practiceSession(t.deps, ctx, { docIds: ['doc1'] });
    const p = await prof(t);
    expect(p.series.n).toBe(0);
    expect(p.tick).toBe(t.clk.t);
  });

  it('dossier de 25 fiches: les 10 les moins recemment travaillees', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { docId: 'f01', nQcm: 2 });
    for (let i = 2; i <= 25; i++) await seed(t, { docId: `f${String(i).padStart(2, '0')}`, nQcm: 2, createdAt: `2026-11-${String(i).padStart(2, '0')}T10:00:00Z` });
    await folderWith(t, 'big', Array.from({ length: 25 }, (_, i) => `f${String(i + 1).padStart(2, '0')}`));
    // les 15 premieres fiches ont deja ete travaillees (passage recent), pas les 10 dernieres
    for (let i = 1; i <= 15; i++) await t.store.commit([{ item: { ...keys.test(SID, `2026-11-2${i % 9}T09:00:00Z`, `01JTESTID000000000000000${String(i).padStart(2, '0')}`), docId: `f${String(i).padStart(2, '0')}`, startedAt: `2026-11-2${i % 9}T09:00:00Z`, items: [] }, when: 'any' }]);
    const s = await practiceSession(t.deps, ctx, { folderId: 'big', size: 20 });
    expect(s.docIds).toHaveLength(10);
    expect(s.docIds.sort()).toEqual(Array.from({ length: 10 }, (_, i) => `f${String(i + 16).padStart(2, '0')}`));
    expect(s.skipped).toEqual([]); // les fiches non retenues ne sont pas « ecartees »
  });

  it('banque trop petite: short', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 2 });
    await seed(t, { docId: 'doc2', nQcm: 1 });
    const s = await practiceSession(t.deps, ctx, { docIds: ['doc1', 'doc2'], size: 10 });
    expect(s).toMatchObject({ short: true, available: 3 });
    expect(s.questions).toHaveLength(3);
  });
});
