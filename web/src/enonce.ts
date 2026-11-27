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
  const lhsLen = lhs.replace(UNIT_WRAP, '').replace(/\\[ ,;:!]|\s/g, '').length; // sans unites ni espaces: `\varepsilon(450\ \mathrm{nm})` compte 19
  const rhs = parts[1].replace(UNIT_WRAP, '').replace(/\\(?:times|cdot|pm|approx|sim|%|[,;:! ])/g, '').replace(/[\d\s.,{}^+\-−~%]/g, '');
  return lhsLen > 0 && lhsLen <= 24 && /\d/.test(parts[1]) && !/\\(?:frac|dfrac|sum|int)/.test(lhs) && rhs === '' && !/\\ne|\\le|\\ge/.test(m);
}

/** Formule longue ou a fraction: affichee sur sa propre ligne quand elle termine une phrase. */
export const isBigFormula = (m: string): boolean => /\\(?:d?frac|sum|int|sqrt|lim|vec)/.test(m) || m.length > 24;

const plainOf = (s: Sentence): string => s.map((x) => ('text' in x ? x.text : ' ')).join('').replace(/\s+/g, ' ').trim();

/** Phrases (hors formules): coupe apres `. ? !` suivi d'une majuscule, et a chaque saut de ligne, mais jamais juste apres un numero de liste (`1.`). */
function sentences(segs: Segment[]): Sentence[] {
  const math: string[] = [];
  const flat = segs.map((s) => ('text' in s ? s.text : `${OPEN}${math.push(s.math) - 1}${CLOSE}`)).join('');
  const out: Sentence[] = [];
  for (const line of flat.split(/\n+/)) {
    for (const piece of line.split(/(?<=[.?!…])(?<!^\d{1,2}[.)])\s+(?=[A-ZÀ-ÝÉ«"(\d]|\uE000)/u)) {
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

const CONNECTOR_END = /(?:^|\s)(?:avec|et|ou|où|puis|soit)\s*$|[,;:]\s*$/i;
const hasMath = (b: Sentence): boolean => b.some((x) => 'math' in x);

/**
 * Une phrase dont les valeurs `symbole = valeur` sortent en lignes de donnees. Elle reste en contexte SANS ces valeurs:
 * le texte restant garde ses mots, sauf les mots de liaison de fin (« avec », « et », « vaut »...) et ceux qui deviennent le nom de la grandeur.
 * `undefined` si la phrase ne se coupe pas proprement: elle reste alors entiere en contexte, valeurs comprises (pas de doublon).
 */
function splitData(s: Sentence): { rest: Sentence; data: Donnee[] } | undefined {
  const items: { buf: Sentence; tex: string }[] = [];
  let buf: Sentence = [];
  for (const x of s) {
    if ('math' in x && dataFormula(x.math)) { items.push({ buf, tex: x.math }); buf = []; } else buf.push(x);
  }
  if (items.length === 0) return undefined;
  const rest: Sentence = [];
  const addRest = (seg: Sentence) => { if (rest.length) rest.push({ text: ' ' }); rest.push(...seg); };
  const base: (string | undefined)[] = [];
  const qual: (string | undefined)[] = items.map(() => undefined);
  const textOf = (b: Sentence) => plainOf(b);
  const trimConnector = (b: Sentence): Sentence | undefined => { // retire un mot de liaison final; sans liaison et avec un mot ensuite: pas sur
    const out = b.slice();
    const last = out[out.length - 1];
    if (!last || 'math' in last) return out;
    if (!CONNECTOR_END.test(last.text) && /\S/.test(last.text)) return undefined;
    out[out.length - 1] = { text: last.text.replace(CONNECTOR_END, '').replace(/\s+$/, '') };
    return out;
  };

  if (!hasMath(buf)) {
    const tail = QUALIF.exec(textOf(buf));
    if (tail) qual[items.length - 1] = tail[1].trim();
    else if (buf.length && /[\p{L}\d]/u.test(textOf(buf))) addRest([{ text: textOf(buf).replace(/^[\s.,;:]+|[\s]+$/g, '') }]);
  } else addRest(buf);

  for (let i = 0; i < items.length; i++) {
    const b = items[i].buf;
    const t = textOf(b);
    const q = i > 0 && !hasMath(b) ? QUALIF.exec(t) : null;
    if (q) { qual[i - 1] = q[1].trim(); base[i] = base[i - 1]; continue; }
    if (i > 0 && !hasMath(b) && !t.replace(/\b(?:et|ou)\b|[\s.,;:]/gi, '')) { base[i] = undefined; continue; }
    if (hasMath(b)) { // des formules non-donnees dans le texte qui precede: il reste en contexte, sans nom de grandeur
      const c = trimConnector(b);
      if (!c) return undefined;
      if (i === 0) rest.length = 0;
      addRest(c);
      base[i] = undefined;
      continue;
    }
    const c = cutLabel(t);
    if (!c) {
      // aucun nom sur: seuls des mots de liaison de fin sont admis (« Un triangle ... avec »)
      const tc = trimConnector(b);
      if (!tc || !CONNECTOR_END.test(t)) return undefined;
      addRest(tc);
      base[i] = undefined;
      continue;
    }
    base[i] = c.label;
    if (c.rest) addRest([{ text: c.rest }]);
  }
  if (rest.length) {
    const last = rest[rest.length - 1];
    if ('text' in last && !/[.?!…]\s*$/.test(last.text)) rest.push({ text: '.' });
    else if ('math' in last) rest.push({ text: '.' });
  }
  const data = items.map((it, i): Donnee => ({ ...(base[i] ? { label: base[i] + (qual[i] ? ` (${qual[i]})` : '') } : {}), tex: it.tex }));
  return { rest, data };
}

/** Deux donnees de meme symbole sans noms differents restent distinguables: numerotees. */
function distinguish(d: Donnee[]): Donnee[] {
  const sym = (x: Donnee) => x.tex.split('=')[0].replace(/\s/g, '');
  const group = new Map<string, Donnee[]>();
  for (const x of d) group.set(sym(x), [...(group.get(sym(x)) ?? []), x]);
  const seen = new Map<string, number>();
  return d.map((x) => {
    const g = group.get(sym(x))!;
    if (g.length < 2 || (g.every((y) => y.label) && new Set(g.map((y) => y.label)).size === g.length)) return x;
    const n = (seen.get(sym(x)) ?? 0) + 1;
    seen.set(sym(x), n);
    return { ...x, label: `${x.label ?? 'Valeur'} n°${n}` };
  });
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
        if (sp.rest.length) contexte.push(sp.rest);
        return;
      }
      contexte.push(s); // phrase gardee entiere, ses valeurs aussi: jamais en double dans la liste
    });

    // rien de plus clair a montrer: on laisse l'affichage d'un seul bloc
    if (questions.length === 0 && donnees.length === 0) return null;
    if (donnees.length > MAX_DATA) return null; // trop de valeurs pour une liste lisible
    return { contexte, donnees: distinguish(donnees), questions };
  } catch {
    return null;
  }
}
