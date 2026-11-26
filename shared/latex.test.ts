import { describe, expect, it } from 'vitest';
import { escapeText, hasFormula, isSafeFormula, isSafeText, sanitizeFormulaBlock, sanitizeLatex, splitMath, stripFormulas } from './latex.js';

describe('isSafeFormula', () => {
  it.each(['E = mc^{2}', '\\frac{a}{b}', '\\idotsint f', '\\defeq x', '\\letter', '\\text{un \\{ ok}'])('accepte %s', (f) => expect(isSafeFormula(f)).toBe(true));
  it.each(['\\href{javascript:alert(1)}{x}', '\\url{x}', '\\includegraphics{x}', '\\htmlData{a=b}{c}', '\\htmlClass{a}{b}', '\\def\\a{b}', '\\newcommand{\\a}{b}', '\\cssId{a}{b}', '\\style{color:red}{x}'])('refuse %s', (f) => expect(isSafeFormula(f)).toBe(false));
  it('refuse les accolades desequilibrees, trop profondes, une formule trop longue ou vide', () => {
    expect(isSafeFormula('\\frac{a}{b')).toBe(false);
    expect(isSafeFormula('a}')).toBe(false);
    expect(isSafeFormula('{'.repeat(9) + '}'.repeat(9))).toBe(false);
    expect(isSafeFormula('{'.repeat(8) + '}'.repeat(8))).toBe(true);
    expect(isSafeFormula('x'.repeat(501))).toBe(false);
    expect(isSafeFormula('')).toBe(false);
    expect(isSafeFormula('a\u0001b')).toBe(false);
  });
});

describe('splitMath, isSafeText', () => {
  it('separe texte et formules, `\\$` est un dollar litteral', () => {
    expect(splitMath('Soit $x^2$ et 5 \\$')).toEqual([{ text: 'Soit ' }, { math: 'x^2' }, { text: ' et 5 $' }]);
    expect(splitMath('un $ seul')).toBeUndefined();
  });
  it('refuse un texte a $ impair ou une formule interdite, accepte le reste', () => {
    expect(isSafeText('Soit $x$')).toBe(true);
    expect(isSafeText('prix 5 $')).toBe(false);
    expect(isSafeText('$\\href{a}{b}$')).toBe(false);
    expect(isSafeText('x'.repeat(2001))).toBe(false);
  });
});

describe('sanitizeLatex', () => {
  it('garde une formule sure, retire les delimiteurs d\'une formule interdite', () => {
    expect(sanitizeLatex('Soit $x^2$.')).toBe('Soit $x^2$.');
    expect(sanitizeLatex('Voir $\\href{http://a}{b}$ ici')).toBe('Voir \\\\href{http://a}{b} ici'); // texte simple: l'antislash est double (relu comme un seul)
  });
  it('`$` impair: tous les `$` non echappes sont retires, le texte reste du texte', () => {
    expect(sanitizeLatex('coute 5 $ environ')).toBe('coute 5  environ');
    expect(sanitizeLatex('coute 5 \\$ environ')).toBe('coute 5 \\$ environ');
  });
  it('est idempotent', () => {
    for (const t of ['a $x$ b', 'a $\\def\\a{}$ b', '5 $ 6', 'prix \\$5']) expect(sanitizeLatex(sanitizeLatex(t))).toBe(sanitizeLatex(t));
  });
  it('retire les caracteres de controle', () => expect(sanitizeLatex('a\u0000b')).toBe('ab'));
});

describe('formules', () => {
  it('bloc formule: source sure ou undefined', () => {
    expect(sanitizeFormulaBlock(' E = mc^{2} ')).toBe('E = mc^{2}');
    expect(sanitizeFormulaBlock('\\input{x}')).toBeUndefined();
  });
  it('stripFormulas retire les segments $...$ et hasFormula les detecte', () => {
    expect(stripFormulas('La masse $m$ vaut 3 kg')).toBe('La masse vaut 3 kg');
    expect(hasFormula('a $b$')).toBe(true);
    expect(hasFormula('a b')).toBe(false);
  });
});

describe('antislash et dollar (alerte CodeQL: echappement incomplet)', () => {
  it('escapeText: relu a l\'identique par splitMath, y compris un antislash devant un dollar', () => {
    for (const t of ['\\$', '\\\\$', 'a\\', '$$', '\\x', 'C:\\dir \\$5', '$']) expect(splitMath(escapeText(t)), t).toEqual([{ text: t }]);
  });
  it('hors formule `\\\\` est un antislash; dans une formule la paire est gardee (`\\\\` avant le `$` fermant)', () => {
    expect(splitMath('a \\\\$x$')).toEqual([{ text: 'a \\' }, { math: 'x' }]);
    expect(splitMath('$a\\\\$')).toEqual([{ math: 'a\\\\' }]);
    expect(splitMath('$a\\$b$')).toEqual([{ math: 'a\\$b' }]);
  });
  it('une formule refusee qui contient `\\$` ne laisse aucun `$` seul: le resultat est relu sans erreur et reste stable', () => {
    const out = sanitizeLatex('Voir $\\href{a}{\\$}$ ici');
    expect(splitMath(out)).toEqual([{ text: 'Voir \\href{a}{$} ici' }]);
    expect(sanitizeLatex(out)).toBe(out);
  });
  it('`$` impair: les `$` echappes, y compris apres un antislash double, sont gardes; les autres retires', () => {
    expect(sanitizeLatex('a \\\\\\$ b $ c')).toBe('a \\\\\\$ b  c');
    expect(splitMath(sanitizeLatex('x \\\\ $ y'))).toBeDefined();
  });
  it('idempotent sur des textes avec antislash', () => {
    for (const t of ['a\\b', 'a \\\\$x$ b', 'chemin C:\\dir', '$\\def\\a{}$ \\\\']) expect(sanitizeLatex(sanitizeLatex(t)), t).toBe(sanitizeLatex(t));
  });
});

describe('sortie toujours sure (alerte CodeQL, relecture de la PR #94)', () => {
  const HOSTILE = [
    '$\\href{a}{b} \\$a$ $\\href{c}{d} \\$b$',
    '$\\def\\x{\\$}$ $\\input{f}$',
    'a \\\\$ b $\\url{x}$ \\$',
    '$$ $ \\ \\\\ \\$ $',
    '$\\htmlData{a=b}{c} \\$ $\\href{x}{y}$',
    'x'.repeat(1999) + '$\\href{a}{b}$',
  ];
  it.each(HOSTILE)('isSafeText(sanitizeLatex(x)) et sortie stable: %s', (x) => {
    const out = sanitizeLatex(x);
    expect(isSafeText(out)).toBe(true);
    expect(sanitizeLatex(out)).toBe(out);
    // aucune formule restante ne contient une commande interdite, aucun `$` brut seul
    for (const s of splitMath(out) ?? []) if ('math' in s) expect(isSafeFormula(s.math)).toBe(true);
  });
  it('propriete sur 3000 entrees tirees d\'un alphabet hostile (graine fixe)', () => {
    const alphabet = ['$', '\\', '\\$', '\\\\', '{', '}', 'a', ' ', '\\href', '\\def', '\\input', 'x^2', '='];
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let n = 0; n < 3000; n++) {
      const x = Array.from({ length: 1 + Math.floor(rnd() * 14) }, () => alphabet[Math.floor(rnd() * alphabet.length)]).join('');
      const out = sanitizeLatex(x);
      expect(isSafeText(out), JSON.stringify(x)).toBe(true);
      expect(sanitizeLatex(out), JSON.stringify(x)).toBe(out);
    }
  });
});
