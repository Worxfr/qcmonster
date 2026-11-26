import { describe, expect, it } from 'vitest';
import { closeness, drawQuestions, poolCap, type DrawCandidate, type PoolQuestion } from './pool.js';

const q = (id: string, docId: string, claimId: string, kind: 'qcm' | 'gap', texte: string, reponse: string, lastSeen?: string): DrawCandidate => ({ id, docId, claimId, kind, texte, reponse, ...(lastSeen ? { lastSeen } : {}) });
// Hasard deterministe (LCG).
const seeded = (seed: number) => () => ((seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0) / 2 ** 32);

describe('poolCap', () => {
  it.each([[1, 2], [2, 4], [3, 6], [10, 20], [11, 20], [20, 20], [0, 1]])('%i faits -> %i par type', (v, n) => expect(poolCap(v)).toBe(n));
});

describe('closeness', () => {
  const a: PoolQuestion = q('d:qcm:01', 'd', '01', 'qcm', 'Quel organite produit l\'énergie de la cellule ?', 'La mitochondrie');
  it('même fait et même réponse: proche (QCM contre trou)', () => {
    expect(closeness(a, q('d:gap:01', 'd', '01', 'gap', 'Dans la cellule, ____ fabrique le courant', 'la  MITOCHONDRIE'))).toBe(true);
  });
  it('même fait, autre mot masqué: pas proche', () => {
    expect(closeness(a, q('d:gap:02', 'd', '01', 'gap', 'La mitochondrie produit de l\'énergie grâce au ____', 'glucose'))).toBe(false);
  });
  it('mêmes mots (R2), accents et majuscules ignorés, même entre deux fiches', () => {
    const b = q('e:gap:01', 'e', '09', 'gap', 'QUEL ORGANITE PRODUIT L\'ENERGIE DE LA CELLULE ?', 'autre');
    expect(closeness(a, b)).toBe(true);
  });
  it('même réponse et mots en commun (R3), deux fiches', () => {
    const x = q('d:gap:03', 'd', '03', 'gap', 'La mitochondrie est un organite de la cellule', 'mitochondrie');
    const y = q('e:gap:03', 'e', '04', 'gap', 'La ____ est un organite de la cellule animale', 'mitochondrie');
    expect(closeness(x, y)).toBe(true);
  });
  it('questions sans rapport: pas proches', () => {
    expect(closeness(a, q('e:qcm:01', 'e', '01', 'qcm', 'En quelle année a eu lieu la bataille de Marignan ?', '1515'))).toBe(false);
  });
});

describe('drawQuestions', () => {
  const topics = ['volcan', 'fleuve', 'montagne', 'desert', 'foret', 'ocean', 'glacier', 'savane', 'prairie', 'canyon', 'lagune', 'archipel'];
  // Chaque question a ses propres mots (aucune paire proche).
  const bank = (doc: string, n: number, seen: Record<number, string> = {}): DrawCandidate[] =>
    Array.from({ length: n }, (_, i) => q(`${doc}:${i % 2 ? 'gap' : 'qcm'}:${String(i + 1).padStart(2, '0')}`, doc, String(i), i % 2 ? 'gap' : 'qcm', `alpha${doc}${i} beta${doc}${i} gamma${doc}${i} delta${doc}${i}`, `rep${doc}${i}`, seen[i]));

  it('10 questions, sans doublon, jamais deux proches', () => {
    const r = drawQuestions(bank('d', 20), 10, seeded(1));
    expect(r.ids).toHaveLength(10);
    expect(new Set(r.ids).size).toBe(10);
    expect(r.short).toBe(false);
  });
  it('deux tests de suite sur 20 questions ne partagent rien, le troisième reprend les plus anciennes', () => {
    const all = bank('d', 20);
    const t1 = drawQuestions(all, 10, seeded(2)).ids;
    const seen1 = all.map((c) => (t1.includes(c.id) ? { ...c, lastSeen: '2026-11-01' } : c));
    const t2 = drawQuestions(seen1, 10, seeded(3)).ids;
    expect(t2.filter((x) => t1.includes(x))).toEqual([]);
    const seen2 = seen1.map((c) => (t2.includes(c.id) ? { ...c, lastSeen: '2026-11-02' } : c));
    const t3 = drawQuestions(seen2, 10, seeded(4)).ids;
    expect(t3.every((x) => t1.includes(x))).toBe(true); // les plus anciennes d'abord
  });
  it('banque trop petite: test plus court, jamais complété par une proche', () => {
    const near = [q('d:qcm:01', 'd', '1', 'qcm', 'Le volcan crache de la lave', 'lave'), q('d:qcm:02', 'd', '1', 'qcm', 'Le volcan crache de la lave brulante', 'lave'), q('d:gap:03', 'd', '2', 'gap', 'Le fleuve coule vers la mer', 'mer')];
    const r = drawQuestions(near, 10, seeded(5));
    expect(r.ids).toHaveLength(2);
    expect(r.short).toBe(true);
    expect(r.available).toBe(2);
  });
  it('parts égales entre fiches, une fiche à court passe son tour', () => {
    const r = drawQuestions([...bank('a', 20), ...bank('b', 20), ...bank('c', 20)], 9, seeded(6));
    const count = (d: string) => r.ids.filter((x) => x.startsWith(`${d}:`)).length;
    expect([count('a'), count('b'), count('c')]).toEqual([3, 3, 3]);
    const r2 = drawQuestions([...bank('a', 20), ...bank('b', 2)], 10, seeded(7));
    expect(r2.ids.filter((x) => x.startsWith('b:'))).toHaveLength(2);
    expect(r2.ids).toHaveLength(10);
  });
  it('10 fiches d\'une question chacune, et une fiche de 40 questions', () => {
    const ten = Array.from({ length: 10 }, (_, i) => bank(`f${i}`, 1)[0]).map((c, i) => ({ ...c, texte: `${topics[i]} unique ${i}`, reponse: `r${i}` }));
    expect(drawQuestions(ten, 10, seeded(8)).ids).toHaveLength(10);
    expect(drawQuestions(bank('g', 40), 20, seeded(9)).ids).toHaveLength(20);
  });
  it('m1: les parts égales passent avant « jamais répondues » entre fiches; dans une fiche, les vues viennent après les non vues', () => {
    const seenAll = bank('a', 6).map((c) => ({ ...c, lastSeen: '2026-11-01' }));
    const r = drawQuestions([...seenAll, ...bank('b', 6)], 4, seeded(12));
    expect(r.ids.filter((x) => x.startsWith('a:'))).toHaveLength(2); // la fiche vue donne quand même sa moitié
    expect(r.ids.filter((x) => x.startsWith('b:'))).toHaveLength(2);
    const mixed = [...bank('c', 4).map((c, i) => (i < 2 ? { ...c, lastSeen: '2026-11-01' } : c))];
    expect(drawQuestions(mixed, 2, seeded(3)).ids.sort()).toEqual(['c:gap:04', 'c:qcm:03']); // les 2 non vues d'abord
  });
  it('aucune question: vide et court', () => {
    expect(drawQuestions([], 10, seeded(1))).toEqual({ ids: [], available: 0, short: true });
  });
});
