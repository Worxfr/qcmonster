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
  /** 4 caracteres [a-z0-9] pour le suffixe du pseudo. */
  suffix: () => string;
}

export const realRandom = {
  newId: () => randomUUID(),
  newToken: () => randomBytes(32).toString('base64url'),
  suffix: () => Array.from(randomBytes(4), (b) => 'abcdefghijklmnopqrstuvwxyz0123456789'[b % 36]).join(''),
};
