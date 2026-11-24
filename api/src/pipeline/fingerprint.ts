// Empreinte anti-doublon (design-v2 7, docs/game-rules.md 7.4): minuscules, sans accents ni ponctuation, mots de moins de
// 3 lettres retires, groupes de 5 mots, MinHash a 64 valeurs. Jaccard estime >= 0,85: la fiche est un doublon (pas d'XP de scan).
import { normalize } from './text.js';

export const MINHASH_SIZE = 64;
export const SHINGLE = 5;
export const DUPLICATE_THRESHOLD = 0.85;

/** Mots significatifs (3 lettres ou plus). */
const tokens = (text: string): string[] => normalize(text).split(' ').filter((w) => w.length >= 3);

/** Groupes de 5 mots consecutifs; un texte plus court donne un seul groupe. */
export function shingles(text: string): Set<string> {
  const t = tokens(text);
  if (t.length === 0) return new Set();
  if (t.length <= SHINGLE) return new Set([t.join(' ')]);
  const out = new Set<string>();
  for (let i = 0; i + SHINGLE <= t.length; i++) out.add(t.slice(i, i + SHINGLE).join(' '));
  return out;
}

/** Hachage 32 bits (FNV-1a). */
function fnv(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
/** 64 fonctions de hachage: melange de 32 bits avec un germe propre a chaque fonction (constantes fixes, resultats stables). */
const SEEDS = Array.from({ length: MINHASH_SIZE }, (_, i) => Math.imul(i + 1, 0x9e3779b1) >>> 0);
function mix(x: number, seed: number): number {
  let h = (x ^ seed) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Empreinte MinHash: 64 entiers (valeurs 32 bits non signees). Texte vide: 64 valeurs maximales. */
export function minhash(text: string): number[] {
  const sh = [...shingles(text)].map(fnv);
  return SEEDS.map((seed) => sh.reduce((m, h) => Math.min(m, mix(h, seed)), 0xffffffff));
}

/** Similarite de Jaccard estimee: part des 64 valeurs egales. */
export function similarity(a: number[], b: number[]): number {
  if (a.length !== MINHASH_SIZE || b.length !== MINHASH_SIZE) throw new RangeError('empreinte de 64 valeurs attendue');
  let same = 0;
  for (let i = 0; i < MINHASH_SIZE; i++) if (a[i] === b[i]) same++;
  return same / MINHASH_SIZE;
}

/** Jaccard exact sur les groupes de 5 mots (reference des tests). */
export function jaccard(a: string, b: string): number {
  const x = shingles(a);
  const y = shingles(b);
  if (x.size === 0 && y.size === 0) return 1;
  let inter = 0;
  for (const s of x) if (y.has(s)) inter++;
  return inter / (x.size + y.size - inter);
}

export const isDuplicate = (a: number[], b: number[]): boolean => similarity(a, b) >= DUPLICATE_THRESHOLD;
