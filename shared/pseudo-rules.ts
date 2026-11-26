// Regles du surnom d'un eleve (ID1, design 4.3 et 4.4). Fonction pure, importee par l'API (qui decide) et par le site (qui guide).
// Le refus ne dit jamais POURQUOI (pas de test de gros mots): `reason` sert aux tests et au code, pas au message montre a l'enfant.
import { BLOCK_CONTAINS, BLOCK_EXACT, BLOCK_STARTS } from './pseudo-blocklist.js';

export type PseudoResult = { ok: true; value: string } | { ok: false; reason: 'forme' | 'mot' | 'personnel' };

export const PSEUDO_MIN = 2;
export const PSEUDO_MAX = 20;
export const PSEUDO_MAX_DIGITS = 2;
/** Message unique et neutre (design 4.3). */
export const PSEUDO_REFUSED_MESSAGE = "Ce surnom n'est pas possible, essaie-en un autre";
export const PSEUDO_TAKEN_MESSAGE = 'Ce surnom est deja pris dans ta famille, essaie-en un autre';

const stripAccents = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '');
const LEET: Record<string, string> = { '0': 'o', '1': 'i', '3': 'e', '4': 'a', '5': 's', '7': 't' };

/** Cle de comparaison d'un surnom (reservation `NAME#`): NFC, sans accent, minuscules, espaces et tirets unifies. */
export function nameKey(name: string): string {
  return stripAccents(name.normalize('NFC')).toLowerCase().replace(/[\s'’-]+/g, '-').replace(/^-|-$/g, '');
}

function hasBlockedWord(name: string): boolean {
  const flat = stripAccents(name).toLowerCase().replace(/[0134-57]/g, (d) => LEET[d] ?? d);
  const words = flat.split(/[^a-z]+/).filter(Boolean);
  const joined = words.join('');
  if (BLOCK_CONTAINS.some((w) => joined.includes(w))) return true;
  if (BLOCK_EXACT.includes(joined) || words.some((w) => BLOCK_EXACT.includes(w))) return true;
  return words.some((w) => BLOCK_STARTS.some((b) => w.startsWith(b)));
}

/** Vrai si `s` n'a que des lettres latines (accents compris), des chiffres, l'espace, le tiret et l'apostrophe, et commence par une lettre latine. */
const FORM = /^\p{Script=Latin}[\p{Script=Latin}0-9 '’-]*$/u;

/**
 * Controle un surnom. `parentEmail` (facultatif): refuse le debut de l'e-mail du parent. Renvoie la valeur nettoyee (NFC, espaces reduits).
 * Les chiffres sont comptes apres retrait des espaces: plus de 2 refuses (annee de naissance, telephone, classe).
 */
export function checkNickname(raw: string, opts: { parentEmail?: string } = {}): PseudoResult {
  const value = raw.normalize('NFC').trim().replace(/\s+/g, ' ');
  const len = [...value].length;
  if (len < PSEUDO_MIN || len > PSEUDO_MAX) return { ok: false, reason: 'forme' };
  // Cf (largeur nulle, marques de direction), controle, marques combinantes restantes apres NFC, emoji: tout cela sort de FORM.
  if (!FORM.test(value) || /[\p{Cf}\p{Cc}\p{M}]/u.test(value)) return { ok: false, reason: 'forme' };
  if ((value.match(/[0-9]/g) ?? []).length > PSEUDO_MAX_DIGITS) return { ok: false, reason: 'personnel' };
  const low = value.toLowerCase();
  if (/@|http|www|\.com|\.fr/.test(low)) return { ok: false, reason: 'personnel' };
  const local = opts.parentEmail?.split('@')[0]?.toLowerCase().replace(/[^a-z0-9]/g, '') ?? '';
  if (local.length >= 3 && stripAccents(low).replace(/[^a-z0-9]/g, '') === local) return { ok: false, reason: 'personnel' };
  if (hasBlockedWord(value)) return { ok: false, reason: 'mot' };
  return { ok: true, value };
}
