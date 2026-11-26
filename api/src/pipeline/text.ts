// Traitement de texte du pipeline: normalisation, phrases numerotees, extraction JSON de la sortie d'un modele.
import type { ZodType } from 'zod';

/** Minuscules, sans accents ni ponctuation, espaces simples. Sert aux comparaisons (ancrage, trous, empreinte). */
export function normalize(s: string): string {
  return s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

export const words = (s: string): string[] => normalize(s).split(' ').filter(Boolean);

export const MAX_SENTENCE = 2000;

/** Decoupe un texte en phrases (retours a la ligne, puis ponctuation forte suivie d'une majuscule ou d'un chiffre). */
export function splitSentences(text: string): string[] {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    for (const part of line.split(/(?<=[.!?…])\s+(?=[A-ZÀ-ÝÇ0-9«"(])/u)) {
      const t = part.trim();
      if (t) out.push(t.slice(0, MAX_SENTENCE));
    }
  }
  return out;
}

export const sentenceId = (page: number, n: number): string => `p${page}-s${n}`;

/** Sortie du modele illisible (pas de JSON, JSON invalide ou hors schema). */
export class ModelOutputError extends Error {
  // Le nom voyage dans l'erreur Step Functions (`error.Error`): `failJob` s'en sert pour un message precis a l'eleve.
  override name = 'ModelOutputError';
}

/** Premier objet JSON de la sortie d'un modele (ignore le texte autour et les blocs ```), valide par `schema`. */
export function parseModelJson<T>(raw: string, schema: ZodType<T>): T {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new ModelOutputError('sortie du modele sans JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new ModelOutputError('sortie du modele: JSON invalide');
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new ModelOutputError('sortie du modele: schema invalide');
  return r.data;
}

/**
 * Sortie coupee par la limite de jetons (JSON jamais referme): recupere les objets COMPLETS du tableau `key`.
 * Ne renvoie que ce que `JSON.parse` accepte objet par objet; `undefined` si aucun objet entier n'a ete recu.
 * shortcut: une chaine contenant des accolades est geree (guillemets suivis), mais pas un tableau imbrique dans un objet de la liste.
 */
export function salvageTruncatedList(raw: string, key: string): unknown[] | undefined {
  const m = new RegExp(`"${key}"\\s*:\\s*\\[`).exec(raw);
  if (!m) return undefined;
  const items: unknown[] = [];
  let depth = 0;
  let inStr = false;
  let esc = false;
  let from = -1;
  for (let k = m.index + m[0].length; k < raw.length; k++) {
    const c = raw[k];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '{') {
      if (depth++ === 0) from = k;
    } else if (c === '}' && depth > 0 && --depth === 0) {
      try {
        items.push(JSON.parse(raw.slice(from, k + 1)));
      } catch {
        /* objet abime: ignore */
      }
    } else if (c === ']' && depth === 0) break;
  }
  return items.length > 0 ? items : undefined;
}

// ---------------------------------------------------------------- tranches d'une section dense (F11)
/** Tranche d'extraction: au plus 30 phrases et 6 000 caracteres (une phrase plus longue a sa propre tranche). */
export const SLICE_SENTENCES = 30;
export const SLICE_CHARS = 6000;
export interface SliceRange {
  start: number;
  end: number;
}

/** Decoupe `lengths.length` phrases consecutives en tranches [start, end[ (jamais vides, couvrant tout, sans trou ni recouvrement). */
export function sliceRanges(lengths: number[], maxSentences = SLICE_SENTENCES, maxChars = SLICE_CHARS): SliceRange[] {
  const out: SliceRange[] = [];
  let start = 0;
  let chars = 0;
  lengths.forEach((len, n) => {
    if (n > start && (n - start >= maxSentences || chars + len > maxChars)) {
      out.push({ start, end: n });
      start = n;
      chars = 0;
    }
    chars += len;
  });
  if (lengths.length > 0) out.push({ start, end: lengths.length });
  return out;
}

/** Garde `max` elements repartis regulierement sur toute la liste (ordre conserve): une section dense reste couverte de bout en bout. */
export function thinEvenly<T>(list: T[], max: number): T[] {
  if (list.length <= max) return list;
  return Array.from({ length: max }, (_, k) => list[Math.floor((k * list.length) / max)]);
}

// ---------------------------------------------------------------- lecture d'un scan comme un seul document (FEAT-A, lot B1)
export interface ReadPage {
  page: number;
  lines: string[];
  /** « la premiere ligne de cette page continue la derniere ligne de la page precedente » (indication du modele, controlee par le code). */
  suite: boolean;
}
export interface AssembledSentence {
  id: string;
  text: string;
  /** Pages d'origine d'une phrase recollee (consecutives, la premiere = celle de l'identifiant). Absent: une seule page. */
  pages?: number[];
}
export interface AssembledPage {
  page: number;
  sentences: AssembledSentence[];
}
export const MAX_GLUED_PAGES = 4;
const SENTENCE_END = /[.!?…]$/u;

/**
 * Phrases numerotees de toutes les pages, avec le recollage fait par le code: la premiere phrase d'une page `suite` est jointe a la derniere
 * phrase du texte seulement si celle-ci ne finit pas par . ! ? … , si les pages se suivent, si le resultat tient en 2000 caracteres et en
 * 4 pages. Un trait d'union de fin de ligne est recolle sans espace (le trait d'union est garde: on ne corrige pas le texte). La phrase
 * recollee garde l'identifiant de sa premiere page; la page suivante est renumeroteee sans trou a partir de s1 (sa premiere phrase est
 * absorbee). Pages triees numeriquement (jamais lexicalement).
 */
export function assemblePages(read: ReadPage[]): AssembledPage[] {
  const out: AssembledPage[] = [];
  let tail: AssembledSentence | undefined; // derniere phrase du texte lu jusqu'ici
  let tailLastPage = 0; // derniere page couverte par `tail`
  for (const p of [...read].sort((a, b) => a.page - b.page)) {
    const parts = splitSentences(p.lines.join('\n'));
    const first = parts[0];
    if (p.suite && tail && first !== undefined && tailLastPage === p.page - 1 && !SENTENCE_END.test(tail.text) && (tail.pages ?? [tailLastPage]).length < MAX_GLUED_PAGES) {
      const joined = tail.text.endsWith('-') ? `${tail.text}${first}` : `${tail.text} ${first}`;
      if (joined.length <= MAX_SENTENCE) {
        tail.text = joined;
        tail.pages = [...(tail.pages ?? [tailLastPage]), p.page];
        tailLastPage = p.page;
        parts.shift();
      }
    }
    const sentences: AssembledSentence[] = parts.map((text, k) => ({ id: sentenceId(p.page, k + 1), text }));
    out.push({ page: p.page, sentences });
    if (sentences.length) {
      tail = sentences[sentences.length - 1];
      tailLastPage = p.page;
    } // page vide: `tailLastPage` reste en arriere, la page suivante ne se recolle pas (les pages doivent se suivre)
  }
  return out;
}
