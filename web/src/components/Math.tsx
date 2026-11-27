import { useMemo, type ReactNode } from 'react';
import katex from 'katex';
import { isSafeFormula, sanitizeFormulaBlock, sanitizeLatex, splitMath } from '../../../shared/latex';

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
  if (!isSafeFormula(tex)) return null;
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
// Le filtre est celui du serveur (`shared/latex.ts`), reapplique ici quelle que soit la provenance du texte (defense en profondeur).
// `tail`: marque collee au dernier mot (ou a la derniere formule), jamais seule en debut de ligne.
export function Rich({ text, formula = false, tail }: { text: string; formula?: boolean; tail?: ReactNode }) {
  if (formula) {
    const src = sanitizeFormulaBlock(text);
    return src === undefined ? <code className="math-fallback">{text}</code> : <Formula tex={src} display />;
  }
  const seg = splitMath(sanitizeLatex(text)) ?? [{ text }];
  return (
    <>
      {seg.map((s, i) => {
        const last = i === seg.length - 1;
        if (!('text' in s)) return last && tail ? <span key={i} className="nw"><Formula tex={s.math} />{tail}</span> : <Formula key={i} tex={s.math} />;
        if (!last || !tail) return <span key={i}>{s.text}</span>;
        const m = /^([\s\S]*?)(\S*)$/.exec(s.text) ?? [s.text, '', ''];
        return <span key={i}>{m[1]}<span className="nw">{m[2]}{tail}</span></span>;
      })}
    </>
  );
}
