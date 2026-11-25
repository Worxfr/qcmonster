// Contexte d'execution des handlers L2a: dependances injectees (AWS en production, memoire en test).
import { randomBytes } from 'node:crypto';
import { invokeModel, type CostStore, type ModelPort } from '../../../shared/bedrock.js';
import { toMicros } from '../../../shared/cost.js';
import { keys } from '../../../shared/ddb/keys.js';
import { jobCapEur, type Env } from '../../../shared/names.js';
import type { QuotaDb } from '../../../shared/quota.js';
import type { Db, Item, ScanStore, Sfn } from './ports.js';

export interface Ctx {
  env: Env;
  db: Db;
  quota: QuotaDb;
  s3: ScanStore;
  sfn: Sfn;
  /** ARN des profils d'application (SSM /qcm/<env>/models/*, injectes par CDK). */
  models: { haiku: string; sonnet: string };
  port: ModelPort;
  costStore: CostStore;
  now: () => Date;
  newId: () => string;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Identifiant de 26 caracteres, trie par date (ULID). */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  const rnd = randomBytes(16);
  let r = '';
  for (let i = 0; i < 16; i++) r += CROCKFORD[rnd[i] % 32];
  return time + r;
}

export const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
export const DAY_S = 86_400;
export const ttlIn = (ctx: Ctx, seconds: number): number => Math.floor(ctx.now().getTime() / 1000) + seconds;
export const iso = (ctx: Ctx): string => ctx.now().toISOString();

/** Jour au format aaaa-mm-jj, fuseau Europe/Paris. */
export function dayParis(d: Date): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);
}

export async function mapLimit<T, R>(items: T[], limit: number, f: (x: T, i: number) => Promise<R>): Promise<R[]> {
  const out = new Array<R>(items.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, async () => {
      while (next < items.length) {
        const i = next++;
        out[i] = await f(items[i], i);
      }
    }),
  );
  return out;
}

export const jobKey = (sid: string, jobId: string) => keys.job(sid, jobId);

export const centsFromMicros = (micros: number): number => Math.ceil(micros / 10_000);

/**
 * Appel de modele pour un job: depense deja faite lue dans le Job (`coutMicros`), garde de cout et plafond du job geres par
 * shared/bedrock.ts, cout ajoute au Job des la reponse (ADD atomique). Aucun texte n'est journalise.
 */
export async function callModel(
  ctx: Ctx,
  job: { sid: string; jobId: string },
  step: string,
  model: 'haiku' | 'sonnet',
  req: { system?: string; prompt: string; maxTokens: number; images?: { format: 'jpeg' | 'png'; bytes: Uint8Array }[] },
  retryDelaysMs?: number[],
): Promise<string> {
  // shortcut: la depense est lue avant l'appel; avec la concurrence de 3 transcriptions, les 3 lisent la meme valeur et le plafond du job
  // peut etre depasse d'au plus 3 appels de transcription (quelques centimes). A resserrer si la concurrence monte (reservation avant appel).
  const cur = await ctx.db.get(jobKey(job.sid, job.jobId));
  const spentEur = ((cur?.coutMicros as number | undefined) ?? 0) / 1_000_000;
  const r = await invokeModel({
    model: model === 'haiku' ? 'haiku-5.5' : 'sonnet-5.5',
    jobId: job.jobId,
    step,
    request: { modelArn: ctx.models[model], ...req },
    store: ctx.costStore,
    port: ctx.port,
    jobSpentEur: spentEur,
    jobCapEur: jobCapEur((cur?.pages as number | undefined) ?? 1), // proportionnel aux pages du job: max(0,25 ; 0,15 x pages)
    retryDelaysMs,
  });
  await ctx.db.update(jobKey(job.sid, job.jobId), { add: { coutMicros: toMicros(r.costEur) } });
  return r.text;
}

export type { Item };
