import { describe, expect, it } from 'vitest';
import { hasFormula, isSafeFormula, isSafeText, sanitizeFormulaBlock, sanitizeLatex, splitMath, stripFormulas } from './latex.js';

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
    expect(sanitizeLatex('Voir $\\href{http://a}{b}$ ici')).toBe('Voir \\href{http://a}{b} ici');
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
