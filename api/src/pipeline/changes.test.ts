// M1 #89: applyChanges, fonction pure (docs/M1-design.md 2 et 10). Aucun reseau.
import { describe, expect, it } from 'vitest';
import { MAX_BLOCK_SENTENCES, MAX_BLOCKS } from './blocks.js';
import * as shared from '../../../shared/changes.js';
import type { Block } from './blocks.js';
import { applyChanges, CHANGE_MESSAGES, MAX_ADDED_CHARS, type AddedIn, type PageItem } from './changes.js';

const S = (id: string, extra: object = {}) => ({ id, text: `Texte de ${id}.`, ...extra });
/** Page 1: titre b1 [s1], paragraphe b2 [s2 s3], liste b3 [s4 s5], formule b4 [s6], figure b5; page 2: paragraphe b6 [s1 s2]. */
const texts = (): PageItem[] => [
  { SK: 'TEXT#1', page: 1, sentences: [S('p1-s1'), S('p1-s2'), S('p1-s3'), S('p1-s4'), S('p1-s5'), S('p1-s6')] },
  { SK: 'TEXT#2', page: 2, sentences: [S('p2-s1'), S('p2-s2')] },
];
const blocks = (): Block[] => [
  { id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] },
  { id: 'b2', kind: 'paragraphe', sentenceIds: ['p1-s2', 'p1-s3'] },
  { id: 'b3', kind: 'liste', sentenceIds: ['p1-s4', 'p1-s5'] },
  { id: 'b4', kind: 'formule', sentenceIds: ['p1-s6'] },
  { id: 'b5', kind: 'figure', figureId: 'f1' },
  { id: 'b6', kind: 'paragraphe', sentenceIds: ['p2-s1', 'p2-s2'] },
];
const add = (key: string, afterId: string | null, text = `Ajout ${key}.`, newBlock?: boolean): AddedIn => ({ key, afterId, text, ...(newBlock ? { newBlock } : {}) });
const run = (added: AddedIn[], extra: { removed?: string[]; corrections?: { id: string; text: string }[] } = {}, withBlocks = true) => {
  const r = applyChanges(texts(), withBlocks ? blocks() : undefined, { ...extra, added });
  if (!r.ok) throw new Error(`refus ${r.error}`);
  return r;
};
const ids = (r: ReturnType<typeof run>, page: number) => (r.texts[page - 1].sentences as { id: string }[]).map((s) => s.id);
const refuse = (added: AddedIn[], extra: Parameters<typeof run>[1] = {}) => {
  const r = applyChanges(texts(), blocks(), { ...extra, added });
  expect(r.ok).toBe(false);
  return r.ok ? undefined : r.error;
};

