import { describe, expect, it } from 'vitest';
import { doubtRate, iou, measureBoxes } from './figures.js';

describe('mesure des cadres de figures', () => {
  it('iou: identique 1, disjoint 0, moitie 1/3', () => {
    expect(iou([0.1, 0.1, 0.4, 0.4], [0.1, 0.1, 0.4, 0.4])).toBe(1);
    expect(iou([0, 0, 0.2, 0.2], [0.5, 0.5, 0.2, 0.2])).toBe(0);
    expect(iou([0, 0, 0.4, 0.4], [0.2, 0, 0.4, 0.4])).toBeCloseTo(1 / 3);
  });
  it('sous 70 % de cadres corrects: Sonnet d\'abord; une page entiere n\'est jamais correcte', () => {
    const t: [number, number, number, number] = [0.1, 0.1, 0.5, 0.5];
    const ok = { proposed: t, truth: t };
    expect(measureBoxes([ok, ok, ok, { proposed: [0.6, 0.6, 0.3, 0.3], truth: t }])).toMatchObject({ correct: 3, rate: 0.75, sonnetFirst: false });
    expect(measureBoxes([ok, { truth: t }, { truth: t }])).toMatchObject({ correct: 1, fullPage: 2, sonnetFirst: true });
    expect(measureBoxes([])).toMatchObject({ rate: 0, sonnetFirst: false });
  });
  it('taux de doute', () => {
    expect(doubtRate([{ doubt: true }, {}, {}, {}])).toBe(0.25);
    expect(doubtRate([])).toBe(0);
  });
});
