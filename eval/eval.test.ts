import { describe, expect, it } from 'vitest';
import { loadAnnotation, loadManifest } from './golden.js';
import { computeReport, matchedWords, norm, type PageInput } from './metrics.js';
import { oracleRunner } from './runners.js';
import { quantile, wilson } from './stats.js';

describe('intervalle de Wilson', () => {
  it('donne les valeurs connues pour 20 sur 20 et 75 sur 100', () => {
    const a = wilson(20, 20);
    expect(a.lo).toBeCloseTo(0.8389, 3);
    expect(a.hi).toBe(1);
    const b = wilson(75, 100);
    expect(b.lo).toBeCloseTo(0.6574, 3);
    expect(b.hi).toBeCloseTo(0.8245, 3);
  });
  it("renvoie des valeurs vides sans essai", () => expect(wilson(0, 0).rate).toBeNull());
  it('calcule un quantile interpolé', () => expect(quantile([1, 2, 3, 4], 0.5)).toBe(2.5));
});

describe('mesures', () => {
  it('norm ignore accents, casse et ponctuation', () => expect(norm('Été, À-bientôt!')).toBe('ete a bientot'));
  it('compte les mots retrouvés', () => expect(matchedWords('un deux trois quatre', 'un trois quatre cinq')).toEqual({ matched: 3, total: 4 }));

  it("l'oracle sans raté détecte toutes les erreurs et n'a aucun faux positif sur les pages publiques", async () => {
    const m = loadManifest();
    const runner = oracleRunner();
    const inputs: PageInput[] = [];
    for (const page of m.pages.filter((p) => p.image)) {
      const ann = loadAnnotation({ manifest: m }, page);
      inputs.push({ page, ann, run: await runner.run({ id: page.id, image: Buffer.alloc(0), ann }) });
    }
    const r = computeReport(inputs, [{ refused: true }]);
    expect(r.errorRecall.tuning.rate).toBe(1);
    expect(r.falsePositives.tuning.rate).toBe(0);
    expect(r.anchoring.rate).toBe(1);
    expect(r.ocrWords.rate).toBe(1);
    expect(r.injection.canaryFollowed.k).toBe(0);
    expect(r.checks.recallTuning.ok).toBe(true);
    expect(r.checks.qcmValid.ok).toBeNull();
  });

  it("l'oracle qui rate une erreur sur cinq échoue au seuil de rappel", async () => {
    const m = loadManifest();
    const runner = oracleRunner({ missEvery: 5 });
    const inputs: PageInput[] = [];
    for (const page of m.pages.filter((p) => p.image)) {
      const ann = loadAnnotation({ manifest: m }, page);
      inputs.push({ page, ann, run: await runner.run({ id: page.id, image: Buffer.alloc(0), ann }) });
    }
    const r = computeReport(inputs, []);
    expect(r.errorRecall.tuning.rate).toBeCloseTo(0.8, 1);
    expect(r.errorRecall.tuning.lo).toBeLessThan(r.errorRecall.tuning.rate!);
  });
});
