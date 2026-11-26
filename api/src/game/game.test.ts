import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { HttpError } from '../lib/http.js';
import { FID, SID, qid, seed, testDeps, type TestEnv } from '../lib/testkit.js';
import { getSession } from './session.js';
import { postAnswer, type AnswerResult } from './answers.js';
import { markRead } from './read.js';
import { BADGE_IDS, isBadge } from './badges.js';
import { getDashboard, getLeaderboard, getMe, getProgress } from './family-read.js';
import { credit, effectiveStreak, loadState, type Profile } from './state.js';
import { grantStreakBonus } from './bonus.js';

const answer = (t: TestEnv, ctx: Parameters<typeof postAnswer>[1], q: string, choice: string) => postAnswer(t.deps, ctx, { questionId: q, choice });
/** Bonne reponse QCM (cle = choix 1 = « B »). */
const good = 'B';
const rejects = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
};
const profile = async (t: TestEnv, sid = SID) => (await t.store.get(keys.profile(sid))) as unknown as Profile;

/** Ouvre la session puis repond a `n` questions du QCM, `gapMs` apres la precedente. */
async function play(t: TestEnv, ctx: Parameters<typeof postAnswer>[1], n: number, gapMs: number, choice = good, from = 1): Promise<AnswerResult[]> {
  await getSession(t.deps, ctx, 'doc1', '20');
  const out: AnswerResult[] = [];
  for (let i = from; i < from + n; i++) {
    t.clk.advance(gapMs);
    out.push(await answer(t, ctx, qid('doc1', 'qcm', i), choice));
  }
  return out;
}

// Q1: 50 XP au plus par fiche et 20 questions au plus par tirage. Les tests de charge des regles de points (plafond quotidien, rafale, series de
// jours) utilisent donc plusieurs fiches de 10 questions (`d1`, `d2`...) et elargissent le tirage du passage ouvert (`openWide`).
const gq = (i: number, kind: 'qcm' | 'gap' = 'qcm') => qid(`d${Math.ceil(i / 10)}`, kind, ((i - 1) % 10) + 1);
async function seedMany(t: TestEnv, n: number, o: { nGap?: number } = {}) {
  let out;
  for (let d = 1; d <= Math.ceil(n / 10); d++) out = await seed(t, { docId: `d${d}`, nQcm: Math.min(10, n - (d - 1) * 10), ...(d === 1 && o.nGap ? { nGap: o.nGap } : {}) });
  return out!;
}
/** Ouvre une session (remise a zero de la serie) dont le tirage contient les `n` premieres questions de `seedMany` (plus les trous demandes). */
async function openWide(t: TestEnv, ctx: Parameters<typeof postAnswer>[1], n: number, extra: string[] = []) {
  await getSession(t.deps, ctx, 'd1', '20');
  const p = (await t.store.get(keys.profile(SID)))!;
  const cur = p.currentTest as Record<string, unknown>;
  await t.store.commit([{ item: { ...p, currentTest: { ...cur, draw: [...Array.from({ length: n }, (_, i) => gq(i + 1)), ...extra] } }, when: p.v ?? 'any' }]);
}

describe('session-get: jamais de reponse', () => {
  it('renvoie enonces et choix, sans cle ni mot attendu ni affirmation', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 3, nGap: 2 });
    const s = await getSession(t.deps, ctx, 'doc1', '20');
    expect(s.questions.map((q) => q.questionId).sort()).toEqual(['doc1:gap:01', 'doc1:gap:02', 'doc1:qcm:01', 'doc1:qcm:02', 'doc1:qcm:03']); // Q1: ordre tire au hasard
    const text = JSON.stringify(s);
    for (const secret of ['"cle"', 'attendu', 'Énergie', 'claimId', 'verdict', 'statut']) expect(text).not.toContain(secret);
    expect(s.questions.find((q) => q.kind === 'qcm')!.choices).toEqual(['A', 'B', 'C', 'D']);
    expect(s.questions.find((q) => q.kind === 'gap')!.choices).toBeUndefined();
  });
  it('ignore un element invalide; 404 pour la fiche d\'un autre eleve; 403 si suspendu', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1, nGap: 1 });
    await t.store.commit([{ item: { ...keys.qcm('doc1', 9), questionId: 'mauvais' }, when: 'any' }, { item: { ...keys.gap('doc1', 9), questionId: 'mauvais' }, when: 'any' }]);
    expect((await getSession(t.deps, ctx, 'doc1', '20')).questions).toHaveLength(2);
    await rejects(getSession(t.deps, ctx, 'autre', '20'), 404);
    await rejects(getSession(t.deps, { ...ctx, sub: 'sub-autre' }, 'doc1'), 403); // jeton d'un autre compte
    const t2 = testDeps();
    const s2 = await seed(t2, { status: 'suspendu' });
    await rejects(getSession(t2.deps, s2.ctx, 'doc1'), 403);
  });
  it('une famille ne voit pas les fiches d\'une autre', async () => {
    const t = testDeps();
    await seed(t);
    const other = await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await rejects(getSession(t.deps, other.ctx, 'doc1', '20'), 404);
  });
});

