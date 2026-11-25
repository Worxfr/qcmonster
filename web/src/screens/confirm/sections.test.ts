import { describe, expect, it } from 'vitest';
import type { Sentence } from '../../types';
import { addCut, confirmBody, initSections, maxSections, plan, removeCut, sanitize, sectionIndex } from './sections';

const S = (id: string, text = 'un deux trois quatre cinq six sept huit neuf dix'): Sentence => ({ id, text });
const all = [S('p1-s1'), S('p1-s2'), S('p2-s1'), S('p2-s2'), S('p3-s1')];

describe('sections', () => {
  it('sans proposition: une seule section qui commence à la première phrase', () => {
    expect(initSections(all, undefined, 'svt', 'Cellule', 3)).toEqual([{ from: 'p1-s1', subject: 'svt', topic: 'Cellule', title: '', folderId: '', ignore: false }]);
  });
  it('proposition reprise; incohérente (désordre, id inconnu, trop longue) = une section', () => {
    const sug = (ids: string[]) => ids.map((fromSentenceId) => ({ fromSentenceId, subject: 'svt' as const }));
    expect(initSections(all, sug(['p1-s1', 'p2-s1']), undefined, undefined, 3)).toHaveLength(2);
    expect(initSections(all, sug(['p1-s1', 'p2-s1', 'p1-s2']), undefined, undefined, 3)).toHaveLength(1);
    expect(initSections(all, sug(['p1-s1', 'zz']), undefined, undefined, 3)).toHaveLength(1);
    expect(initSections(all, sug(['p1-s2', 'p2-s1']), undefined, undefined, 3)).toHaveLength(1);
    expect(initSections(all, sug(['p1-s1', 'p1-s2', 'p2-s1']), undefined, undefined, 1)).toHaveLength(1); // 1 page: 2 au plus
  });
  it('plafond: 2 par page, 6 au plus', () => {
    expect([1, 2, 3, 10].map(maxSections)).toEqual([2, 4, 6, 6]);
  });
  it("pose une coupe au milieu d'une page et sur la frontière de deux pages, dans l'ordre; la retire", () => {
    let s = initSections(all, undefined, 'maths', undefined, 3);
    s = addCut(s, all, 'p2-s1'); // frontière
    s = addCut(s, all, 'p1-s2'); // milieu de page 1
    expect(s.map((x) => x.from)).toEqual(['p1-s1', 'p1-s2', 'p2-s1']);
    expect(s[1].subject).toBe('maths');
    expect(addCut(s, all, 'p1-s1')).toBe(s); // jamais avant la première phrase
    expect(removeCut(s, 'p1-s2').map((x) => x.from)).toEqual(['p1-s1', 'p2-s1']);
    expect(removeCut(s, 'p1-s1')).toBe(s);
    expect([...sectionIndex(s, all).values()]).toEqual([0, 1, 2, 2, 2]);
  });
  it('compte les mots des parties gardées seulement', () => {
    let s = initSections(all, undefined, 'maths', undefined, 3);
    s = addCut(s, all, 'p2-s1');
    expect(plan(s, all, (x) => x.text).words).toBe(50);
    s[1] = { ...s[1], ignore: true };
    expect(plan(s, all, (x) => x.text)).toMatchObject({ words: 20, kept: 1, ignored: 1 });
  });
  it("corps d'envoi: raccourci pour une section simple, sections sinon (ignore seulement si vrai)", () => {
    let s = initSections(all, undefined, 'maths', 'Fractions', 3);
    expect(confirmBody(s)).toEqual({ subject: 'maths', topic: 'Fractions' });
    s = addCut(s, all, 'p2-s1');
    s[1] = { ...s[1], subject: 'svt', ignore: true };
    expect(confirmBody(s)).toEqual({ sections: [{ fromSentenceId: 'p1-s1', subject: 'maths', topic: 'Fractions' }, { fromSentenceId: 'p2-s1', subject: 'svt', ignore: true }] });
  });
  it('rechargement: sections invalides rejetées', () => {
    expect(sanitize([{ from: 'p2-s1', subject: 'svt', topic: '' }], all, 3)).toBeNull();
    expect(sanitize([{ from: 'p1-s1', subject: 'svt', topic: '' }, { from: 'zz', subject: 'svt', topic: '' }], all, 3)).toBeNull();
    expect(sanitize([{ from: 'p1-s1', subject: 'svt', topic: 'x' }], all, 3)).toHaveLength(1);
  });
});
