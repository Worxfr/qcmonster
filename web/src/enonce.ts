import { sanitizeLatex, splitMath, type Segment } from '../../shared/latex';

/**
 * Decoupage d'un enonce d'exercice (une chaine) en contexte, donnees et questions, cote site seulement.
 * Heuristique prudente: le texte n'est jamais reecrit, seulement reparti. `null` si rien n'est reconnu
 * (l'ecran garde alors l'affichage d'un seul bloc). Le texte passe d'abord par le filtre LaTeX partage.
 * shortcut: heuristique sur le francais ecrit par le modele; si l'API renvoie un jour un enonce structure, l'utiliser a la place.
 */
export type Sentence = Segment[];
export interface Donnee { label?: string; tex: string }
export interface Enonce {
  /** Paragraphes de contexte (phrases dans l'ordre). */
  contexte: Sentence[];
  donnees: Donnee[];
  questions: Sentence[];
}

const OPEN = '\uE000';
const CLOSE = '\uE001';
const MAX_DATA = 12;

/** Verbes d'ordre et mots interrogatifs qui ouvrent une question. */
const ASK_START = /^(?:calcul|d[ée]termin|trouv|d[ée]duis|d[ée]duir|exprim|donn|justifi|montr|explic|d[ée]montr|r[ée]sou|v[ée]rifi|compar|estim|convertis|convertir|repr[ée]sent|indiqu|identifi|pr[ée]cis|quel|combien|que |qu'|comment|pourquoi|o[uù] |[ée]cri|complet|trac|construis|d[ée]cri|nomm|cit|class|proposez?|en d[ée]duire|puis,? )/i;
const isAsk = (plain: string): boolean => /\?\s*$/.test(plain) || ASK_START.test(plain.trim());

const LEAD_NUM = /^\s*(?:[-•*]\s+|(?:\d{1,2}|[a-h])\s?[).]\s+)/;
const UNIT_WRAP = /\\(?:mathrm|text|textrm|rm|mathit)\{(?:[^{}]|\{[^{}]*\})*\}/g;

/** Formule `symbole = valeur unite` (valeur seulement faite de nombres, d'unites et de signes): une donnee, pas une relation. */
export function dataFormula(m: string): boolean {
  const parts = m.split('=');
  if (parts.length !== 2) return false;
  const lhs = parts[0].trim();
  const rhs = parts[1].replace(UNIT_WRAP, '').replace(/\\(?:times|cdot|pm|approx|sim|%|[,;:! ])/g, '').replace(/[\d\s.,{}^+\-−~%]/g, '');
  return lhs.length > 0 && lhs.length <= 24 && /\d/.test(parts[1]) && !/\\(?:frac|dfrac|sum|int)/.test(lhs) && rhs === '' && !/\\ne|\\le|\\ge/.test(m);
}

/** Formule longue ou a fraction: affichee sur sa propre ligne quand elle termine une phrase. */
export const isBigFormula = (m: string): boolean => /\\(?:d?frac|sum|int|sqrt|lim|vec)/.test(m) || m.length > 24;

const plainOf = (s: Sentence): string => s.map((x) => ('text' in x ? x.text : ' ')).join('').replace(/\s+/g, ' ').trim();