describe('answers-post: XP par question', () => {
  it('QCM: 5 XP du premier coup, 2 au second essai, rien ensuite; la bonne reponse n\'est revelee qu\'a la fin', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    const r1 = await answer(t, ctx, qid('doc1', 'qcm', 1), good);
    expect(r1).toMatchObject({ correct: true, xpGained: 5, correctAnswer: 'B' });
    t.clk.advance(2000);
    const w = await answer(t, ctx, qid('doc1', 'qcm', 2), 'A');
    expect(w.correct).toBe(false);
    expect(w.correctAnswer).toBeUndefined(); // un second essai reste possible
    t.clk.advance(2000);
    const r2 = await answer(t, ctx, qid('doc1', 'qcm', 2), good);
    expect(r2).toMatchObject({ correct: true, xpGained: 2, correctAnswer: 'B' });
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('doc1', 'qcm', 1), good)).xpGained).toBe(0); // une recompense par question
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('doc1', 'qcm', 2), good)).xpGained).toBe(0);
    expect(r2.progress.xp).toBe(7);
  });
  it('QCM: deux mauvaises reponses revelent la bonne', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 3), 'A');
    t.clk.advance(2000);
    const r = await answer(t, ctx, qid('doc1', 'qcm', 3), 'C');
    expect(r).toMatchObject({ correct: false, xpGained: 0, correctAnswer: 'B' });
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('doc1', 'qcm', 3), good)).xpGained).toBe(0); // essais epuises pour aujourd'hui
  });
  it('trou: 5 XP, accents et casse ignores, une seule tentative; la reponse est revelee si faux', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1, nGap: 2 });
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    expect(await answer(t, ctx, qid('doc1', 'gap', 1), ' energie. ')).toMatchObject({ correct: true, xpGained: 5 });
    t.clk.advance(2000);
    expect(await answer(t, ctx, qid('doc1', 'gap', 2), 'chaleur')).toMatchObject({ correct: false, xpGained: 0, correctAnswer: 'Énergie' });
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('doc1', 'gap', 2), 'energie')).xpGained).toBe(0);
  });
  it('une recompense par question POUR TOUJOURS: rejouer le lendemain ne rapporte rien et ne compte pas pour les badges', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await play(t, ctx, 3, 2000);
    expect((await profile(t)).correct).toBe(3);
    t.clk.advance(24 * 3600 * 1000);
    const again = await play(t, ctx, 3, 2000);
    expect(again.map((r) => r.xpGained)).toEqual([0, 0, 0]);
    expect(again.every((r) => r.correct)).toBe(true);
    const p = await profile(t);
    expect([p.correct, p.xp]).toEqual([3, 15]);
    expect(p.series.n).toBe(0); // rejouer des questions deja payees ne fabrique pas de series
  });
  it('une question ratee hier (jamais payee) peut etre payee aujourd\'hui, une seule fois', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await play(t, ctx, 1, 2000, 'A'); // faux
    t.clk.advance(2000);
    await answer(t, ctx, qid('doc1', 'qcm', 1), 'C'); // faux, essais epuises
    t.clk.advance(24 * 3600 * 1000);
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('doc1', 'qcm', 1), good)).xpGained).toBe(5);
    t.clk.advance(24 * 3600 * 1000);
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('doc1', 'qcm', 1), good)).xpGained).toBe(0);
  });
  it('refuse une question mal formee, inconnue, ou d\'une fiche qui n\'est pas a l\'eleve', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await rejects(answer(t, ctx, 'nimporte quoi', 'x'), 400);
    await rejects(answer(t, ctx, 'docX:qcm:01', 'x'), 404);
    await rejects(answer(t, ctx, 'doc1:qcm:77', 'x'), 404);
    await rejects(answer(t, ctx, 'doc1:gap:01', 'x'), 404);
    const other = await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await rejects(answer(t, other.ctx, 'doc1:qcm:01', good), 404);
  });
  it('l\'XP du trou ou du QCM compte pour la matiere; « autre » ne compte pas pour l\'explorateur', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { matiere: 'autre' });
    await play(t, ctx, 1, 2000);
    const p = await profile(t);
    expect(p.xpBySubject).toEqual({ autre: 5 });
    expect(p.subjects.list).toEqual([]);
  });
});

