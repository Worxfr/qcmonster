import { describe, expect, it } from 'vitest';
import { BADGE_IDS, earned, isBadge } from './badges.js';
import { levelOf, normalizeGap, stageOf } from './rules.js';
import { addDays, daysBetween, isoWeek, parisDate, parisMonth, resetDate } from './time.js';

describe('niveaux et stades', () => {
  it('seuils 25 x n x (n + 1)', () => {
    expect(levelOf(-1)).toBe(0);
    expect(levelOf(Number.NaN)).toBe(0);
    expect(levelOf(0)).toBe(0);
    expect(levelOf(49)).toBe(0);
    expect([50, 149, 150, 299, 300, 499, 500, 749, 750].map(levelOf)).toEqual([1, 1, 2, 2, 3, 3, 4, 4, 5]);
    expect(levelOf(2750)).toBe(10);
    expect(levelOf(2749)).toBe(9);
    expect(levelOf(10500)).toBe(20);
    expect(levelOf(10499)).toBe(19);
  });
  it('stades de la mascotte', () => {
    expect([0, 1, 4, 5, 9, 10, 19, 20, 50].map(stageOf)).toEqual([1, 2, 2, 3, 3, 4, 4, 5, 5]);
  });
});

describe('texte a trous', () => {
  it('minuscules, accents, espaces et ponctuation de bord', () => {
    expect(normalizeGap('  Énergie. ')).toBe('energie');
    expect(normalizeGap('«Photo   synthèse»!')).toBe('photo synthese');
    expect(normalizeGap('énergies')).not.toBe(normalizeGap('energie')); // aucune tolerance de faute
  });
});

describe('dates (Europe/Paris)', () => {
  it('jour et mois du serveur, pas UTC', () => {
    expect(parisDate(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01-01'); // minuit passe a Paris
    expect(parisMonth(new Date('2026-12-31T23:30:00Z'))).toBe('2027-01');
    expect(parisDate(new Date('2026-07-01T21:59:00Z'))).toBe('2026-07-01');
    expect(parisDate(new Date('2026-07-01T22:00:00Z'))).toBe('2026-07-02'); // ete: UTC+2
  });
  it('semaines ISO', () => {
    expect(isoWeek('2026-11-30')).toBe('2026-W49'); // lundi
    expect(isoWeek('2026-12-06')).toBe('2026-W49'); // dimanche
    expect(isoWeek('2026-12-07')).toBe('2026-W50');
    expect(isoWeek('2027-01-01')).toBe('2026-W53');
    expect(isoWeek('2024-12-30')).toBe('2025-W01');
    expect(isoWeek('2026-01-01')).toBe('2026-W01');
  });
  it('arithmetique de jours et remise a zero du quota', () => {
    expect(daysBetween('2026-02-27', '2026-03-02')).toBe(3);
    expect(addDays('2026-12-31', 1)).toBe('2027-01-01');
    expect(resetDate('2026-12-15')).toBe('2027-01-01');
    expect(resetDate('2026-03-31')).toBe('2026-04-01');
  });
});

describe('badges', () => {
  const base = { readFirst: false, streak: 0, correct: 0, perfectSeries: 0, validReports: 0, subjectsThisMonth: 0, xpBySubject: {} };
  it('conditions du catalogue', () => {
    expect(earned(base)).toEqual([]);
    expect(earned({ ...base, readFirst: true })).toEqual(['premier_scan']);
    expect(earned({ ...base, streak: 7 })).toEqual(['serie_7']);
    expect(earned({ ...base, streak: 30 })).toEqual(['serie_7', 'serie_30']);
    expect(earned({ ...base, correct: 100 })).toEqual(['cent_bonnes_reponses']);
    expect(earned({ ...base, perfectSeries: 5 })).toEqual(['serie_parfaite_x5']);
    expect(earned({ ...base, validReports: 1 })).toEqual(['chasseur_d_erreurs']);
    expect(earned({ ...base, subjectsThisMonth: 5 })).toEqual(['explorateur']);
    expect(earned({ ...base, xpBySubject: { svt: 500, autre: 900, maths: 499 } })).toEqual(['maitre_svt']);
  });
  it('isBadge', () => {
    expect(BADGE_IDS.every(isBadge)).toBe(true);
    expect(isBadge('inconnu')).toBe(false);
  });
});
