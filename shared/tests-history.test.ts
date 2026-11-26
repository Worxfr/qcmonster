import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import {
  MAX_ITEMS, TEST_ID_RE, decodeCursor, encodeCursor, isoSeconds, newTestId, parisDayStartUtc, recount, schoolYearBounds, schoolYearOf, scorePct, testIdStartedAt, testIdTime, toSummary, upsertLine, validDay, type TestLine,
} from './tests-history.js';

describe('schoolYearOf: les 6 cas de docs/H1-design.md section 3', () => {
  it.each([
    ['2026-09-01T00:00:00+02:00', '2026-2027'],
    ['2026-12-31T23:59:00+01:00', '2026-2027'],
    ['2027-01-01T00:00:00+01:00', '2026-2027'],
    ['2027-08-31T23:59:00+02:00', '2026-2027'],
    ['2027-09-01T00:00:00+02:00', '2027-2028'],
    ['2026-08-31T21:30:00Z', '2025-2026'], // 23:30 a Paris le 31 aout
  ])('%s -> %s', (iso, sy) => expect(schoolYearOf(new Date(iso))).toBe(sy));
  it('le 31 aout 22:30 UTC est deja le 1er septembre a Paris (changement d\'annee)', () => expect(schoolYearOf(new Date('2026-08-31T22:30:00Z'))).toBe('2026-2027'));
});

describe('bornes en heure de Paris', () => {
  it('ete et hiver', () => {
    expect(parisDayStartUtc('2026-09-01')).toBe('2026-08-31T22:00:00Z');
    expect(parisDayStartUtc('2026-12-01')).toBe('2026-11-30T23:00:00Z');
    expect(parisDayStartUtc('2027-03-28')).toBe('2027-03-27T23:00:00Z'); // changement d'heure le jour meme (a 02:00 locales)
  });
  it('annee scolaire: [1er sept. 00:00 Paris, 1er sept. suivant[', () => {
    expect(schoolYearBounds('2026-2027')).toEqual({ from: '2026-08-31T22:00:00Z', to: '2027-08-31T22:00:00Z' });
    expect(schoolYearBounds('2026-2028')).toBeUndefined();
    expect(schoolYearBounds('abcd')).toBeUndefined();
  });
  it('validDay refuse les dates impossibles', () => {
    expect(validDay('2026-02-30')).toBeUndefined();
    expect(validDay('2026-02-28')).toBe('2026-02-28');
    expect(validDay('26-02-28')).toBeUndefined();
  });
});

describe('testId et curseur', () => {
  it('le temps du testId redonne la cle (seconde entiere)', () => {
    const ms = Date.parse('2026-12-01T17:02:11.456Z');
    const id = newTestId(ms);
    expect(id).toHaveLength(26);
    expect(testIdTime(id)).toBe(ms);
    expect(testIdStartedAt(id)).toBe(isoSeconds(ms));
    expect(testIdStartedAt(id)).toBe('2026-12-01T17:02:11Z');
  });
  it('un identifiant mal forme n\'a pas de temps', () => {
    for (const bad of ['', 'x', 'id0001', '01JEXAMPLE0TEST000000000AA', 'U'.repeat(26), '../../PROFILE']) expect(testIdTime(bad)).toBeUndefined();
  });
  it('curseur: aller-retour, et tout ce qui n\'est pas une cle de passage est refuse', () => {
    const sk = `TEST#2026-12-01T17:02:11Z#${newTestId(Date.parse('2026-12-01T17:02:11Z'))}`;
    expect(decodeCursor(encodeCursor(sk))).toBe(sk);
    for (const bad of ['STUDENT#autre', 'PROFILE', 'TEST#', `TEST#x#${'0'.repeat(26)}`, 'TEST#2026-12-01T17:02:11Z#../STUDENT#autre']) expect(decodeCursor(encodeCursor(bad)), bad).toBeUndefined();
    expect(decodeCursor('!!!')).toBeUndefined();
    expect(decodeCursor('A'.repeat(513))).toBeUndefined();
  });
});

describe('lignes et score', () => {
  const a = (o: Partial<Parameters<typeof upsertLine>[1]> = {}) => ({ q: 'd:qcm:01', rank: 1, k: 'qcm' as const, correct: true, xp: 5, at: '2026-12-01T10:00:00Z', choice: 'x', ...o });
  it('score arrondi', () => {
    expect(scorePct(8, 10)).toBe(80);
    expect(scorePct(1, 3)).toBe(33);
    expect(scorePct(2, 3)).toBe(67);
    expect(scorePct(0, 0)).toBe(0);
  });
  it('2e essai: la ligne continue, premier coup conserve', () => {
    let l = upsertLine([], a({ correct: false, xp: 0 }));
    expect(l[0]).toMatchObject({ ok: false, n: 1, f: false });
    l = upsertLine(l, a({ correct: true, xp: 3 }));
    expect(l).toHaveLength(1);
    expect(l[0]).toMatchObject({ ok: true, n: 2, f: false, xp: 3 });
    expect(recount(l)).toEqual({ answered: 1, correct: 1, firstTry: 0, xpGained: 3 });
  });
  it('question terminee puis rejouee: repart a 1 essai, XP gardee', () => {
    let l = upsertLine([], a());
    l = upsertLine(l, a({ correct: false, xp: 0 }));
    expect(l[0]).toMatchObject({ ok: false, n: 1, f: false, xp: 5 });
  });
  it(`au plus ${MAX_ITEMS} lignes et reponse coupee a 300 caracteres`, () => {
    let l: TestLine[] = [];
    for (let i = 1; i <= 25; i++) l = upsertLine(l, a({ q: `d:qcm:${i}`, rank: i, choice: 'z'.repeat(400) }));
    expect(l).toHaveLength(MAX_ITEMS);
    expect(l[0].c).toHaveLength(300);
  });
  it('le resume n\'a que les champs du contrat (pas de lignes, pas de reponses)', () => {
    const s = toSummary({ docId: 'd', titre: 't', matiere: 'svt', mode: 'mixte', anneeScolaire: '2026-2027', startedAt: 's', total: 4, answered: 4, correct: 3, firstTry: 2, xpGained: 9, items: [{ c: 'secret' }], PK: 'STUDENT#x' }, 'ID');
    expect(JSON.stringify(s)).not.toMatch(/secret|STUDENT|items/);
    expect(s).toMatchObject({ scorePct: 75, status: 'complet', schoolYear: '2026-2027' });
  });
});

describe('exemples du contrat', () => {
  it('chaque testId d\'exemple est un identifiant de passage valide, et le curseur d\'exemple une cle valide', () => {
    const y = readFileSync(new URL('./contract/openapi.yaml', import.meta.url), 'utf8');
    const ids = [...y.matchAll(/testId: ([0-9A-Z]{26})/g)].map((m) => m[1]);
    expect(ids.length).toBeGreaterThan(3);
    for (const id of ids) expect(id).toMatch(TEST_ID_RE);
    const cur = /nextCursor: (\S+)\n/.exec(y)?.[1] ?? '';
    expect(decodeCursor(cur)).toBeDefined();
  });
});
