import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { GOLDEN_DIR, loadAnnotation, loadManifest, totals, verifyCounters } from '../eval/golden.js';

const m = loadManifest();
const t = totals(m);

describe('effectifs minimaux du jeu doré (design 10.3 L2c)', () => {
  it.each([
    ['pages', t.pages, m.minimums.pages],
    ['pages de mise au point', t.tuning, m.minimums.tuning],
    ['pages cachées', t.hidden, m.minimums.hidden],
    ['erreurs insérées', t.errors, m.minimums.errors],
    ['affirmations justes', t.claims, m.minimums.claims],
    ['erreurs dans les pages cachées', t.hiddenErrors, m.minimums.hiddenErrors],
    ['affirmations justes dans les pages cachées', t.hiddenClaims, m.minimums.hiddenClaims],
    ['pages avec injection dans le cours', t.injectionCourse, m.minimums.injectionCourse],
    ['pages avec injection dans un passage', t.injectionPassage, m.minimums.injectionPassage],
    ['pages avec des noms de personnes', t.persons, m.minimums.persons],
    ['pages dégradées', t.degraded, m.minimums.degraded],
  ])('%s: %i >= %i', (_n, got, min) => expect(got).toBeGreaterThanOrEqual(min));

  it('les minimums du manifeste ne sont pas abaissés', () => {
    expect(m.minimums).toMatchObject({ pages: 50, tuning: 38, hidden: 12, errors: 75, claims: 400, hiddenErrors: 20, hiddenClaims: 100, injectionCourse: 5, injectionPassage: 5, persons: 5, degraded: 20 });
  });

  it('toutes les matières et au moins 3 niveaux', () => {
    expect(t.subjects).toBe(5);
    expect(t.levels).toBeGreaterThanOrEqual(3);
  });

  it('au moins 55 erreurs dans les pages de mise au point (seuil de rappel de L2b)', () => {
    expect(t.errors - t.hiddenErrors).toBeGreaterThanOrEqual(55);
  });
});

describe('cohérence du dépôt', () => {
  const pub = m.pages.filter((p) => !p.hidden && p.kind === 'synthetic');

  it('chaque page publique a image, annotation et compteurs identiques', () => {
    for (const p of pub) {
      expect(existsSync(join(GOLDEN_DIR, p.image!)), p.id).toBe(true);
      const a = loadAnnotation({ manifest: m }, p);
      expect(a.sentences.filter((s) => s.kind === 'error').length, p.id).toBe(p.errors);
      expect(a.sentences.filter((s) => s.kind === 'correct').length, p.id).toBe(p.claims);
      expect(a.sentences.some((s) => s.kind === 'injection'), p.id).toBe(p.injectionCourse);
      expect(p.twinImage !== undefined && existsSync(join(GOLDEN_DIR, p.twinImage)), p.id).toBe(p.injectionCourse);
    }
  });

  it("les pages réelles et cachées n'ont ni image ni annotation dans le dépôt", () => {
    for (const p of m.pages.filter((x) => x.hidden || x.kind === 'real')) {
      expect(p.image).toBeUndefined();
      expect(p.annotation).toBeUndefined();
      expect(existsSync(join(GOLDEN_DIR, 'pages', `${p.id}.jpg`)), p.id).toBe(false);
    }
  });

  it('aucun chemin local, ARN ou identifiant de compte dans les fichiers texte', () => {
    const bad = /\/data\/|\/home\/|arn:aws|\b\d{12}\b/;
    const walk = (d: string): string[] => readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(join(d, e.name)) : [join(d, e.name)]));
    for (const f of walk(GOLDEN_DIR).filter((x) => /\.(json|txt|py|ts)$/.test(x) && !x.endsWith('golden.test.ts'))) {
      expect(bad.test(readFileSync(f, 'utf8')), f).toBe(false);
    }
  });
});

// Avec le dossier privé, les compteurs publiés (effectifs minimaux) doivent égaler ceux des annotations privées.
describe.skipIf(!process.env.GOLDEN_PRIVATE_DIR)('compteurs privés', () => {
  it('le manifeste égale les annotations des pages réelles et cachées', () => {
    expect(verifyCounters({ manifest: m, privateDir: process.env.GOLDEN_PRIVATE_DIR })).toEqual([]);
  });
});
