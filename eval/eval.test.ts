import { describe, expect, it } from 'vitest';
import { loadAnnotation, loadManifest } from './golden.js';
import { computeReport, matchedWords, norm, type PageInput, type PageRun } from './metrics.js';
import { oracleRunner } from './runners.js';
import { drawSample } from './sample.js';
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

async function publicInputs(runner = oracleRunner()): Promise<PageInput[]> {
  const m = loadManifest();
  const inputs: PageInput[] = [];
  for (const page of m.pages.filter((p) => p.image)) {
    const ann = loadAnnotation({ manifest: m }, page);
    inputs.push({ page, ann, run: await runner.run({ id: page.id, image: Buffer.alloc(0), ann }) });
  }
  return inputs;
}

describe('pages refusées', () => {
  it("restent au dénominateur: refuser une page n'améliore pas le rappel", async () => {
    const inputs = await publicInputs();
    const base = computeReport(inputs, []);
    const refused: PageRun = { refused: true, transcript: '', claims: [] };
    const first = inputs.findIndex((i) => !i.page.hidden && i.page.errors > 0);
    const r = computeReport(inputs.map((i, k) => (k === first ? { ...i, run: refused } : i)), []);
    expect(r.errorRecall.tuning.n).toBe(base.errorRecall.tuning.n);
    expect(r.errorRecall.tuning.k).toBeLessThan(base.errorRecall.tuning.k);
    expect(r.checks.noPageRefusedWrongly.ok).toBe(false);
  });
});

describe('verdict avec et sans injection', () => {
  it("accord complet quand l'injection est sans effet", async () => {
    const inputs = await publicInputs();
    const withTwin = inputs.map((i) => (i.page.injectionCourse ? { ...i, twin: i.run } : i));
    const r = computeReport(withTwin, []);
    expect(r.injection.sameVerdictAsWithoutInjection.course?.rate).toBe(1);
    expect(r.checks.injectionSameVerdictCourse.ok).toBe(true);
  });
  it("détecte un verdict détourné par l'injection", async () => {
    const inputs = await publicInputs();
    const hijacked = (run: PageRun): PageRun => ({ ...run, claims: run.claims.map((c) => ({ ...c, status: 'verifiee' as const })) });
    const withTwin = inputs.map((i) => (i.page.injectionCourse ? { ...i, twin: i.run, run: hijacked(i.run) } : i));
    const r = computeReport(withTwin, []);
    expect(r.injection.sameVerdictAsWithoutInjection.course!.rate!).toBeLessThan(1);
    expect(r.checks.injectionSameVerdictCourse.ok).toBe(false);
  });
});

describe('tirage de relecture', () => {
  it('est reproductible, sans doublon, de la taille demandée', () => {
    const items = Array.from({ length: 300 }, (_, i) => i);
    const a = drawSample(items, 50), b = drawSample(items, 50);
    expect(a).toEqual(b);
    expect(new Set(a).size).toBe(50);
    expect(drawSample(items, 50, 1)).not.toEqual(a);
  });
});

describe("ancrage: l'extrait copié, pas le texte réécrit (V2)", () => {
  const m = loadManifest();
  const page = m.pages.find((p) => p.image)!;
  const ann = loadAnnotation({ manifest: m }, page);
  const run = (claims: PageRun['claims']): PageInput => ({ page, ann, run: { refused: false, transcript: 'Molière est mort en 1673.\nIl est né à Paris.', claims } });
  it("une affirmation réécrite dont l'extrait est dans la transcription est ancrée; l'ancienne mesure la compte comme non ancrée", () => {
    const r = computeReport([run([{ text: "L'auteur du Tartuffe est mort en 1673.", excerpt: 'Molière est mort en 1673', status: 'verifiee' }, { text: 'Il est né à Paris.', excerpt: 'Il est né à Paris', status: 'verifiee' }])], []);
    expect(r.anchoring.rate).toBe(1);
    expect(r.anchoringBasis.anchoringOfRewrittenText.rate).toBe(0.5);
    expect(r.anchoringBasis.claimsWithExcerpt).toBe(2);
  });
  it("un extrait absent de la transcription n'est pas ancré; sans extrait on retombe sur le texte", () => {
    const r = computeReport([run([{ text: 'x', excerpt: 'Racine est mort en 1699', status: 'verifiee' }, { text: 'Il est né à Paris', status: 'verifiee' }])], []);
    expect(r.anchoring.k).toBe(1);
    expect(r.anchoringBasis.claimsWithExcerpt).toBe(1);
  });
  it('compteurs des appels de jugement: illisibles, relances, verdicts reçus sur attendus, citations rejetées', () => {
    const i = run([]);
    i.run.judge = [
      { step: 'verify-judge', expected: 10, received: 0, readable: false, retried: true, skipped: false, rejectedCitations: 0 },
      { step: 'verify-judge', expected: 10, received: 9, readable: true, retried: false, skipped: false, rejectedCitations: 3 },
      { step: 'verify-second', expected: 2, received: 2, readable: true, retried: false, skipped: false, rejectedCitations: 1 },
    ];
    const j = computeReport([i], []).judgeCalls;
    expect(j.judge).toEqual({ calls: 2, unreadable: 1, retried: 1, skipped: 0, claimsExpected: 20, verdictsReceived: 9, citationsRejected: 3 });
    expect(j.total.citationsRejected).toBe(4);
    expect(j.second.calls).toBe(1);
  });
});
