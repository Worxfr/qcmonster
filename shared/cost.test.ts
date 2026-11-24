import { describe, expect, it } from 'vitest';
import { costGate } from './cost.js';
import { costEur } from './pricing.js';

describe('compteur de cout', () => {
  it('seuils 15 EUR (bloque les nouveaux scans) et 18 EUR (arrete tout)', () => {
    expect(costGate(14.99)).toBe('ok');
    expect(costGate(15)).toBe('block_new');
    expect(costGate(17.99)).toBe('block_new');
    expect(costGate(18)).toBe('stop_all');
  });
  it('conversion tokens vers euros (scenario D, jugement Sonnet 10000/1500)', () => {
    // S(10 000 ; 1 500) = 0,0385 $ ; / 1,0963 = 0,03512 EUR
    expect(costEur('sonnet-5.5', { inputTokens: 10000, outputTokens: 1500 })).toBeCloseTo(0.0351, 4);
  });
});