describe('anti-triche', () => {
  it('moins de 1 s apres la precedente: refus (429) sans RIEN reveler sur la justesse, ni essai compte', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await getSession(t.deps, ctx, 'doc1', '20');
    // La bonne et les mauvaises reponses recoivent exactement la meme reponse: aucun oracle.
    const outcomes: string[] = [];
    for (const choice of ['A', good, 'C', good]) {
      t.clk.advance(200);
      const e = await answer(t, ctx, qid('doc1', 'qcm', 1), choice).then(() => undefined, (x: unknown) => x as HttpError);
      outcomes.push(JSON.stringify([e?.status, e?.code, e?.message]));
    }
    expect(new Set(outcomes).size).toBe(1);
    expect(outcomes[0]).toContain('429');
    expect(await t.store.get(keys.attempt(SID, qid('doc1', 'qcm', 1), '2026-12-01'))).toBeUndefined(); // aucun essai enregistre
    t.clk.advance(1000);
    expect(await answer(t, ctx, qid('doc1', 'qcm', 1), good)).toMatchObject({ correct: true, xpGained: 5 }); // la question n'a pas ete « brulee »
  });
  it('trou: la rafale ne permet pas de deviner le mot', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 1, nGap: 1 });
    await getSession(t.deps, ctx, 'doc1', '20');
    const seen = new Set<string>();
    for (const w of ['faux', 'energie', 'autre']) {
      t.clk.advance(200);
      seen.add(await answer(t, ctx, qid('doc1', 'gap', 1), w).then((r) => JSON.stringify(r), (e: HttpError) => `${e.status}`));
    }
    expect([...seen]).toEqual(['429']);
  });
  it('Q1: sans session ouverte, une reponse est refusee (409), rien n\'est ecrit', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await rejects(answer(t, ctx, qid('doc1', 'qcm', 1), good), 409);
    expect(await t.store.get(keys.profile(SID))).toBeUndefined();
    expect(await t.store.query(`STUDENT#${SID}`, 'ATT#')).toHaveLength(0);
    expect(await t.store.query(`STUDENT#${SID}`, 'TEST#')).toHaveLength(0);
  });
  it('serie de 10 en moins de 20 s: aucun bonus; en 25 s: +20, et +30 si parfaite sur des affirmations verifiees', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    const quick = await play(t, ctx, 10, 1500); // 15 s
    expect(quick.map((r) => r.xpGained)).toEqual(Array(10).fill(5));
    const t2 = testDeps();
    const s2 = await seed(t2);
    const slow = await play(t2, s2.ctx, 10, 2500); // 25 s
    expect(slow.map((r) => r.xpGained)).toEqual([5, 5, 5, 5, 5, 5, 5, 5, 5, 5 + 20 + 30]);
    expect((await profile(t2)).perfectSeries).toBe(1);
  });
  it('serie terminee mais imparfaite: +20 seulement; affirmation en erreur: pas de bonus parfait', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await getSession(t.deps, ctx, 'doc1', '20');
    const xp: number[] = [];
    for (let i = 1; i <= 10; i++) {
      t.clk.advance(2500);
      xp.push((await answer(t, ctx, qid('doc1', 'qcm', i), i === 4 ? 'A' : good)).xpGained);
    }
    expect(xp[9]).toBe(5 + 20);
    const t2 = testDeps();
    const s2 = await seed(t2, { badClaims: [3] });
    const r = await play(t2, s2.ctx, 10, 2500);
    expect(r[9].xpGained).toBe(5 + 20); // question 3 porte sur une affirmation « erreur »
    expect((await profile(t2)).perfectSeries).toBe(0);
    const t3 = testDeps();
    const s3 = await seed(t3);
    await t3.store.remove(keys.verdict('doc1', 5)); // pas de verdict: considere non verifie
    expect((await play(t3, s3.ctx, 10, 2500))[9].xpGained).toBe(5 + 20);
  });
  it('sans session ouverte aujourd\'hui, les reponses ne comptent pas pour la serie de 10 (critere des 20 s)', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    t.clk.set('2026-12-01T23:30:00+01:00');
    await getSession(t.deps, ctx, 'doc1', '20'); // session ouverte hier soir
    t.clk.advance(60 * 60_000); // apres minuit, moins de 3 h plus tard
    const xp: number[] = [];
    for (let i = 1; i <= 10; i++) {
      t.clk.advance(2500);
      xp.push((await answer(t, ctx, qid('doc1', 'qcm', i), good)).xpGained);
    }
    expect(xp).toEqual(Array(10).fill(5)); // pas de +20 ni +30
    expect((await profile(t)).series.n).toBe(0);
  });
  it('rejouer les memes questions ne fabrique pas de series', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await play(t, ctx, 5, 2500);
    const again = await play(t, ctx, 5, 2500); // memes questions 1 a 5
    expect(again.every((r) => r.xpGained === 0)).toBe(true);
    expect((await profile(t)).series.n).toBe(0); // le compteur est reparti a 0 avec la nouvelle session
  });
  it('affirmation au numero illisible: traitee comme non verifiee', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await t.store.commit([{ item: { ...keys.qcm('doc1', 1), questionId: 'doc1:qcm:01', enonce: 'Q', choix: ['A', 'B', 'C', 'D'], cle: 1, claimId: 'abc' }, when: 'any' }]);
    const r = await play(t, ctx, 10, 2500);
    expect(r[9].xpGained).toBe(5 + 20);
  });
  it('plafond de 250 XP par jour: on peut repondre, on ne gagne plus', async () => {
    const t = testDeps();
    const { ctx } = await seedMany(t, 60);
    let total = 0;
    await openWide(t, ctx, 60);
    for (let i = 1; i <= 60; i++) {
      t.clk.advance(2500);
      const r = await answer(t, ctx, gq(i), good);
      total += r.xpGained;
      expect(r.correct).toBe(true);
    }
    expect(total).toBe(250);
    expect((await profile(t)).xp).toBe(250);
  });
  it('plus de 100 bonnes reponses en 10 minutes: gains en quarantaine pour la journee', async () => {
    const t = testDeps();
    const { ctx } = await seedMany(t, 100);
    await seed(t, { docId: 'g1', nQcm: 0, nGap: 5 });
    await openWide(t, ctx, 99, [1, 2, 3, 4].map((k) => qid('g1', 'gap', k)));
    const next = async (q: string, choice: string) => {
      t.clk.advance(1100);
      return answer(t, ctx, q, choice);
    };
    for (let i = 1; i <= 99; i++) await next(gq(i), good);
    await next(qid('g1', 'gap', 1), 'energie'); // 100e: pas encore plus de 100
    expect((await profile(t)).quarantineDay).toBeUndefined();
    await next(qid('g1', 'gap', 2), 'energie'); // 101e: quarantaine
    const p = await profile(t);
    expect(p.quarantineDay).toBe('2026-12-01');
    expect(p.xp).toBe(250); // plafond atteint avant la rafale, quarantaine ou non
    await next(qid('g1', 'gap', 3), 'energie');
    expect((await profile(t)).quarantineXp).toBeGreaterThan(0); // gains comptes mais non credites
    // Le lendemain la quarantaine est levee.
    t.clk.advance(24 * 3600 * 1000);
    await openWide(t, ctx, 0, [qid('g1', 'gap', 4)]);
    t.clk.advance(2000);
    expect((await answer(t, ctx, qid('g1', 'gap', 4), 'energie')).xpGained).toBe(5);
  });
  it('100 bonnes reponses espacees de plus de 10 minutes ne declenchent rien', async () => {
    const t = testDeps();
    const { ctx } = await seedMany(t, 12);
    await openWide(t, ctx, 12);
    for (let i = 1; i <= 12; i++) {
      t.clk.advance(11 * 60_000); // 12 reponses en 132 min: sous les 3 h d'un test
      await answer(t, ctx, gq(i), good);
    }
    expect((await profile(t)).quarantineDay).toBeUndefined();
    expect((await profile(t)).recent).toHaveLength(1);
  });
  it('deux reponses simultanees a la meme question ne paient qu\'une fois', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(3000);
    const r = await Promise.allSettled([answer(t, ctx, qid('doc1', 'qcm', 1), good), answer(t, ctx, qid('doc1', 'qcm', 1), good)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await profile(t)).xp).toBe(5);
  });
  it('conflit persistant: 409', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    t.store.failNextCommits(3);
    await rejects(getSession(t.deps, ctx, 'doc1', '20'), 409);
  });
});

