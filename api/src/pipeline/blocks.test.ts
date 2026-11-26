import { describe, expect, it } from 'vitest';
import { classifyLines, MAX_BLOCKS, parseBlocks, renumber, validBox, validFiche, type ClaimForFiche, type RawPage } from './blocks.js';

const page = (n: number, md: string, extra: Partial<RawPage> = {}): RawPage => ({ page: n, suite: false, md, ...extra });

describe('parseBlocks', () => {
  it('titres, paragraphes, listes, formule et marqueur de figure', () => {
    const r = parseBlocks([page(1, '# Titre\n\nPremiere phrase. Seconde phrase.\n\n- un\n- deux\n\n= E = mc^{2}\n\n[[f1]]', { figures: [{ id: 'f1', box: [0.1, 0.4, 0.8, 0.35], kind: 'schema', alt: 'Un schema', caption: 'Fig. 1' }] })]);
    expect(r.blocks!.map((b) => [b.id, b.kind])).toEqual([['b1', 'titre'], ['b2', 'paragraphe'], ['b3', 'liste'], ['b4', 'formule'], ['b5', 'figure']]);
    expect(r.blocks![0]).toMatchObject({ level: 1, sentenceIds: ['p1-s1'] });
    expect(r.blocks![1].sentenceIds).toEqual(['p1-s2', 'p1-s3']);
    expect(r.blocks![2]).toMatchObject({ ordered: false, sentenceIds: ['p1-s4', 'p1-s5'] });
    expect(r.pages[0].sentences[5].text).toBe('E = mc^{2}');
    expect(r.figures).toEqual([{ figureId: 'f1', page: 1, kind: 'schema', alt: 'Un schema', caption: 'Fig. 1', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.35 }, modelId: 'f1' }]);
  });

  it('chaque phrase est dans exactement un bloc', () => {
    const r = parseBlocks([page(1, '## A\n\nUne. Deux.\n\n1. x\n2. y'), page(2, 'Trois. Quatre.')]);
    const ids = r.pages.flatMap((p) => p.sentences.map((s) => s.id));
    const inBlocks = r.blocks!.flatMap((b) => b.sentenceIds ?? []);
    expect(inBlocks.sort()).toEqual([...ids].sort());
    expect(r.blocks![2]).toMatchObject({ kind: 'liste', ordered: true });
  });

  it('repli sur lines quand le Markdown est vide: un paragraphe par ligne', () => {
    const r = parseBlocks([{ page: 1, suite: false, md: '  ', lines: ['Une phrase.', 'Autre phrase.'] }]);
    expect(r.blocks!.map((b) => b.kind)).toEqual(['paragraphe', 'paragraphe']);
    expect(r.pages[0].sentences).toHaveLength(2);
  });

  it('phrase coupee par un saut de page: recollee, le paragraphe continue dans le meme bloc', () => {
    const r = parseBlocks([page(1, 'La plante absorbe'), { page: 2, suite: true, md: "du dioxyde de carbone. Elle rejette l'oxygene." }]);
    expect(r.pages[0].sentences[0]).toMatchObject({ id: 'p1-s1', text: 'La plante absorbe du dioxyde de carbone.', pages: [1, 2] });
    expect(r.pages[1].sentences.map((s) => s.id)).toEqual(['p2-s1']);
    expect(r.blocks).toHaveLength(1);
    expect(r.blocks![0].sentenceIds).toEqual(['p1-s1', 'p2-s1']);
  });

  it('formule interdite: le bloc devient un paragraphe de texte simple; LaTeX en ligne controle', () => {
    const r = parseBlocks([page(1, '= \\href{javascript:x}{y}\n\nSoit $\\input{a}$ et $x^2$.')]);
    expect(r.blocks![0].kind).toBe('paragraphe');
    expect(r.pages[0].sentences[0].text).not.toContain('$');
    expect(r.pages[0].sentences[1].text).toBe('Soit \\input{a} et $x^2$.');
  });

  it('doute: marque par ~, supprime partout au-dela de 40 %', () => {
    const few = parseBlocks([page(1, '~Douteuse.\n\nA. B. C. D.\n\nE.')]);
    expect(few.pages[0].sentences.filter((s) => s.doubt).map((s) => s.id)).toEqual(['p1-s1']);
    expect(few.doubtDropped).toBe(false);
    const many = parseBlocks([page(1, '~A.\n~B.\n~C.\nD.')]);
    expect(many.doubtDropped).toBe(true);
    expect(many.pages[0].sentences.some((s) => s.doubt)).toBe(false);
  });

  it('figures: 8 au plus, cadre invalide signale, marqueur inconnu ignore, figure sans marqueur ajoutee en fin de page', () => {
    const figs = Array.from({ length: 10 }, (_, k) => ({ id: `f${k + 1}`, box: [0.1, 0.1, 0.5, 0.5], alt: 'x' }));
    const r = parseBlocks([page(1, 'Texte.\n\n[[f9]]', { figures: figs })]);
    expect(r.figures).toHaveLength(8);
    expect(r.blocks!.filter((b) => b.kind === 'figure')).toHaveLength(8);
    expect(r.blocks![r.blocks!.length - 1].figureId).toBe('f8');
    const bad = parseBlocks([page(1, 'Texte.', { figures: [{ id: 'f1', box: [0, 0, 1, 1], alt: 'x' }, { id: 'f2', alt: 'y' }] })]);
    expect(bad.figures.map((f) => f.boxInvalid)).toEqual([true, true]);
    expect(bad.figures[1].alt).toBe('y');
  });

  it('FIGURES_ENABLED=false: aucune figure retenue', () => {
    const r = parseBlocks([page(1, 'Texte.\n\n[[f1]]', { figures: [{ id: 'f1', box: [0.1, 0.1, 0.5, 0.5], alt: 'x' }] })], { figures: false });
    expect(r.figures).toEqual([]);
    expect(r.blocks!.some((b) => b.kind === 'figure')).toBe(false);
  });

  it('alt vide: texte par defaut (jamais de figure sans description); alt nettoye', () => {
    const r = parseBlocks([page(1, 'T.', { figures: [{ id: 'f1', box: [0.1, 0.1, 0.5, 0.5], alt: '<b>  </b>' }] })]);
    expect(r.figures[0].alt).toBe('b /b');
  });

  it('plus de 400 blocs: pas de couche de blocs, aucune phrase perdue', () => {
    const md = Array.from({ length: MAX_BLOCKS + 5 }, (_, k) => `Phrase ${k}.`).join('\n\n');
    const r = parseBlocks([page(1, md)]);
    expect(r.blocks).toBeUndefined();
    expect(r.figures).toEqual([]);
    expect(r.pages[0].sentences).toHaveLength(MAX_BLOCKS + 5);
  });

  it('un paragraphe de plus de 200 phrases est coupe en blocs consecutifs', () => {
    const md = Array.from({ length: 450 }, (_, k) => `Phrase ${k}.`).join(' ');
    const r = parseBlocks([page(1, md)]);
    expect(r.blocks!.map((b) => b.sentenceIds!.length)).toEqual([200, 200, 50]);
  });
});

