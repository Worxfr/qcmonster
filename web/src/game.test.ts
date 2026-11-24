import { describe, expect, it } from 'vitest';
import { countPdfPages, levelProgress, levelThreshold, safeUrl, stageName } from './game';

describe('niveaux (design-v2 section 7)', () => {
  it('seuils cumules 50, 150, 300, 500, 750 puis 2750 au niveau 10', () => {
    expect([1, 2, 3, 4, 5].map(levelThreshold)).toEqual([50, 150, 300, 500, 750]);
    expect(levelThreshold(10)).toBe(2750);
    expect(levelThreshold(20)).toBe(10500);
  });
  it('progression vers le niveau suivant', () => {
    expect(levelProgress(110, 1)).toEqual({ from: 50, to: 150, pct: 60, remaining: 40 });
    expect(levelProgress(0, 0)).toMatchObject({ from: 0, to: 50, pct: 0 });
  });
  it('reste entre 0 et 100 %', () => {
    expect(levelProgress(5000, 1).pct).toBe(100);
    expect(levelProgress(0, 3).pct).toBe(0);
  });
});

describe('stades', () => {
  it('nomme les 5 stades et borne les valeurs', () => {
    expect(stageName(1)).toBe('Œuf');
    expect(stageName(5)).toBe('Monstre légendaire');
    expect(stageName(9)).toBe('Monstre légendaire');
  });
});

describe('safeUrl', () => {
  it('accepte http(s) seulement', () => {
    expect(safeUrl('https://fr.wikipedia.org/wiki/X')).toBe('https://fr.wikipedia.org/wiki/X');
    expect(safeUrl('javascript:alert(1)')).toBeNull();
    expect(safeUrl('data:text/html,x')).toBeNull();
    expect(safeUrl('pas une url')).toBeNull();
  });
});

describe('countPdfPages', () => {
  it('compte /Type /Page sans compter /Pages', () => {
    const pdf = '<< /Type /Pages /Count 2 >> << /Type /Page >> << /Type/Page >>';
    expect(countPdfPages(new TextEncoder().encode(pdf))).toBe(2);
  });
});