describe('series de jours, gels, bonus de pages', () => {
  /** Gagne 30 XP (6 bonnes reponses) a la date donnee. */
  async function validDay(t: TestEnv, ctx: Parameters<typeof postAnswer>[1], iso: string, from: number) {
    t.clk.set(iso);
    await openWide(t, ctx, 80);
    for (let i = from; i < from + 6; i++) {
      t.clk.advance(2000);
      await answer(t, ctx, gq(i), good);
    }
  }
  it('un jour compte a partir de 30 XP; jours de suite = serie; un trou consomme un gel; sans gel la serie repart', async () => {
    const t = testDeps();
    const { ctx } = await seedMany(t, 80);
    await openWide(t, ctx, 80);
    for (let i = 1; i <= 5; i++) {
      t.clk.advance(2000);
      await answer(t, ctx, gq(i), good); // 25 XP: pas encore valide
    }
    expect((await profile(t)).streak).toBe(0);
    t.clk.advance(2000);
    await answer(t, ctx, gq(6), good);
    expect((await profile(t)).streak).toBe(1);
    await validDay(t, ctx, '2026-12-02T10:00:00+01:00', 7);
    expect((await profile(t)).streak).toBe(2);
    // 2 jours manques (3 et 4): 2 gels consommes, la serie continue.
    await validDay(t, ctx, '2026-12-05T10:00:00+01:00', 13);
    let p = await profile(t);
    expect([p.streak, p.freezes]).toEqual([3, 0]);
    // 1 jour manque (6) sans gel: la serie repart de 1.
    await validDay(t, ctx, '2026-12-07T10:00:00+01:00', 19);
    p = await profile(t);
    expect([p.streak, p.freezes]).toEqual([1, 0]);
    // Affichage: serie vivante hier ou aujourd'hui, perdue apres un trou sans gel.
    expect(effectiveStreak(p, '2026-12-08')).toBe(1);
    expect(effectiveStreak(p, '2026-12-10')).toBe(0);
    expect(effectiveStreak({ ...p, freezes: 2 }, '2026-12-10')).toBe(1);
    expect(effectiveStreak({ ...p, lastValidDay: undefined }, '2026-12-10')).toBe(0);
  });
  it('les gels sont remis a 2 au changement de mois', async () => {
    const t = testDeps();
    const { ctx } = await seedMany(t, 80);
    await validDay(t, ctx, '2026-12-30T10:00:00+01:00', 1);
    await validDay(t, ctx, '2027-01-04T10:00:00+01:00', 7); // 4 jours manques > 2 gels: la serie repart de 1
    const p = await profile(t);
    expect(p.freezes).toBe(2);
    expect(p.streak).toBe(1);
    expect(p.freezeMonth).toBe('2027-01');
  });
  it('7 jours de suite: badge serie_7 et +2 pages, plafonnees a +6 par famille et par mois', async () => {
    const t = testDeps({ iso: '2026-12-01T10:00:00+01:00' });
    const { ctx } = await seedMany(t, 80);
    for (let d = 0; d < 7; d++) {
      await validDay(t, ctx, `2026-12-0${1 + d}T10:00:00+01:00`, 1 + d * 6);
    }
    expect((await profile(t)).streak).toBe(7);
    expect((await profile(t)).badges).toContain('serie_7');
    const item = (t.quota as unknown as { items: Map<string, Record<string, number>> }).items.get(`FAMILY#${FID}|QUOTA#2026-12#${SID}`);
    expect(item?.bonus).toBe(2);
    // Plafond famille: 6 par mois.
    expect(await grantStreakBonus(t.deps, FID, SID, '2026-12')).toBe(2);
    expect(await grantStreakBonus(t.deps, FID, SID, '2026-12')).toBe(2);
    expect(await grantStreakBonus(t.deps, FID, SID, '2026-12')).toBe(0);
    expect(await grantStreakBonus(t.deps, FID, SID, '2027-01')).toBe(2); // nouveau mois
    expect(await grantStreakBonus(t.deps, 'inconnue', SID, '2026-12')).toBe(0);
  });
  it('bonus: conflit persistant sur le compteur de la famille = 0 page', async () => {
    const t = testDeps();
    await seed(t);
    t.store.failNextCommits(3);
    expect(await grantStreakBonus(t.deps, FID, SID, '2026-12')).toBe(0);
  });
});