/** Phrases (hors formules): coupe apres `. ? !` suivi d'une majuscule, et a chaque saut de ligne. */
function sentences(segs: Segment[]): Sentence[] {
  const math: string[] = [];
  const flat = segs.map((s) => ('text' in s ? s.text : `${OPEN}${math.push(s.math) - 1}${CLOSE}`)).join('');
  const out: Sentence[] = [];
  for (const line of flat.split(/\n+/)) {
    for (const piece of line.split(/(?<=[.?!…])\s+(?=[A-ZÀ-ÝÉ«"(\d]|\uE000)/u)) {
      const cleaned = piece.replace(LEAD_NUM, '').trim();
      if (!cleaned) continue;
      const rebuilt: Sentence = [];
      // `split` avec groupe capturant: texte aux rangs pairs, indice de formule aux rangs impairs
      const bits = cleaned.split(new RegExp(`${OPEN}(\\d+)${CLOSE}`));
      bits.forEach((b, i) => {
        if (i % 2 === 0) { if (b) rebuilt.push({ text: b }); } else rebuilt.push({ math: math[Number(b)] });
      });
      out.push(rebuilt);
    }
  }
  return out;
}

const QUALIF = /^\s*((?:à|pour|en|sous|avec)\s[^,;.]+?)\s*(?:[,;]|\b(?:et|ou)\b)?\s*[.]?\s*$/i;
const cap = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);
const words = (t: string) => t.split(/\s+/).filter(Boolean);

/** Texte qui precede une valeur -> nom de la grandeur (`label`) et reste de la phrase (`rest`). `undefined`: pas de decoupe sure. */
function cutLabel(buf: string): { label?: string; rest: string } | undefined {
  const t = buf.replace(/\s+/g, ' ').replace(/\b(?:vaut|valent|est|sont|[ée]gale?s?|de|du|des|d'|à)\s*[:=]?\s*$/i, '').replace(/[\s,;:.]+$/, '').replace(/^[\s,;:.]+/, '').trim();
  if (!t) return { rest: '' };
  const verbal = /\b(?:vaut|valent|[ée]gale?s?|est|sont)\s*[:=]?\s*$/i.test(buf.trim()) || /[:=]\s*$/.test(buf.trim());
  const lead = t.replace(/^(?:sa|son|ses|le|la|les|l'|un|une)\s+/i, '');
  if (verbal && words(lead).length <= 5 && !/\b(?:est|sont|place|placée|dans|sur)\b/i.test(lead)) return { label: cap(lead), rest: '' };
  const m = /^(.*\S)\s+(?:de|du|des|d')\s*((?:\S+\s+){0,2}\S+)$/.exec(t);
  return m ? { label: cap(m[2]), rest: m[1] } : undefined;
}

/** Une phrase qui ne contient que des valeurs `symbole = valeur`: elle est decoupee en contexte (reste) et lignes de donnees. `undefined`: on la garde telle quelle. */
function splitData(s: Sentence): { rest: string[]; data: Donnee[] } | undefined {
  const items: { buf: string; tex: string }[] = [];
  let buf = '';
  for (const x of s) {
    if ('text' in x) buf += x.text;
    else if (dataFormula(x.math)) { items.push({ buf, tex: x.math }); buf = ''; } else return undefined;
  }
  if (items.length === 0) return undefined;
  const data: Donnee[] = [];
  const rest: string[] = [];
  const base: (string | undefined)[] = [];
  const qual: (string | undefined)[] = items.map(() => undefined);
  const tail = QUALIF.exec(buf);
  if (tail) qual[items.length - 1] = tail[1].trim();
  else if (buf.replace(/[\s.,;:]/g, '')) rest.push(buf.trim());
  for (let i = 0; i < items.length; i++) {
    const q = i > 0 ? QUALIF.exec(items[i].buf) : null;
    if (q) { qual[i - 1] = q[1].trim(); base[i] = qual[i - 1] !== undefined ? base[i - 1] : undefined; continue; }
    if (i > 0 && !items[i].buf.replace(/\b(?:et|ou)\b|[\s.,;:]/gi, '')) { base[i] = undefined; continue; }
    const c = cutLabel(items[i].buf);
    if (!c) return undefined;
    base[i] = c.label;
    if (c.rest) rest.push(c.rest + '.');
  }
  items.forEach((it, i) => data.push({ ...(base[i] ? { label: base[i] + (qual[i] ? ` (${qual[i]})` : '') } : {}), tex: it.tex }));
  return { rest, data };
}

export function parseEnonce(raw: string): Enonce | null {
  try {
    const clean = sanitizeLatex(raw.replace(/[\uE000\uE001]/g, ''));
    const segs = splitMath(clean);
    if (!segs) return null;
    const all = sentences(segs);
    if (all.length === 0) return null;

    // les questions: de la premiere phrase d'ordre ou interrogative jusqu'a la fin, sauf les rappels qui la suivent
    const first = all.findIndex((s) => isAsk(plainOf(s)));
    const contexte: Sentence[] = [];
    const questions: Sentence[] = [];
    const donnees: Donnee[] = [];
    all.forEach((s, i) => {
      if (first >= 0 && i >= first && isAsk(plainOf(s))) { questions.push(s); return; }
      const sp = splitData(s);
      if (sp) {
        donnees.push(...sp.data);
        for (const r of sp.rest) contexte.push([{ text: r }]);
        return;
      }
      contexte.push(s);
      for (const x of s) if ('math' in x && dataFormula(x.math)) donnees.push({ tex: x.math });
    });

    // rien de plus clair a montrer: on laisse l'affichage d'un seul bloc
    if (questions.length === 0 && donnees.length === 0) return null;
    if (donnees.length > MAX_DATA) return null; // trop de valeurs pour une liste lisible
    return { contexte, donnees, questions };
  } catch {
    return null;
  }
}
