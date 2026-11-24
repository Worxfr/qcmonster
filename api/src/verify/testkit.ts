// Aides de test (jamais importees par handler.ts, donc absentes du paquet de la Lambda): magasin en memoire, faux modele, faux fetch.
import type { CostStore, ModelPort, ModelRequest } from '../../../shared/bedrock.js';
import { keys } from '../../../shared/ddb/keys.js';
import { normalize } from './text.js';
import type { ClaimItem, CacheEntry, VerdictBody, VerifyStore } from './store.js';
import type { Passage } from './search.js';

export const FAKE_ARN = 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/test-profile';

export function claim(docId: string, nn: number, texte: string, o: Partial<{ aRisque: boolean; type: string }> = {}): { nn: number; claim: ClaimItem } {
  return { nn, claim: { ...keys.claim(docId, nn), texte, origine: { page: 1, phraseId: `p1-s${nn}`, extrait: texte }, type: o.type ?? 'factuelle', aRisque: o.aRisque ?? false } };
}

export interface MemoryStore extends VerifyStore {
  verdicts: Map<string, VerdictBody>;
  passages: Map<string, Passage>;
  cache: Map<string, CacheEntry>;
  /** Cles ecrites, pour verifier qu'aucun CLAIM# n'est ecrit. */
  written: string[];
}

export function memoryStore(claims: { nn: number; claim: ClaimItem }[]): MemoryStore {
  const s: MemoryStore = {
    verdicts: new Map(),
    passages: new Map(),
    cache: new Map(),
    written: [],
    async listClaims() {
      return claims;
    },
    async listVerdicts(docId) {
      return new Map([...s.verdicts].filter(([k]) => k.startsWith(`${docId}/`)).map(([k, v]) => [Number(k.split('/')[1]), v]));
    },
    async putVerdict(docId, nn, v) {
      s.written.push(keys.verdict(docId, nn).SK);
      s.verdicts.set(`${docId}/${nn}`, v);
    },
    async putPassages(ps) {
      for (const p of ps) {
        s.written.push(keys.passage(p.id).PK);
        s.passages.set(p.id, p);
      }
    },
    async getPassages(ids) {
      return ids.map((i) => s.passages.get(i)).filter((p): p is Passage => !!p);
    },
    async getCache(fp) {
      return s.cache.get(fp);
    },
    async putCache(fp, e) {
      s.written.push(keys.claimCache(fp).PK);
      s.cache.set(fp, e);
    },
  };
  return s;
}

export function memoryCost(startEur = 0): CostStore & { totalEur: () => number } {
  let total = startEur;
  return { read: async () => ({ monthEur: total, totalEur: total }), add: async (e) => ((total += e), { monthEur: total, totalEur: total }), totalEur: () => total };
}

/**
 * Faux juge deterministe: pour chaque affirmation, compare a chaque phrase de ses passages (texte normalise).
 * phrase identique = verifiee; recouvrement de mots >= 60 % sans identite = erreur; sinon non_verifiable. Compte les appels.
 */
export function heuristicModel(o: { usageOut?: number } = {}): ModelPort & { calls: ModelRequest[] } {
  const calls: ModelRequest[] = [];
  return {
    calls,
    async converse(req) {
      calls.push(req);
      const claims = [...req.prompt.matchAll(/<affirmation id="(C\d+)">([\s\S]*?)<\/affirmation>/g)].map((m) => ({ id: m[1], text: m[2] }));
      const passages = [...req.prompt.matchAll(/<passage id="(P\d+)" affirmation="(C\d+)" niveau="\d">([\s\S]*?)<\/passage>/g)].map((m) => ({ id: m[1], claim: m[2], text: m[3] }));
      const verdicts = claims.map((c) => {
        const cw = new Set(normalize(c.text).split(' '));
        let best: { p: string; sentence: string; eq: boolean; ratio: number } | undefined;
        for (const p of passages.filter((x) => x.claim === c.id)) {
          for (const sentence of p.text.split(/(?<=[.!?])\s+/)) {
            const sw = normalize(sentence).split(' ');
            const ratio = sw.filter((w) => cw.has(w)).length / Math.max(cw.size, 1);
            const eq = normalize(sentence).endsWith(normalize(c.text));
            if (!best || ratio > best.ratio) best = { p: p.id, sentence, eq, ratio };
          }
        }
        if (!best || best.ratio < 0.6) return { id: c.id, verdict: 'non_verifiable', citations: [] };
        return { id: c.id, verdict: best.eq ? 'verifiee' : 'erreur', citations: [{ passage: best.p, citation: best.sentence }] };
      });
      const text = JSON.stringify({ verdicts });
      return { text, usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: o.usageOut ?? Math.ceil(text.length / 4) } };
    },
  };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}): Response {
  return new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' }, ...init });
}

export const wikiPages = (pages: { title: string; extract: string }[]) => ({ query: { pages: pages.map((p, i) => ({ ...p, index: i + 1 })) } });
