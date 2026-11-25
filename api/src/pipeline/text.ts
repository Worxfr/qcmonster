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
export class ModelOutputError extends Error {}

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