describe('read: XP de lecture de la fiche (option b)', () => {
  it('10 XP par page consommee, 2 pages payees par jour, une seule fois par fiche et par jour', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { pages: 3 });
    const r = await markRead(t.deps, ctx, 'doc1');
    expect(r.xpGained).toBe(20); // 3 pages consommees, 2 payees
    expect(r.badges).toEqual(['premier_scan']);
    expect((await markRead(t.deps, ctx, 'doc1')).xpGained).toBe(0);
    expect((await markRead(t.deps, ctx, 'doc1')).badges).toEqual([]);
    // Une seconde fiche le meme jour: les 2 pages du jour sont deja payees.
    await t.store.commit([{ item: { ...keys.doc(SID, 'doc2'), titre: 'T2', matiere: 'maths', pagesConsommees: 1, doublon: false, createdAt: t.clk.now().toISOString() }, when: 'any' }]);
    expect((await markRead(t.deps, ctx, 'doc2')).xpGained).toBe(0);
  });
  it('une page puis une autre fiche: les 2 pages du jour se partagent', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { pages: 1 });
    await t.store.commit([{ item: { ...keys.doc(SID, 'doc2'), titre: 'T2', matiere: 'maths', pagesConsommees: 4, doublon: false, createdAt: t.clk.now().toISOString() }, when: 'any' }]);
    expect((await markRead(t.deps, ctx, 'doc1')).xpGained).toBe(10);
    expect((await markRead(t.deps, ctx, 'doc2')).xpGained).toBe(10);
  });
  it('doublon ou 0 page consommee: pas d\'XP de scan', async () => {
    const t = testDeps();
    const a = await seed(t, { doublon: true });
    expect((await markRead(t.deps, a.ctx, 'doc1')).xpGained).toBe(0);
    const t2 = testDeps();
    const b = await seed(t2, { pages: 0 });
    expect((await markRead(t2.deps, b.ctx, 'doc1')).xpGained).toBe(0);
    const t3 = testDeps();
    const c = await seed(t3);
    await t3.store.commit([{ item: { ...keys.doc(SID, 'doc1'), titre: 'T', matiere: 'svt', createdAt: t3.clk.now().toISOString() }, when: 'any' }]); // pagesConsommees absent
    expect((await markRead(t3.deps, c.ctx, 'doc1')).xpGained).toBe(0);
  });
  it('revoir la fiche un autre jour: 8 XP, une fois par jour; date illisible: revue aussi', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { createdAt: '2026-11-20T10:00:00+01:00' });
    expect((await markRead(t.deps, ctx, 'doc1')).xpGained).toBe(8);
    expect((await markRead(t.deps, ctx, 'doc1')).xpGained).toBe(0);
    t.clk.advance(24 * 3600 * 1000);
    expect((await markRead(t.deps, ctx, 'doc1')).xpGained).toBe(8);
    const t2 = testDeps();
    const b = await seed(t2, { createdAt: 'pas une date' });
    expect((await markRead(t2.deps, b.ctx, 'doc1')).xpGained).toBe(8);
    await rejects(markRead(t2.deps, b.ctx, 'inconnue'), 404);
  });
  it('conflit persistant: 409', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    t.store.failNextCommits(3);
    await rejects(markRead(t.deps, ctx, 'doc1'), 409);
  });
});

