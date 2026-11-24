// Acces DynamoDB de verify-run. Ecrit: VERDICT#<nn> (jamais CLAIM#), PASSAGE#<id>, CLAIMCACHE#<empreinte>. Lit: CLAIM#<nn>.
import { BatchGetCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import { keys, sha256 } from '../../../shared/ddb/keys.js';
import { ClaimItemSchema, VerdictItemSchema } from '../../../shared/items.js';
import type { z } from 'zod';
import { CACHE_TTL_DAYS } from './limits.js';
import { claimFingerprintText } from './text.js';
import type { Passage, Niveau } from './search.js';
import type { Source } from './judge.js';

export type ClaimItem = z.infer<typeof ClaimItemSchema>;
export type VerdictBody = Pick<z.infer<typeof VerdictItemSchema>, 'statut' | 'secondeLecture'> & { niveau?: Niveau; sources: Source[]; /** Cout (micro-euros) des appels du lot, porte par le premier verdict du lot: sert a cumuler le plafond du job entre tentatives. */ coutMicros?: number };
export interface CacheEntry {
  statut: 'verifiee' | 'erreur';
  niveau: Niveau;
  secondeLecture: boolean;
  passageIds: string[];
  sources: Source[];
}

export interface VerifyStore {
  listClaims(docId: string): Promise<{ nn: number; claim: ClaimItem }[]>;
  listVerdicts(docId: string): Promise<Map<number, VerdictBody>>;
  putVerdict(docId: string, nn: number, v: VerdictBody): Promise<void>;
  putPassages(ps: Passage[]): Promise<void>;
  getPassages(ids: string[]): Promise<Passage[]>;
  getCache(fingerprint: string): Promise<CacheEntry | undefined>;
  putCache(fingerprint: string, e: CacheEntry): Promise<void>;
}

export const fingerprint = (claimText: string): string => sha256(claimFingerprintText(claimText));

const SAFE_ID = /^[A-Za-z0-9_-]{1,64}$/;
const ttl = (now: Date) => Math.floor(now.getTime() / 1000) + CACHE_TTL_DAYS * 86400;
const nnOf = (sk: string, prefix: string): number => Number(sk.slice(prefix.length));

export function dynamoVerifyStore(client: DynamoDBDocumentClient, table: string, now: () => Date = () => new Date()): VerifyStore {
  const query = async (pk: string, prefix: string) => {
    const items: Record<string, unknown>[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const r = await client.send(new QueryCommand({ TableName: table, KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)', ExpressionAttributeValues: { ':p': pk, ':s': prefix }, ConsistentRead: true, ExclusiveStartKey: start }));
      items.push(...((r.Items ?? []) as Record<string, unknown>[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return items;
  };
  return {
    async listClaims(docId) {
      if (!SAFE_ID.test(docId)) throw new RangeError('docId invalide');
      const items = await query(`DOC#${docId}`, 'CLAIM#');
      return items.map((i) => ({ nn: nnOf(String(i.SK), 'CLAIM#'), claim: ClaimItemSchema.parse(i) })).sort((a, b) => a.nn - b.nn);
    },
    async listVerdicts(docId) {
      const items = await query(`DOC#${docId}`, 'VERDICT#');
      return new Map(items.map((i) => [nnOf(String(i.SK), 'VERDICT#'), { ...(VerdictItemSchema.parse(i) as VerdictBody), coutMicros: Number.isFinite(i.coutMicros) ? (i.coutMicros as number) : undefined }]));
    },
    async putVerdict(docId, nn, v) {
      const { coutMicros, ...body } = v;
      const item = { ...VerdictItemSchema.parse({ ...keys.verdict(docId, nn), ...body }), ...(coutMicros ? { coutMicros } : {}) };
      await client.send(new PutCommand({ TableName: table, Item: item }));
    },
    async putPassages(ps) {
      const date = now().toISOString();
      for (const p of ps) {
        await client.send(new PutCommand({ TableName: table, Item: { ...keys.passage(p.id), texte: p.texte, url: p.url, site: p.site, titre: p.titre, niveau: p.niveau, date, ttl: ttl(now()) } }));
      }
    },
    async getPassages(ids) {
      if (!ids.length) return [];
      const r = await client.send(new BatchGetCommand({ RequestItems: { [table]: { Keys: ids.map((id) => keys.passage(id)), ConsistentRead: true } } }));
      return ((r.Responses?.[table] ?? []) as Record<string, unknown>[]).map((i) => ({ id: String(i.PK).slice('PASSAGE#'.length), texte: String(i.texte), url: String(i.url), site: String(i.site), titre: String(i.titre), niveau: Number(i.niveau) as Niveau }));
    },
    async getCache(fp) {
      const r = await client.send(new GetCommand({ TableName: table, Key: keys.claimCache(fp) }));
      const i = r.Item;
      if (!i || (i.ttl as number) < Math.floor(now().getTime() / 1000)) return undefined; // le TTL DynamoDB peut tarder
      return { statut: i.statut, niveau: i.niveau, secondeLecture: Boolean(i.secondeLecture), passageIds: i.passageIds, sources: i.sources } as CacheEntry;
    },
    async putCache(fp, e) {
      await client.send(new PutCommand({ TableName: table, Item: { ...keys.claimCache(fp), ...e, date: now().toISOString(), ttl: ttl(now()) } }));
    },
  };
}
