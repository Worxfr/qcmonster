import { describe, expect, it } from 'vitest';
import { checkCorrection, checkFormula, splitMath } from './latex';

describe('checkFormula', () => {
  it('accepte les formules courantes', () => {
    for (const f of ['x^2', '\\frac{a}{b}', '\\sum_{i=1}^{n} i', '\\begin{cases} 1 \\\\ 2 \\end{cases}', '\\idotsint', '\\letter', '\\defeq']) expect(checkFormula(f)).toBeNull();
  });
  it('refuse les commandes interdites par nom entier, et html*', () => {
    for (const f of ['\\href{javascript:alert(1)}{x}', '\\url{http://x}', '\\includegraphics{a}', '\\def\\a{1}', '\\let\\a=b', '\\newcommand{\\a}{b}', '\\htmlData{x=y}{z}', '\\htmlClass{a}{b}', '\\cssId{a}{b}', '\\style{a}{b}', '\\csname a\\endcsname']) expect(checkFormula(f), f).not.toBeNull();
  });
  it('refuse trop long, accolades déséquilibrées, imbrication, caractères de contrôle, vide', () => {
    expect(checkFormula('x'.repeat(501))).not.toBeNull();
    expect(checkFormula('\\frac{a}{b')).not.toBeNull();
    expect(checkFormula('a}')).not.toBeNull();
    expect(checkFormula('{'.repeat(9) + '}'.repeat(9))).not.toBeNull();
    expect(checkFormula('{'.repeat(8) + '}'.repeat(8))).toBeNull();
    expect(checkFormula('a\u0007b')).not.toBeNull();
    expect(checkFormula('  ')).not.toBeNull();
    expect(checkFormula('\\{ a \\}')).toBeNull(); // accolades échappées
  });
});

describe('splitMath', () => {
  it('sépare texte et formules', () => {
    expect(splitMath('Soit $x^2$ ici')).toEqual([{ kind: 'text', text: 'Soit ' }, { kind: 'math', tex: 'x^2' }, { kind: 'text', text: ' ici' }]);
  });
  it('« 5 $ et 6 $ » reste du texte; un $ seul aussi; \\$ est un dollar littéral', () => {
    expect(splitMath('5 $ et 6 $')).toEqual([{ kind: 'text', text: '5 $ et 6 $' }]);
    expect(splitMath('coûte 5 $')).toEqual([{ kind: 'text', text: 'coûte 5 $' }]);
    expect(splitMath('coûte 5 \\$ et $x$')).toEqual([{ kind: 'text', text: 'coûte 5 $ et ' }, { kind: 'math', tex: 'x' }]);
  });
  it('une formule refusée perd ses délimiteurs et reste du texte', () => {
    expect(splitMath('a $\\href{x}{y}$ b')).toEqual([{ kind: 'text', text: 'a \\href{x}{y} b' }]);
  });
  it('nombre impair de $: tout reste du texte', () => {
    expect(splitMath('5 $ puis $y$')).toEqual([{ kind: 'text', text: '5 $ puis $y$' }]);
  });
});

describe('checkCorrection', () => {
  it('refuse un $ impair, une formule interdite, une phrase trop longue', () => {
    expect(checkCorrection('coûte 5 $')).toMatch(/tout seul/);
    expect(checkCorrection('a $\\url{x}$')).toMatch(/url/);
    expect(checkCorrection('x'.repeat(2001))).not.toBeNull();
  });
  it('accepte texte, formule valide, dollar échappé; bloc formule = LaTeX brut', () => {
    expect(checkCorrection('Soit $x$.')).toBeNull();
    expect(checkCorrection('5 \\$')).toBeNull();
    expect(checkCorrection('\\frac{a}{b}', true)).toBeNull();
    expect(checkCorrection('\\href{a}{b}', true)).not.toBeNull();
  });
});