describe('badges renvoyes: seulement ceux du catalogue (docs/game-rules.md)', () => {
  it('le catalogue du code est celui de la documentation', () => {
    const md = readFileSync(new URL('../../../docs/game-rules.md', import.meta.url), 'utf8');
    const section = md.split('## 4. Badges')[1].split('## 5.')[0];
    const ids = [...section.matchAll(/`([a-z0-9_]+)`/g)].map((m) => m[1]).filter((i) => i !== 'Progress' && !i.includes('badges'));
    expect([...new Set(ids)].sort()).toEqual([...BADGE_IDS].sort());
  });
  it('answers-post et read ne renvoient que des identifiants du catalogue', async () => {
    const t = testDeps();
    const { ctx } = await seed(t, { nQcm: 15 });
    const all: string[] = [];
    all.push(...(await markRead(t.deps, ctx, 'doc1')).badges);
    for (const r of await play(t, ctx, 10, 2500)) all.push(...r.badges, ...(r.progress.badges ?? []));
    expect(all).toContain('premier_scan');
    expect(all.every(isBadge)).toBe(true);
  });
  it('100 bonnes reponses, 5 matieres du mois et 500 XP dans une matiere', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    const p0 = { xp: 0, correct: 99, perfectSeries: 0, validReports: 0, readFirst: true, streak: 0, freezes: 2, freezeMonth: '2026-12', badges: ['premier_scan'], xpBySubject: { svt: 495 }, subjects: { month: '2026-12', list: ['maths', 'physique', 'svt', 'francais'] }, series: { n: 0, perfect: true, risky: false }, recent: [], quarantineXp: 0 };
    await t.store.commit([{ item: { ...keys.profile(SID), ...p0 }, when: 'any' }]);
    await getSession(t.deps, ctx, 'doc1', '20');
    t.clk.advance(2000);
    const r = await answer(t, ctx, qid('doc1', 'qcm', 1), good);
    expect(r.badges.sort()).toEqual(['cent_bonnes_reponses', 'maitre_svt']);
    expect((await profile(t)).subjects.list).toContain('svt');
    // Une autre matiere dans le meme mois: 5e matiere, le badge arrive.
    await t.store.commit([{ item: { ...keys.doc(SID, 'doc9'), titre: 'T9', matiere: 'histoire_geo', pagesConsommees: 1, doublon: false, createdAt: '2026-11-01T10:00:00+01:00' }, when: 'any' }]);
    const rr = await markRead(t.deps, ctx, 'doc9');
    expect(rr.badges).toEqual(['explorateur']);
    expect(rr.progress.badges).toEqual(expect.arrayContaining(['explorateur', 'premier_scan']));
  });
  it('un nouveau mois repart a zero pour l\'explorateur', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    await t.store.commit([{ item: { ...keys.profile(SID), xp: 0, correct: 0, perfectSeries: 0, validReports: 0, readFirst: false, streak: 0, freezes: 2, freezeMonth: '2026-11', badges: [], xpBySubject: {}, subjects: { month: '2026-11', list: ['a', 'b', 'c', 'd', 'e'] }, series: { n: 0, perfect: true, risky: false }, recent: [], quarantineXp: 0 }, when: 'any' }]);
    const r = await markRead(t.deps, ctx, 'doc1');
    expect(r.badges).not.toContain('explorateur');
    expect((await profile(t)).subjects).toEqual({ month: '2026-12', list: ['svt'] });
  });
});

