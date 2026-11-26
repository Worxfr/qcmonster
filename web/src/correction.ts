// Controle d'une correction de l'eleve. La regle (LaTeX, `$`) est celle du serveur: `shared/latex.ts`, un seul filtre pour le site et l'API.
import { MAX_FORMULA, MAX_TEXT, isSafeFormula, isSafeText, splitMath } from '../../shared/latex';

export const FORMULA_HELP = `La formule n'est pas acceptée : elle doit faire ${MAX_FORMULA} caractères au plus, avoir ses accolades bien fermées et n'utiliser que des commandes courantes (pas de lien, ni de \\href, \\url, \\def…).`;
export const DOLLAR_HELP = 'Il y a un « $ » tout seul. Pour écrire le signe dollar, tape « \\$ ». Pour une formule, mets-la entre deux « $ ».';

/** null = acceptée. `formula`: le texte est du LaTeX sans délimiteurs (bloc `formule`). Même résultat que le 400 du serveur. */
export function correctionProblem(text: string, formula = false): string | null {
  if (formula) return isSafeFormula(text.trim()) ? null : FORMULA_HELP;
  if (text.length > MAX_TEXT) return `Une phrase ne peut pas dépasser ${MAX_TEXT} caractères.`;
  const seg = splitMath(text);
  if (!seg) return DOLLAR_HELP;
  if (seg.some((s) => 'math' in s && !isSafeFormula(s.math))) return FORMULA_HELP;
  return isSafeText(text) ? null : 'Il y a un caractère invisible dans la phrase.';
}
