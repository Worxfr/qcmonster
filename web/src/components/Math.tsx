import { useMemo } from 'react';
import katex from 'katex';
import { checkFormula, splitMath } from '../latex';

/**
 * Seul endroit du site qui injecte du HTML: la chaine produite par KaTeX (MathML), jamais un texte de l'eleve ou du modele.
 * Les options sont ecrites en clair a CHAQUE appel (jamais une valeur par defaut ni une option partagee).
 * `throwOnError: true` + try/catch: en cas d'echec la formule est rendue comme TEXTE par React.
 * Pas de `style` en ligne: la politique de securite du site refuse `style-src 'unsafe-inline'` (d'ou `output: 'mathml'`).
 */
// Chromium transforme une lettre seule d'un <mi> en « lettre mathematique italique » (µ -> U+1D707, text-transform: math-auto);
// sans police mathematique l'appareil affiche alors un carre vide. On marque ces lettres (`mi-i`): style.css coupe la
// transformation et leur donne la police KaTeX_Math (italique, servie en 'self'). Les <mi> de plusieurs lettres (sin) ne sont pas touches.
const SINGLE_MI = /<mi>([^<>&])<\/mi>/gu;
const marked = (html: string) => html.replace(SINGLE_MI, '<mi class="mi-i">$1</mi>');

export function renderMathml(tex: string, display: boolean): string | null {
  if (checkFormula(tex)) return null;
  try {
    return marked(katex.renderToString(tex, { trust: false, throwOnError: true, maxSize: 10, maxExpand: 1000, strict: 'ignore', output: 'mathml', displayMode: display }));
  } catch {
    return null;
  }
}

export function Formula({ tex, display = false }: { tex: string; display?: boolean }) {
  const html = useMemo(() => renderMathml(tex, display), [tex, display]);
  if (html === null) return <code className="math-fallback">{tex}</code>;
  return <span className={display ? 'math math-display' : 'math'} dangerouslySetInnerHTML={{ __html: html }} />;
}

/** Texte avec formules `$...$`: le texte est rendu par React (echappe), les formules par KaTeX. `formula`: tout le texte est du LaTeX (bloc `formule`). */
export function Rich({ text, formula = false }: { text: string; formula?: boolean }) {
  if (formula) return <Formula tex={text} display />;
  return (
    <>
      {splitMath(text).map((s, i) => (s.kind === 'text' ? <span key={i}>{s.text}</span> : <Formula key={i} tex={s.tex} />))}
    </>
  );
}
