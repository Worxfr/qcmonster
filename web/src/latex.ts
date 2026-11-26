// Controle et decoupage du LaTeX (design R1 §2.7). Fonctions pures, sans KaTeX.
// shortcut: copie cote site de `sanitizeLatex`; le lot A l'ajoute dans `shared/latex.ts` (une seule regle pour le site et l'API).
// Quand ce fichier existera, remplacer le corps de checkFormula par l'import partage et supprimer la copie.

export const FORMULA_MAX = 500;
export const SENTENCE_MAX = 2000;
const DEPTH_MAX = 8;

/** Commandes refusees, comparees par NOM ENTIER (jamais par prefixe, sauf `html*`). La barriere reste `trust: false`. */
const FORBIDDEN = new Set([
  'href', 'url', 'includegraphics', 'input', 'include', 'write', 'def', 'edef', 'gdef', 'xdef', 'let',
  'newcommand', 'renewcommand', 'providecommand', 'csname', 'read', 'catcode', 'style', 'class', 'data', 'id', 'cssId',
]);

export type Seg = { kind: 'text'; text: string } | { kind: 'math'; tex: string };

/** null si la formule (sans delimiteurs) est acceptable, sinon la raison en francais. */
export function checkFormula(tex: string): string | null {
  if (tex.trim() === '') return 'La formule est vide.';
  if (tex.length > FORMULA_MAX) return `Une formule ne peut pas dépasser ${FORMULA_MAX} caractères.`;
  // eslint-disable-next-line no-control-regex
  if (/[\u0000-\u001f\u007f]/.test(tex)) return 'La formule contient un caractère invisible.';
  let depth = 0;
  for (let i = 0; i < tex.length; i++) {
    const c = tex[i];
    if (c === '\\') { i++; continue; } // `\{` et `\}` ne comptent pas
    if (c === '{') {
      depth++;
      if (depth > DEPTH_MAX) return 'La formule est trop imbriquée.';
    } else if (c === '}') {
      depth--;
      if (depth < 0) return 'Il manque une accolade « { » dans la formule.';
    }
  }
  if (depth !== 0) return 'Il manque une accolade « } » dans la formule.';
  for (const m of tex.matchAll(/\\([a-zA-Z]+)/g)) {
    if (FORBIDDEN.has(m[1]) || m[1].startsWith('html')) return `La commande « \\${m[1]} » n'est pas permise.`;
  }
  return null;
}

/** Positions des `$` non echappes. */
function dollars(s: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\\') i++;
    else if (s[i] === '$') out.push(i);
  }
  return out;
}
const unescape = (s: string) => s.replace(/\\\$/g, '$');

/**
 * Coupe un texte en segments: le texte est rendu par React (echappe), seuls les segments `math` passent par KaTeX.
 * Un nombre impair de `$` laisse tout en texte. Un `$` suivi (ou precede) d'une espace est un dollar litteral (« 5 $ et 6 $ »).
 * Une formule refusee par checkFormula perd ses delimiteurs et reste du texte simple.
 */
export function splitMath(text: string): Seg[] {
  const d = dollars(text);
  if (d.length % 2 === 1 || d.length === 0) return [{ kind: 'text', text: unescape(text) }];
  const out: Seg[] = [];
  let buf = '';
  const flush = () => { if (buf) out.push({ kind: 'text', text: unescape(buf) }); buf = ''; };
  const open = (i: number) => i + 1 < text.length && !/\s/.test(text[i + 1]);
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') { buf += text.slice(i, i + 2); i += 2; continue; }
    if (text[i] === '$' && open(i)) {
      const close = d.find((p) => p > i + 1 && !/\s/.test(text[p - 1]));
      if (close !== undefined) {
        const tex = text.slice(i + 1, close);
        if (checkFormula(tex)) buf += tex; // refusee: delimiteurs retires
        else { flush(); out.push({ kind: 'math', tex }); }
        i = close + 1;
        continue;
      }
    }
    buf += text[i];
    i++;
  }
  flush();
  return out;
}

/** Controle d'une correction de l'eleve. null = acceptee. `formula`: le texte est du LaTeX sans delimiteurs (bloc `formule`). */
export function checkCorrection(text: string, formula = false): string | null {
  if (text.length > SENTENCE_MAX) return `Une phrase ne peut pas dépasser ${SENTENCE_MAX} caractères.`;
  if (formula) return checkFormula(text);
  const d = dollars(text);
  if (d.length % 2 === 1) return 'Il y a un « $ » tout seul. Pour écrire le signe dollar, tape « \\$ ». Pour une formule, mets-la entre deux « $ ».';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '\\') { i += 2; continue; }
    if (text[i] === '$' && i + 1 < text.length && !/\s/.test(text[i + 1])) {
      const close = d.find((p) => p > i + 1 && !/\s/.test(text[p - 1]));
      if (close !== undefined) {
        const why = checkFormula(text.slice(i + 1, close));
        if (why) return why;
        i = close + 1;
        continue;
      }
    }
    i++;
  }
  return null;
}
