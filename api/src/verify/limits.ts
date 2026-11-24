// Limites de l'outil de recherche (design-v2 4.3, revue C7). Partagees avec la stack CDK.

/** Concurrence reservee de verify-run (CDK) et plafond total de requetes MediaWiki par seconde (design 4.3). */
export const VERIFY_RESERVED_CONCURRENCY = 2;
export const MEDIAWIKI_MAX_RPS_TOTAL = 5;

/**
 * Requetes par fenetre d'une seconde pour UNE instance: le total sur toutes les instances reservees reste <= 5/s.
 * Ici floor(5 / 2) = 2, soit un intervalle de 500 ms entre deux requetes d'une instance (fenetre glissante, pas une moyenne).
 */
export const perInstanceRps = (total = MEDIAWIKI_MAX_RPS_TOTAL, concurrency = VERIFY_RESERVED_CONCURRENCY): number => Math.max(1, Math.floor(total / concurrency));
export const minIntervalMs = (total = MEDIAWIKI_MAX_RPS_TOTAL, concurrency = VERIFY_RESERVED_CONCURRENCY): number => Math.ceil(1000 / perInstanceRps(total, concurrency));

export const FETCH_TIMEOUT_MS = 5000;
export const FETCH_MAX_BYTES = 64 * 1024;
/** Passages gardes par affirmation (le modele de jugement en recoit au plus ce nombre). */
export const MAX_PASSAGES_PER_CLAIM = 4;
/** Affirmations par appel de jugement (design 4.1: deux appels au-dela de 25). */
export const CLAIMS_PER_CALL = 25;
export const CACHE_TTL_DAYS = 30;

/** Espace de temps entre deux requetes sortantes d'une instance, serialisees (MediaWiki recommande des requetes en serie). */
export function createRateLimiter(intervalMs: number, now: () => number = Date.now, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): () => Promise<void> {
  let next = 0;
  return async () => {
    const t = now();
    const start = Math.max(t, next);
    next = start + intervalMs; // creneau reserve avant toute attente: deux appels simultanes ne partagent pas un creneau
    if (start > t) await sleep(start - t);
  };
}