describe('applyChanges: ajouts', () => {
  it('au milieu d\'un paragraphe: la phrase rejoint le bloc, juste apres l\'ancre, identifiant = plus grand numero + 1', () => {
    const r = run([add('n1', 'p1-s2')]);
    expect(ids(r, 1)).toEqual(['p1-s1', 'p1-s2', 'p1-s7', 'p1-s3', 'p1-s4', 'p1-s5', 'p1-s6']);
    expect(r.blocks!.find((b) => b.id === 'b2')!.sentenceIds).toEqual(['p1-s2', 'p1-s7', 'p1-s3']);
    expect(r.ids.get('n1')).toBe('p1-s7');
    expect((r.texts[0].sentences as { id: string; added?: boolean }[])[2]).toMatchObject({ id: 'p1-s7', text: 'Ajout n1.', added: true });
    expect(r.changed.map((t) => t.SK)).toEqual(['TEXT#1']); // la page 2 n'est pas reecrite
  });

  it('dans une liste: un element de liste de plus', () => {
    const r = run([add('n1', 'p1-s5')]);
    expect(r.blocks!.find((b) => b.id === 'b3')!.sentenceIds).toEqual(['p1-s4', 'p1-s5', 'p1-s7']);
  });

  it('apres un titre ou une formule: nouveau paragraphe apres le bloc, jamais dans le titre', () => {
    const r = run([add('n1', 'p1-s1'), add('n2', 'p1-s6')]);
    expect(r.blocks!.map((b) => b.id + ':' + b.kind)).toEqual(['b1:titre', 'b7:paragraphe', 'b2:paragraphe', 'b3:liste', 'b4:formule', 'b8:paragraphe', 'b5:figure', 'b6:paragraphe']);
    expect(r.blocks![0].sentenceIds).toEqual(['p1-s1']);
    expect(r.blocks![4].sentenceIds).toEqual(['p1-s6']);
  });

  it('nouveau paragraphe voulu au milieu d\'un paragraphe: apres le bloc ET apres sa derniere phrase (on ne coupe pas le paragraphe)', () => {
    const r = run([add('n1', 'p1-s2', 'Nouveau paragraphe.', true)]);
    expect(ids(r, 1)).toEqual(['p1-s1', 'p1-s2', 'p1-s3', 'p1-s7', 'p1-s4', 'p1-s5', 'p1-s6']);
    expect(r.blocks!.find((b) => b.id === 'b2')!.sentenceIds).toEqual(['p1-s2', 'p1-s3']);
    expect(r.blocks!.map((b) => b.id).slice(0, 4)).toEqual(['b1', 'b2', 'b7', 'b3']);
  });

  it('tout au debut: nouveau paragraphe avant le premier bloc, sur la premiere page', () => {
    const r = run([add('n1', null)]);
    expect(ids(r, 1)[0]).toBe('p1-s7');
    expect(r.blocks![0]).toMatchObject({ kind: 'paragraphe', sentenceIds: ['p1-s7'] });
  });

  it('ajouts en chaine: le second suit le premier; une cle sur un nouveau paragraphe y reste', () => {
    const r = run([add('n1', 'p1-s3', 'A.x', true), add('n2', 'n1', 'B.y'), add('n3', 'n2', 'C.z')]);
    expect([...r.ids.values()]).toEqual(['p1-s7', 'p1-s8', 'p1-s9']);
    expect(ids(r, 1).slice(3, 6)).toEqual(['p1-s7', 'p1-s8', 'p1-s9']);
    expect(r.blocks!.find((b) => b.sentenceIds?.includes('p1-s7'))!.sentenceIds).toEqual(['p1-s7', 'p1-s8', 'p1-s9']);
  });

  it('la page de la phrase est celle de son ancre; la numerotation est par page', () => {
    const r = run([add('n1', 'p2-s1'), add('n2', 'p1-s1')]);
    expect(r.ids.get('n1')).toBe('p2-s3');
    expect(r.ids.get('n2')).toBe('p1-s7');
  });

  it('phrase recollee sur deux pages: l\'ajout prend la derniere de ses pages, en tete de cette page', () => {
    const t = texts();
    (t[0].sentences as object[])[5] = S('p1-s6', { pages: [1, 2] });
    const r = applyChanges(t, blocks(), { added: [add('n1', 'p1-s6', 'Suite.', true)] });
    expect(r.ok && r.ids.get('n1')).toBe('p2-s3');
    expect(r.ok && (r.texts[1].sentences as { id: string }[])[0].id).toBe('p2-s3');
  });

  it('apres une phrase retiree dans la meme requete: l\'ajout garde sa place; un identifiant retire n\'est jamais repris', () => {
    const r = run([add('n1', 'p1-s3')], { removed: ['p1-s3', 'p1-s6'] });
    expect(ids(r, 1)).toEqual(['p1-s1', 'p1-s2', 'p1-s7', 'p1-s4', 'p1-s5']); // s6 retire: le numero 7 reste le suivant
    expect(r.blocks!.find((b) => b.id === 'b2')!.sentenceIds).toEqual(['p1-s2', 'p1-s7']);
    const r2 = run([add('n1', 'p1-s1')], { removed: ['p1-s6'] });
    expect(r2.ids.get('n1')).toBe('p1-s7');
  });

  it('retrait de toutes les phrases d\'un bloc: le bloc disparait, la figure reste (a la charge de l\'appelant)', () => {
    const r = run([], { removed: ['p1-s6'] });
    expect(r.blocks!.map((b) => b.id)).toEqual(['b1', 'b2', 'b3', 'b5', 'b6']);
  });

  it('aucun identifiant existant n\'est renumerote; les textes d\'entree ne sont pas modifies', () => {
    const before = JSON.stringify(texts());
    const t = texts();
    const r = applyChanges(t, blocks(), { added: [add('n1', 'p1-s1'), add('n2', null), add('n3', 'p2-s2')] });
    expect(JSON.stringify(t)).toBe(before);
    expect(r.ok && r.texts.flatMap((p) => (p.sentences as { id: string }[]).map((s) => s.id))).toEqual(expect.arrayContaining(['p1-s1', 'p1-s2', 'p1-s3', 'p1-s4', 'p1-s5', 'p1-s6', 'p2-s1', 'p2-s2']));
  });

  it('job sans couche de blocs: la phrase entre seulement dans la liste, aucun bloc', () => {
    const r = run([add('n1', 'p1-s2')], {}, false);
    expect(r.blocks).toBeUndefined();
    expect(ids(r, 1)).toEqual(['p1-s1', 'p1-s2', 'p1-s7', 'p1-s3', 'p1-s4', 'p1-s5', 'p1-s6']);
  });

  it('deterministe: la meme requete donne le meme resultat (rejeu)', () => {
    const a = [add('n1', 'p1-s2'), add('n2', 'n1', 'Autre.', true)];
    expect(JSON.stringify(run(a))).toBe(JSON.stringify(run(a)));
  });

  it('un bloc plein (200 phrases) n\'est pas depasse: nouveau paragraphe', () => {
    const t: PageItem[] = [{ SK: 'TEXT#1', page: 1, sentences: Array.from({ length: 200 }, (_, k) => S(`p1-s${k + 1}`)) }];
    const b: Block[] = [{ id: 'b1', kind: 'paragraphe', sentenceIds: (t[0].sentences as { id: string }[]).map((s) => s.id) }];
    const r = applyChanges(t, b, { added: [add('n1', 'p1-s5')] });
    expect(r.ok && r.blocks!.map((x) => x.sentenceIds!.length)).toEqual([200, 1]);
  });
});

