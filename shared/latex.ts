// Controle du LaTeX des textes de cours (R1, docs/R1-design.md 2.7). Fonctions pures, partagees par le serveur et le site.
// La barriere de securite est `trust: false` de KaTeX cote site; cette liste est une defense en profondeur.

export const MAX_FORMULA = 500;
export const MAX_TEXT = 2000;
export const MAX_DEPTH = 8;

/** Commandes interdites, comparees par NOM ENTIER (jamais par sous-chaine: `\idotsint`, `\defeq`, `\letter` restent permis). */
const FORBIDDEN = new Set([
  'href', 'url', 'includegraphics', 'input', 'include', 'write', 'def', 'edef', 'gdef', 'xdef', 'let',
  'newcommand', 'renewcommand', 'providecommand', 'csname', 'read', 'catcode', 'style', 'class', 'data', 'id', 'cssId',
]);
const isForbidden = (name: string): boolean => FORBIDDEN.has(name) || name.startsWith('html');

// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/;

/** Une formule (source sans delimiteurs) est acceptable: longueur, caracteres, accolades equilibrees (profondeur 8 au plus), commandes permises. */
export function isSafeFormula(src: string): boolean {
  if (src.length === 0 || src.length > MAX_FORMULA || CONTROL.test(src) || /[\r\n]/.test(src)) return false;
  let depth = 0;
  for (let k = 0; k < src.length; k++) {
    const c = src[k];
    if (c === '\\') {
      k++; // le caractere suivant est echappe (`\{`, `\}`, `\$`): il ne compte pas
      continue;
    }
    if (c === '{') {
      if (++depth > MAX_DEPTH) return false;
    } else if (c === '}' && --depth < 0) return false;
  }
  if (depth !== 0) return false;
  for (const m of src.matchAll(/\\([a-zA-Z]+)/g)) if (isForbidden(m[1])) return false;
  return true;
}

export type Segment = { text: string } | { math: string };

/**
 * Separe un texte en segments de texte et de formule (`$...$`). `undefined` si les `$` ne sont pas en nombre pair.
 * Hors formule: `\$` est un dollar litteral et `\\` un antislash litteral (les autres `\x` restent tels quels). Dans une formule, chaque paire
 * `\x` est gardee telle quelle pour KaTeX (`\\` est un saut de ligne, `\$` un dollar): une formule peut donc finir par `\\` avant son `$` fermant.
 */
export function splitMath(text: string): Segment[] | undefined {
  const out: Segment[] = [];
  let cur = '';
  let inMath = false;
  for (let k = 0; k < text.length; k++) {
    const c = text[k];
    const n = text[k + 1];
    if (c === '\\' && n !== undefined && inMath) {
      cur += c + n;
      k++;
    } else if (c === '\\' && (n === '$' || n === '\\')) {
      cur += n;
      k++;
    } else if (c === '$') {
      if (inMath) out.push({ math: cur });
      else if (cur) out.push({ text: cur });
      cur = '';
      inMath = !inMath;
    } else cur += c;
  }
  if (inMath) return undefined;
  if (cur) out.push({ text: cur });
  return out;
}

/** Ecrit un texte simple pour `splitMath`: l'antislash est double AVANT que le dollar soit echappe (sinon `\\$` serait relu comme un dollar echappe). */
export const escapeText = (t: string): string => t.replace(/\\/g, '\\\\').replace(/\$/g, '\\$');

/** Contenu d'une formule refusee, lu comme texte simple: seul `\$` redevient `$` (les autres paires sont gardees). */
const mathToText = (m: string): string => {
  let out = '';
  for (let k = 0; k < m.length; k++) {
    if (m[k] === '\\' && m[k + 1] === '$') {
      out += '$';
      k++;
    } else if (m[k] === '\\' && m[k + 1] !== undefined) {
      out += m[k] + m[k + 1];
      k++;
    } else out += m[k];
  }
  return out;
};

/** Retire les `$` non echappes (nombre impair): les paires `\x` sont sautees, jamais coupees. */
const dropBareDollars = (t: string): string => {
  let out = '';
  for (let k = 0; k < t.length; k++) {
    if (t[k] === '\\' && t[k + 1] !== undefined) {
      out += t[k] + t[k + 1];
      k++;
    } else if (t[k] !== '$') out += t[k];
  }
  return out;
};

/** Texte accepte tel quel: longueur, caracteres, `$` pairs et chaque formule sure. Sert a refuser une correction de l'eleve (400). */
export function isSafeText(text: string): boolean {
  if (text.length > MAX_TEXT || CONTROL.test(text)) return false;
  const seg = splitMath(text);
  return seg !== undefined && seg.every((s) => !('math' in s) || isSafeFormula(s.math));
}

/**
 * Texte ecrit par le modele: une formule qui ne passe pas perd ses delimiteurs et reste du texte simple (jamais rejetee);
 * `$` impair: tous les `$` non echappes sont retires. Les caracteres de controle sont retires. Ne renvoie jamais de `$` non echappe seul.
 */
export function sanitizeLatex(text: string): string {
  const clean = text.replace(new RegExp(CONTROL.source, 'g'), '').slice(0, MAX_TEXT);
  const seg = splitMath(clean);
  if (seg === undefined) return dropBareDollars(clean);
  return seg.map((s) => ('text' in s ? escapeText(s.text) : isSafeFormula(s.math) ? `$${s.math}$` : escapeText(mathToText(s.math)))).join('');
}

/** Source d'un bloc `formule` (sans delimiteurs): la source si elle est sure, sinon `undefined` (le bloc devient un paragraphe de texte simple). */
export function sanitizeFormulaBlock(src: string): string | undefined {
  const s = src.trim();
  return isSafeFormula(s) ? s : undefined;
}

/** Texte sans ses formules (recherche de sources: les segments `$...$` n'y servent a rien). */
export function stripFormulas(text: string): string {
  const seg = splitMath(text);
  if (!seg) return text;
  return seg.flatMap((s) => ('text' in s ? [s.text] : [])).join(' ').replace(/\s+/g, ' ').trim();
}

export const hasFormula = (text: string): boolean => splitMath(text)?.some((s) => 'math' in s) ?? false;