describe('lectures: profil, tableau de bord, classement', () => {
  it('progression: quota restant, remise a zero le 1er du mois, mascotte', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    const p = await getProgress(t.deps, ctx);
    expect(p).toMatchObject({ xp: 0, level: 0, stage: 1, streakDays: 0, freezes: 2, pagesRemaining: 20, pagesLimit: 20, resetDate: '2027-01-01', badges: [] });
    await t.store.commit([{ item: { ...keys.quota(FID, '2026-12', SID), limite: 20, restant: 14 }, when: 'any' }]);
    expect((await getProgress(t.deps, ctx)).pagesRemaining).toBe(14);
    const dev = testDeps({ env: 'dev' });
    const d = await seed(dev);
    await dev.store.commit([{ item: { ...keys.student(FID, SID), pseudo: 'x', niveau: 'seconde', statut: 'actif', cognitoSub: 'sub-stu1' }, when: 'any' }]); // pas de quotaPages
    expect((await getProgress(dev.deps, d.ctx)).pagesLimit).toBe(200);
  });
  it('/me: parent, eleve, parent sans famille, sans role', async () => {
    const t = testDeps();
    const { ctx } = await seed(t);
    expect(await getMe(t.deps, { sub: 'p', username: 'par1', role: 'parent', familyId: FID })).toEqual({ userId: 'p', role: 'parent', familyId: FID, policyOutdated: true }) // famille de test sans version de politique enregistree;
    expect(await getMe(t.deps, { sub: ctx.sub, username: SID, role: 'eleve', familyId: FID })).toEqual({ userId: ctx.sub, role: 'eleve', familyId: FID, studentId: SID, pseudo: 'Pseudo-1abc' });
    await rejects(getMe(t.deps, { sub: 'p', username: 'par1', role: 'parent' }), 404);
    await rejects(getMe(t.deps, { sub: 'p', username: 'x' }), 404); // admin seul ou parent invite sans famille: profil absent
    await rejects(getMe(t.deps, { sub: 'p', username: 'x', conflicting: true }), 403); // parent + eleve
    await rejects(getMe(t.deps, { sub: 'p', username: 'x', familyId: FID }), 403); // famille sans role
    await rejects(getMe(t.deps, { sub: 'x', username: SID, role: 'eleve', familyId: FID }), 403);
  });
  it('tableau de bord: eleves de la famille seulement, quota famille', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    const d = await getDashboard(t.deps, { sub: 'p', username: 'par1', familyId: FID });
    expect(d.students.map((s) => s.student.studentId)).toEqual([SID]);
    expect(d).toMatchObject({ familyPagesRemaining: 50, familyPagesLimit: 50 });
    expect(JSON.stringify(d)).not.toContain('cognitoSub');
    await t.store.commit([{ item: { ...keys.quotaFamily(FID, '2026-12'), limite: 50, restant: 31 }, when: 'any' }]);
    expect((await getDashboard(t.deps, { sub: 'p', username: 'par1', familyId: FID })).familyPagesRemaining).toBe(31);
    const empty = testDeps();
    expect(await getDashboard(empty.deps, { sub: 'p', username: 'p', familyId: 'vide' })).toMatchObject({ students: [], familyPagesLimit: 50 });
  });
  it('classement: semaine en cours, au moins 3 jours actifs, tri par XP, famille isolee', async () => {
    const t = testDeps();
    await seed(t);
    const wk = (fid: string, sid: string, xp: number, days: string[]) => t.store.commit([{ item: { ...keys.week(fid, '2026-W49', sid), xp, days }, when: 'any' }]);
    await seed(t, { sid: 'stu3', docId: 'd3' });
    await t.store.commit([{ item: { ...keys.student(FID, 'stu3'), pseudo: 'Autre-9zzz', niveau: 'seconde', statut: 'actif', cognitoSub: 'sub-stu3' }, when: 'any' }]);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await wk(FID, SID, 100, ['2026-11-30', '2026-12-01', '2026-12-02']);
    await wk(FID, 'stu3', 300, ['2026-11-30', '2026-12-01', '2026-12-02', '2026-12-03']);
    await wk('fam2', 'stu2', 999, ['a', 'b', 'c']);
    await t.store.commit([{ item: { ...keys.week(FID, '2026-W49', 'fantome'), xp: 500, days: ['a', 'b', 'c'] }, when: 'any' }, { item: { ...keys.week(FID, '2026-W49', 'peu'), xp: 400, days: ['a'] }, when: 'any' }, { item: { ...keys.week(FID, '2026-W49', 'nodays'), xp: 400 }, when: 'any' }, { item: { ...keys.week(FID, '2026-W48', SID), xp: 800, days: ['a', 'b', 'c'] }, when: 'any' }]);
    const lb = await getLeaderboard(t.deps, FID);
    expect(lb.week).toBe('2026-W49');
    expect(lb.entries).toEqual([
      { studentId: 'stu3', pseudo: 'Autre-9zzz', xp: 300, activeDays: 4 },
      { studentId: SID, pseudo: 'Pseudo-1abc', xp: 100, activeDays: 3 },
    ]);
  });
  it('classement: un eleve suspendu ou d\'un autre compte est refuse', async () => {
    const t = testDeps();
    const a = await seed(t);
    expect((await getLeaderboard(t.deps, FID, a.ctx)).entries).toEqual([]);
    await rejects(getLeaderboard(t.deps, FID, { ...a.ctx, sub: 'autre' }), 403);
    await t.store.commit([{ item: { ...keys.student(FID, SID), pseudo: 'x', niveau: 'seconde', statut: 'suspendu', cognitoSub: a.ctx.sub }, when: 'any' }]);
    await rejects(getLeaderboard(t.deps, FID, a.ctx), 403);
  });
  it('classement: a egalite, ordre alphabetique des pseudos', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { sid: 'stu3', docId: 'd3' });
    await t.store.commit([{ item: { ...keys.student(FID, 'stu3'), pseudo: 'Aaa-1111', niveau: 'seconde', statut: 'actif', cognitoSub: 'x' }, when: 'any' }]);
    for (const s of [SID, 'stu3']) await t.store.commit([{ item: { ...keys.week(FID, '2026-W49', s), xp: 50, days: ['a', 'b', 'c'] }, when: 'any' }]);
    expect((await getLeaderboard(t.deps, FID)).entries.map((e) => e.pseudo)).toEqual(['Aaa-1111', 'Pseudo-1abc']);
  });
});

describe('credit d\'XP', () => {
  it('quarantaine: l\'XP est compte a part, jamais credite; plafond: jamais au-dela de 250', async () => {
    const t = testDeps();
    await seed(t);
    const st = await loadState(t.deps, FID, SID);
    st.profile.quarantineDay = st.today;
    expect(credit(st, 30, 'svt')).toEqual({ gained: 0, streakBonus: false });
    expect([st.profile.xp, st.profile.quarantineXp, st.day.valid]).toEqual([0, 30, false]);
    st.profile.quarantineDay = undefined;
    st.day.xp = 245;
    expect(credit(st, 30, 'svt').gained).toBe(5);
    expect(credit(st, 30, 'svt').gained).toBe(0);
    expect(st.profile.xp).toBe(5);
  });
});