describe('constantes partagees avec blocks.ts', () => {
  it('memes limites de blocs que la lecture', () => {
    expect([shared.MAX_BLOCK_SENTENCES, shared.MAX_BLOCKS]).toEqual([MAX_BLOCK_SENTENCES, MAX_BLOCKS]);
  });
});

describe('applyChanges: refus (rien n\'est modifie)', () => {
  it.each([
    ['ancre inconnue', [add('n1', 'p9-s9')], 'ancre'],
    ['ancre = cle inexistante', [add('n1', 'n7')], 'ancre'],
    ['ancre vers un ajout plus tard dans le tableau', [add('n1', 'n2'), add('n2', 'p1-s1')], 'ordre'],
    ['ancre = soi-meme', [add('n1', 'n1')], 'ordre'],
    ['cle en double', [add('n1', 'p1-s1'), add('n1', 'p1-s2')], 'cle'],
    ['cle mal formee', [add('x1', 'p1-s1')], 'cle'],
    ['phrase vide', [add('n1', 'p1-s1', '   ')], 'phrase_vide'],
    ['moins de 3 caracteres utiles', [add('n1', 'p1-s1', ' ab ')], 'phrase_vide'],
    ['formule interdite', [add('n1', 'p1-s1', 'Voir $\\href{http://a}{b}$')], 'formule'],
    ['dollar impair', [add('n1', 'p1-s1', 'coute 5 $ environ')], 'formule'],
    ['21 ajouts', Array.from({ length: 21 }, (_, k) => add(`n${k + 1}`, null)), 'trop'],
    ['plus de 6000 caracteres', [add('n1', null, 'a'.repeat(2000)), add('n2', null, 'b'.repeat(2000)), add('n3', null, 'c'.repeat(2000)), add('n4', null, 'ddd')], 'trop_long'],
  ] as const)('%s', (_n, added, code) => {
    expect(refuse([...added])).toBe(code);
    expect(CHANGE_MESSAGES[code]).toBeTruthy();
  });

  it('6000 caracteres pile: accepte', () => {
    expect(MAX_ADDED_CHARS).toBe(6000);
    const r = applyChanges(texts(), blocks(), { added: [add('n1', null, 'a'.repeat(2000)), add('n2', null, 'b'.repeat(2000)), add('n3', null, 'c'.repeat(2000))] });
    expect(r.ok).toBe(true);
  });

  it('6001 caracteres: refuse', () => {
    expect(refuse([add('n1', null, 'a'.repeat(2000)), add('n2', null, 'b'.repeat(2000)), add('n3', null, 'c'.repeat(1997)), add('n4', null, 'dddd')])).toBe('trop_long');
  });

  it('plus de 400 blocs: refuse', () => {
    const many: Block[] = Array.from({ length: 400 }, (_, k) => ({ id: `b${k + 1}`, kind: 'paragraphe', sentenceIds: [`p1-s${k + 1}`] }));
    const t: PageItem[] = [{ SK: 'TEXT#1', page: 1, sentences: many.map((b) => S(b.sentenceIds![0])) }];
    expect(applyChanges(t, many, { added: [add('n1', null)] })).toEqual({ ok: false, error: 'blocs' });
  });

  it('ancre = phrase du cours deja ecrite (contexte d\'un ajout de pages) n\'existe pas dans le texte du job: refus', () => {
    expect(refuse([add('n1', 'p0-s1')])).toBe('ancre');
  });

  it('les messages sont des constantes: jamais le texte de l\'eleve', () => {
    for (const m of Object.values(CHANGE_MESSAGES)) expect(m).not.toMatch(/ignore|\$/);
  });
});

