// Lecture sortante GARDEE (design-v2 4.3, A7): liste fermee d'hotes exacts, HTTPS, zero redirection, 5 s, 64 Ko, aucun en-tete d'identification.
// Seul fichier de api/src/verify qui appelle `fetch`. Le modele ne fournit jamais d'URL: l'adresse est construite par le code.
import { FETCH_MAX_BYTES, FETCH_TIMEOUT_MS } from './limits.js';

/** Hotes exacts autorises (pas de joker). Un domaine n'entre ici que si une methode de recherche est ecrite et testee (search.ts). */
export const ALLOWED_HOSTS: readonly string[] = ['fr.wikipedia.org', 'en.wikipedia.org', 'fr.wikibooks.org', 'fr.wikiversity.org', 'fr.vikidia.org'];

export type RefusalReason = 'host' | 'scheme' | 'redirect' | 'size' | 'timeout' | 'status' | 'format';
export class FetchRefused extends Error {
  constructor(readonly reason: RefusalReason) {
    super(`lecture refusee: ${reason}`);
  }
}

/**
 * Politique Wikimedia (lue le 2026-11-24): User-Agent descriptif avec contact, format
 * `client/version (contact) bibliotheque/version`. Le contact vient de QCM_UA_CONTACT (adresse de l'equipe).
 */
export const userAgent = (contact = process.env.QCM_UA_CONTACT): string => {
  // Repli (adresse de l'equipe du depot) hors production seulement: en prod le contact est obligatoire (handler.ts).
  const c = contact ?? (process.env.QCM_ENV === 'prod' ? undefined : 'worx@pouf.org');
  if (!c) throw new Error('QCM_UA_CONTACT obligatoire en production');
  return `QCMonsterVerifyBot/1.0 (${c}) node-fetch`;
};

export interface FetchOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  maxBytes?: number;
  /** Attente avant chaque requete (limiteur de debit). */
  beforeRequest?: () => Promise<void>;
}

/** GET JSON. Leve FetchRefused pour tout ce qui sort de la politique. L'URL est verifiee ICI, quelle que soit sa provenance. */
export async function guardedGetJson(rawUrl: string, o: FetchOptions = {}): Promise<unknown> {
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch {
    throw new FetchRefused('format');
  }
  if (url.protocol !== 'https:') throw new FetchRefused('scheme');
  if (!ALLOWED_HOSTS.includes(url.hostname) || url.username || url.password || url.port) throw new FetchRefused('host');
  await o.beforeRequest?.();
  const f = o.fetchImpl ?? fetch;
  let res: Response;
  try {
    // Aucun en-tete d'autorisation ni cookie; `redirect: 'manual'`: une redirection n'est jamais suivie.
    res = await f(url.toString(), { method: 'GET', redirect: 'manual', credentials: 'omit', signal: AbortSignal.timeout(o.timeoutMs ?? FETCH_TIMEOUT_MS), headers: { 'user-agent': userAgent(), accept: 'application/json' } });
  } catch {
    throw new FetchRefused('timeout');
  }
  if ((res.status >= 300 && res.status < 400) || res.type === 'opaqueredirect') throw new FetchRefused('redirect');
  if (res.status !== 200) throw new FetchRefused('status');
  const max = o.maxBytes ?? FETCH_MAX_BYTES;
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > max) {
    await res.body?.cancel().catch(() => undefined);
    throw new FetchRefused('size');
  }
  const reader = res.body?.getReader();
  if (!reader) throw new FetchRefused('format');
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > max) {
        await reader.cancel().catch(() => undefined);
        throw new FetchRefused('size');
      }
      chunks.push(value);
    }
  } catch (e) {
    if (e instanceof FetchRefused) throw e;
    throw new FetchRefused('timeout');
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new FetchRefused('format');
  }
}