describe('validBox', () => {
  it('bornes: dans [0,1], surface de 3 % a 90 %', () => {
    expect(validBox([0.1, 0.1, 0.5, 0.5])).toBeTruthy();
    expect(validBox([0.9, 0.1, 0.5, 0.5])).toBeUndefined();
    expect(validBox([0.1, 0.1, 0.1, 0.1])).toBeUndefined();
    expect(validBox([0, 0, 1, 0.95])).toBeUndefined();
    expect(validBox([0.1, 0.1, 0.5])).toBeUndefined();
  });
});

describe('classifyLines, renumber', () => {
  it('prefixe de bloc pour le classement', () => {
    const r = parseBlocks([page(1, '# T\n\nA.\n\n- x')]);
    expect(classifyLines(r.pages, r.blocks).map((l) => l.text)).toEqual(['# T', 'A.', '- x']);
  });
  it('renumerotation avec decalage: uniques a l\'echelle du cours', () => {
    const r = parseBlocks([page(1, 'A.\n\n[[f1]]', { figures: [{ id: 'f1', box: [0.1, 0.1, 0.5, 0.5], alt: 'x' }] })]);
    const o = renumber(r.blocks!, r.figures, { block: 10, figure: 3 });
    expect(o.blocks.map((b) => b.id)).toEqual(['b11', 'b12']);
    expect(o.blocks[1].figureId).toBe('f4');
    expect(o.figures[0].figureId).toBe('f4');
    expect(o.blocks[0].sentenceIds).toEqual(['p1-s1']);
  });
});

describe('validFiche', () => {
  const claims = new Map<string, ClaimForFiche>([
    ['01', { texte: 'La Terre tourne en 24 h.', status: 'verifiee' }],
    ['02', { texte: 'Soit $E = mc^2$.', status: 'non_verifiable' }],
    ['03', { texte: 'Une erreur.', status: 'erreur' }],
    ['04', { texte: 'Une definition.', status: 'verifiee' }],
  ]);
  const ok = { paragraphes: [{ heading: 'Titre', text: 'Un paragraphe.', claimIds: ['01', '99'] }] };

  it('le texte du rappel est copie de l\'affirmation, jamais du modele; erreur et inconnu ecartes', () => {
    const r = validFiche({ ...ok, rappel: [{ kind: 'date', claimId: '01', text: 'INVENTE' }, { kind: 'formule', claimId: '02' }, { kind: 'date', claimId: '03' }, { kind: 'date', claimId: '77' }, { kind: 'formule', claimId: '04' }, { kind: 'date', claimId: '01' }] }, claims)!;
    expect(r.recall).toEqual([
      { kind: 'date', text: 'La Terre tourne en 24 h.', claimId: '01', verified: true },
      { kind: 'formule', text: 'Soit $E = mc^2$.', claimId: '02', verified: false },
      { kind: 'definition', text: 'Une definition.', claimId: '04', verified: true }, // formule sans `=` retrogradee
    ]);
    expect(r.body[0].claimIds).toEqual(['01']);
  });
  it('repli (undefined) si illisible, vide ou hors limites de mots', () => {
    expect(validFiche(undefined, claims)).toBeUndefined();
    expect(validFiche({ paragraphes: [] }, claims)).toBeUndefined();
    expect(validFiche({ paragraphes: [{ text: 'mot '.repeat(151) }] }, claims)).toBeUndefined();
    expect(validFiche({ paragraphes: Array.from({ length: 4 }, () => ({ text: 'mot '.repeat(100) })) }, claims)).toBeUndefined();
  });
  it('6 paragraphes au plus', () => {
    const r = validFiche({ paragraphes: Array.from({ length: 8 }, () => ({ text: 'court' })) }, claims)!;
    expect(r.body).toHaveLength(6);
  });
});