describe('applyChanges: durcissements de relecture (PR #101)', () => {
  it('une correction avec une formule interdite ou un $ impair est refusee (la garde des corrections vit ici)', () => {
    for (const text of ['Voir $\\href{http://a}{b}$', 'coute 5 $ environ']) {
      expect(applyChanges(texts(), blocks(), { corrections: [{ id: 'p1-s2', text }] })).toEqual({ ok: false, error: 'formule' });
    }
    expect(applyChanges(texts(), blocks(), { corrections: [{ id: 'p1-s2', text: 'Soit $E = mc^{2}$.' }] }).ok).toBe(true);
  });

  it('numerotation avec un trou: page p1-s1, p1-s3 => l\'ajout est p1-s4 (jamais p1-s3, ni p1-s2)', () => {
    const t: PageItem[] = [{ SK: 'TEXT#1', page: 1, sentences: [S('p1-s1'), S('p1-s3')] }];
    const r = applyChanges(t, undefined, { added: [add('n1', 'p1-s1'), add('n2', 'p1-s1')] });
    expect(r.ok && [...r.ids.values()]).toEqual(['p1-s4', 'p1-s5']);
    expect(r.ok && (r.texts[0].sentences as { id: string }[]).map((s) => s.id)).toEqual(['p1-s1', 'p1-s5', 'p1-s4', 'p1-s3']);
  });

  it('ancre hors de tout bloc alors que le texte a des blocs: refus (ordre des blocs et des phrases ne divergent pas)', () => {
    const partial: Block[] = [{ id: 'b1', kind: 'paragraphe', sentenceIds: ['p1-s2'] }];
    expect(applyChanges(texts(), partial, { added: [add('n1', 'p1-s1')] })).toEqual({ ok: false, error: 'ancre' });
    expect(applyChanges(texts(), partial, { added: [add('n1', 'p1-s2')] }).ok).toBe(true); // une ancre dans un bloc reste acceptee
  });
});

describe('applyChanges: retraits et corrections (comportement inchange)', () => {
  it('phrase inconnue (retrait ou correction) = refus; corrigee puis retiree: le retrait gagne; doute eteint', () => {
    expect(applyChanges(texts(), blocks(), { removed: ['p9-s9'] })).toEqual({ ok: false, error: 'phrase_inconnue' });
    expect(applyChanges(texts(), blocks(), { corrections: [{ id: 'p9-s9', text: 'x' }] })).toEqual({ ok: false, error: 'phrase_inconnue' });
    const t = texts();
    (t[0].sentences as object[])[1] = S('p1-s2', { doubt: true, pages: [1] });
    const r = applyChanges(t, blocks(), { removed: ['p1-s3'], corrections: [{ id: 'p1-s3', text: '' }, { id: 'p1-s2', text: '  Corrigee.  ' }] });
    expect(r.ok && JSON.stringify(r.texts[0].sentences)).not.toContain('doubt');
    expect(r.ok && (r.texts[0].sentences as { id: string; text: string }[]).slice(0, 2).map((s) => s.text)).toEqual(['Texte de p1-s1.', 'Corrigee.']);
  });
});
