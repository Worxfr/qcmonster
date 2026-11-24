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

const MAX_SENTENCE = 2000;

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

/** Premier objet JSON de la sortie d'un modele (ignore le texte autour et les blocs ```), valide par `schema`. */
export function parseModelJson<T>(raw: string, schema: ZodType<T>): T {
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start < 0 || end <= start) throw new Error('sortie du modele sans JSON');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new Error('sortie du modele: JSON invalide');
  }
  const r = schema.safeParse(parsed);
  if (!r.success) throw new Error('sortie du modele: schema invalide');
  return r.data;
}
