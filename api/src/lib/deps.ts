import { randomBytes, randomUUID } from 'node:crypto';
import type { QuotaDb } from '../../../shared/quota.js';
import type { Env } from '../../../shared/names.js';
import type { Store } from './store.js';

/** Dependances injectees: vraies en production (handlers/), fausses dans les tests. */
export interface Deps {
  store: Store;
  quota: QuotaDb;
  env: Env;
  now: () => Date;
  /** Identifiant d'eleve, de famille ou de signalement: aleatoire, au format des identifiants du contrat. */
  newId: () => string;
  /** Jeton d'activation en clair (256 bits, base64url). */
  newToken: () => string;
  /** 5 caracteres de LOGIN_SUFFIX_ALPHABET pour le suffixe de l'identifiant de connexion. */
  suffix: () => string;
}

/** Alphabet du suffixe: sans 0 o 1 l i (31 caracteres). */
export const LOGIN_SUFFIX_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789';
/** 5 caracteres tires par rejet (on ecarte les octets au-dela du plus grand multiple de 31): aucun biais. */
export function randomSuffix(bytes: (n: number) => Uint8Array = randomBytes): string {
  const n = LOGIN_SUFFIX_ALPHABET.length;
  const limit = 256 - (256 % n);
  let out = '';
  while (out.length < 5) for (const b of bytes(8)) if (b < limit && out.length < 5) out += LOGIN_SUFFIX_ALPHABET[b % n];
  return out;
}

export const realRandom = {
  newId: () => randomUUID(),
  newToken: () => randomBytes(32).toString('base64url'),
  suffix: randomSuffix,
};
