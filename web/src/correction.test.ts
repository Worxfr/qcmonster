import { describe, expect, it } from 'vitest';
import { DOLLAR_HELP, FORMULA_HELP, correctionProblem } from './correction';

// Le filtre LaTeX est `shared/latex.ts` (testé côté API); ici seulement le choix du message affiché à l'élève.
describe('correctionProblem', () => {
  it('refuse un $ seul, une commande interdite, une formule trop longue, une phrase trop longue', () => {
    expect(correctionProblem('coûte 5 $')).toBe(DOLLAR_HELP);
    expect(correctionProblem('a $\\url{x}$')).toBe(FORMULA_HELP);
    expect(correctionProblem(`$${'x'.repeat(501)}$`)).toBe(FORMULA_HELP);
    expect(correctionProblem('x'.repeat(2001))).toMatch(/2000/);
  });
  it('accepte texte, formule valide, dollar échappé; bloc formule = LaTeX brut', () => {
    expect(correctionProblem('Soit $x$.')).toBeNull();
    expect(correctionProblem('5 \\$')).toBeNull();
    expect(correctionProblem('\\frac{a}{b}', true)).toBeNull();
    expect(correctionProblem('\\href{a}{b}', true)).toBe(FORMULA_HELP);
  });
});
