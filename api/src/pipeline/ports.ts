// Ports du pipeline L2a: DynamoDB, S3, Step Functions. Les implementations AWS sont chargees a la demande (entry.ts);
// les tests utilisent les implementations en memoire de ce fichier (aucun reseau, aucun cout).
import { BatchWriteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import type { Key } from '../../../shared/ddb/keys.js';
import type { TreeDb } from '../../../shared/delete-tree.js';

export type Item = Key & Record<string, unknown>;

/** Condition d'ecriture. `lt`: l'attribut est absent ou strictement inferieur (compteurs a plafond). */
export interface Cond {
  exists?: boolean;
  eq?: Record<string, unknown>;
  in?: Record<string, unknown[]>;
  lt?: Record<string, number>;
  /** Attributs qui ne doivent pas exister (drapeau pose une seule fois). */
  absent?: string[];
}
/** Operation d'une transaction: ecriture d'element (`ifNotExists`) ou mise a jour conditionnelle. */
export type TxOp =
  | { put: Item; ifNotExists?: boolean; /** S1: ecrit si l'element manque OU si son `expiresAt` est echu a cet instant (ISO): emplacement de partage reutilisable. */ ifFreeAt?: string }
  | { key: Key; spec: UpdateSpec }
  /** S1: verification sans ecriture (ConditionCheckItem), dans la meme transaction. */
  | { check: Key; cond: Cond };
export interface UpdateSpec {
  set?: Record<string, unknown>;
  add?: Record<string, number>;
  /** ADD d'elements a un ensemble de chaines (idempotent). */
  addSet?: Record<string, (string | number)[]>;
  remove?: string[];
  cond?: Cond;
}

export interface Db {
  get(key: Key): Promise<Item | undefined>;
  /** `ifNotExists`: renvoie false si l'element existe deja. */
  put(item: Item, ifNotExists?: boolean): Promise<boolean>;
  /** Cree l'element s'il manque (sauf `cond.exists`). Renvoie l'element mis a jour, ou undefined si la condition echoue. */
  update(key: Key, spec: UpdateSpec): Promise<Item | undefined>;
  /** Tout ou rien. Renvoie false si une condition echoue. */
  transact(ops: TxOp[]): Promise<boolean>;
  query(pk: string, skPrefix?: string): Promise<Item[]>;
  queryGsi1(pk: string, skPrefix?: string): Promise<Item[]>;
  remove(keys: Key[]): Promise<void>;
}

/** Adaptateur vers le port de suppression en cascade de shared/delete-tree.ts (cles seules). */
export const treeDbFrom = (db: Db): TreeDb => ({
  list: async (pk, skPrefix) =>
    (await db.query(pk, skPrefix)).map((i) => ({ PK: i.PK, SK: i.SK, ...(typeof i.docId === 'string' ? { docId: i.docId } : {}), ...(typeof i.pages === 'number' ? { pages: i.pages } : {}), ...(Array.isArray(i.docIds) ? { docIds: i.docIds as string[] } : {}), ...(typeof i.hash === 'string' ? { hash: i.hash } : {}), ...(typeof i.famSlot === 'number' ? { famSlot: i.famSlot } : {}), ...(typeof i.sid === 'string' ? { sid: i.sid } : {}) })),
  remove: (ks) => db.remove(ks),
  async mutateTest(key, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await db.get(key);
      if (!cur) return;
      const r = fn(cur);
      if (r === 'garder') return;
      if (r === 'supprimer') return db.remove([key]);
      const { PK: _pk, SK: _sk, v, ...rest } = r as Item & { v?: number };
      void _pk; void _sk; void v;
      if (await db.update(key, { set: rest, add: { v: 1 }, cond: { exists: true, ...(typeof cur.v === 'number' ? { eq: { v: cur.v } } : { absent: ['v'] }) } })) return;
    }
    throw new Error('suppression incomplete (conflit persistant)');
  },
});

export interface PresignedPost {
  url: string;
  fields: Record<string, string>;
}
export interface ScanStore {
  /** POST pre-signe: cle sous `prefix`, type fige, taille 1..maxBytes, expiration en secondes. */
  presignPost(o: { prefix: string; firstKey: string; contentType: string; maxBytes: number; expiresSec: number }): Promise<PresignedPost>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  /** Premiers octets de l'objet (controle sur le contenu) et sa taille. Undefined si absent. */
  head(key: string, bytes: number): Promise<{ bytes: Uint8Array; size: number } | undefined>;
  getBytes(key: string): Promise<Uint8Array>;
  /** Ecrit un objet (recadrage temporaire `scans/<eleve>/<job>/fig/<id>.jpg`, R1). */
  put(key: string, bytes: Uint8Array, contentType: string): Promise<void>;
  list(prefix: string): Promise<string[]>;
  deleteAll(prefix: string): Promise<void>;
  /** E1: supprime des cles EXACTES (images de copie `copies/<eleve>/<copie>/p<n>`): aucun droit de liste sur ce prefixe. */
  deleteKeys(keys: string[]): Promise<void>;
}
/** Bucket des figures conservees (R1): `figures/<eleve>/<cours>/<figure>.jpg`, URL pre-signee de 5 minutes, jamais d'acces public. */
export interface FigureStore {
  /** Copie un recadrage temporaire du bucket des scans vers `dest`. Renvoie false si la source n'existe pas; toute autre erreur est levee. */
  copyFromScans(srcKey: string, destKey: string): Promise<boolean>;
  presignGet(key: string, expiresSec: number): Promise<string>;
  list(prefix: string): Promise<string[]>;
  deleteAll(prefix: string): Promise<void>;
}
/** Rognage d'une page (R1, `sharp` en couche Lambda): JPEG de 1200 px au plus, sans metadonnees. `box` absent: page entiere. */
export interface CropPort {
  crop(image: Uint8Array, box?: { x: number; y: number; w: number; h: number }): Promise<Uint8Array>;
}
export interface Sfn {
  start(name: string, input: unknown): Promise<void>;
  taskSuccess(token: string): Promise<void>;
  taskFailure(token: string, error: string): Promise<void>;
}

// ---------------------------------------------------------------- DynamoDB
const sleepNone = () => Promise.resolve();

/** DynamoDB renvoie les ensembles (ADD sur un set) sous forme de `Set`: le reste du code lit des tableaux. */
const plain = (it: Record<string, unknown> | undefined): Item | undefined => {
  if (!it) return undefined;
  for (const [k, v] of Object.entries(it)) if (v instanceof Set) it[k] = [...v];
  return it as Item;
};

function buildUpdate(spec: UpdateSpec) {
  const names: Record<string, string> = {};
  const values: Record<string, unknown> = {};
  const n = (a: string) => {
    const k = `#${a.replace(/[^A-Za-z0-9]/g, '_')}`;
    names[k] = a;
    return k;
  };
  let i = 0;
  const v = (x: unknown) => {
    const k = `:v${i++}`;
    values[k] = x;
    return k;
  };
  const setP = Object.entries(spec.set ?? {}).map(([a, x]) => `${n(a)} = ${v(x)}`);
  const addP = [
    ...Object.entries(spec.add ?? {}).map(([a, x]) => `${n(a)} ${v(x)}`),
    ...Object.entries(spec.addSet ?? {}).map(([a, x]) => `${n(a)} ${v(new Set(x))}`),
  ];
  const remP = (spec.remove ?? []).map(n);
  const parts = [setP.length ? `SET ${setP.join(', ')}` : '', addP.length ? `ADD ${addP.join(', ')}` : '', remP.length ? `REMOVE ${remP.join(', ')}` : ''].filter(Boolean);
  const c = spec.cond ?? {};
  const conds: string[] = [];
  if (c.exists) conds.push('attribute_exists(PK)');
  for (const [a, x] of Object.entries(c.eq ?? {})) conds.push(`${n(a)} = ${v(x)}`);
  for (const [a, xs] of Object.entries(c.in ?? {})) conds.push(`${n(a)} IN (${xs.map(v).join(', ')})`);
  for (const a of c.absent ?? []) conds.push(`attribute_not_exists(${n(a)})`);
  for (const [a, x] of Object.entries(c.lt ?? {})) conds.push(`(attribute_not_exists(${n(a)}) OR ${n(a)} < ${v(x)})`);
  return { UpdateExpression: parts.join(' '), ConditionExpression: conds.length ? conds.join(' AND ') : undefined, ExpressionAttributeNames: names, ExpressionAttributeValues: Object.keys(values).length ? values : undefined };
}

export function dynamoDb(client: DynamoDBDocumentClient, table: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): Db {
  const q = async (index: string | undefined, pk: string, skPrefix?: string): Promise<Item[]> => {
    const out: Item[] = [];
    let start: Record<string, unknown> | undefined;
    const [pkN, skN] = index ? ['GSI1PK', 'GSI1SK'] : ['PK', 'SK'];
    do {
      const r = await client.send(
        new QueryCommand({
          TableName: table,
          IndexName: index,
          KeyConditionExpression: skPrefix ? `${pkN} = :p AND begins_with(${skN}, :s)` : `${pkN} = :p`,
          ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk },
          ExclusiveStartKey: start,
          ConsistentRead: index ? undefined : true,
        }),
      );
      out.push(...((r.Items ?? []) as Item[]));
      start = r.LastEvaluatedKey;
    } while (start);
    return out;
  };
  return {
    async get(key) {
      const r = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      return plain(r.Item);
    },
    async put(item, ifNotExists) {
      try {
        await client.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: ifNotExists ? 'attribute_not_exists(PK)' : undefined }));
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
        throw e;
      }
    },
    async update(key, spec) {
      try {
        const r = await client.send(new UpdateCommand({ TableName: table, Key: key, ...buildUpdate(spec), ReturnValues: 'ALL_NEW' }));
        return plain(r.Attributes);
      } catch (e) {
        if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return undefined;
        throw e;
      }
    },
    async transact(ops) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: ops.map((o) => {
              if ('check' in o) {
                const b = buildUpdate({ cond: o.cond });
                return { ConditionCheck: { TableName: table, Key: o.check, ConditionExpression: b.ConditionExpression ?? 'attribute_exists(PK)', ExpressionAttributeNames: Object.keys(b.ExpressionAttributeNames).length ? b.ExpressionAttributeNames : undefined, ExpressionAttributeValues: b.ExpressionAttributeValues } };
              }
              if ('put' in o) {
                if (o.ifFreeAt !== undefined) return { Put: { TableName: table, Item: o.put, ConditionExpression: 'attribute_not_exists(PK) OR #ex <= :now', ExpressionAttributeNames: { '#ex': 'expiresAt' }, ExpressionAttributeValues: { ':now': o.ifFreeAt } } };
                return { Put: { TableName: table, Item: o.put, ConditionExpression: o.ifNotExists ? 'attribute_not_exists(PK)' : undefined } };
              }
              return { Update: { TableName: table, Key: o.key, ...buildUpdate(o.spec) } };
            }),
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === 'TransactionCanceledException') return false;
        throw e;
      }
    },
    query: (pk, skPrefix) => q(undefined, pk, skPrefix),
    queryGsi1: (pk, skPrefix) => q('GSI1', pk, skPrefix),
    async remove(ks) {
      for (let i = 0; i < ks.length; i += 25) {
        let req: Record<string, { DeleteRequest: { Key: Key } }[]> = { [table]: ks.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
        for (let attempt = 0; attempt < 6 && Object.keys(req).length; attempt++) {
          if (attempt > 0) await sleep(50 * 2 ** attempt);
          const r = await client.send(new BatchWriteCommand({ RequestItems: req }));
          req = (r.UnprocessedItems ?? {}) as typeof req;
        }
        if (Object.keys(req).length) throw new Error('suppression incomplete (elements non traites)');
      }
    },
  };
}

// ---------------------------------------------------------------- Memoire (tests)
const idOf = (k: Key) => `${k.PK}|${k.SK}`;

/** `shared` permet de partager le stockage avec `memoryQuotaDb().items` (meme table en production). */
export function memoryDb(shared?: Map<string, unknown>): Db & { items: Map<string, Item>; ops: { updates: number } } {
  const items = (shared as Map<string, Item> | undefined) ?? new Map<string, Item>();
  const ops = { updates: 0 };
  const apply = (cur: Item | undefined, key: Key, spec: UpdateSpec): Item => {
    const it: Item = cur ? structuredClone(cur) : { ...key };
    Object.assign(it, spec.set);
    for (const [a, x] of Object.entries(spec.add ?? {})) it[a] = ((it[a] as number | undefined) ?? 0) + x;
    for (const [a, xs] of Object.entries(spec.addSet ?? {})) it[a] = [...new Set([...((it[a] as string[] | undefined) ?? []), ...xs])];
    for (const a of spec.remove ?? []) delete it[a];
    return it;
  };
  const passes = (it: Item | undefined, c: Cond = {}): boolean => {
    if (c.exists && !it) return false;
    for (const a of c.absent ?? []) if (it && it[a] !== undefined) return false;
    for (const [a, x] of Object.entries(c.eq ?? {})) if (!it || it[a] !== x) return false;
    for (const [a, xs] of Object.entries(c.in ?? {})) if (!it || !xs.includes(it[a])) return false;
    for (const [a, x] of Object.entries(c.lt ?? {})) if (it && it[a] !== undefined && !((it[a] as number) < x)) return false;
    return true;
  };
  const list = (pk: string, skPrefix: string | undefined, gsi: boolean) =>
    [...items.values()]
      .filter((i) => (gsi ? i.GSI1PK : i.PK) === pk && (!skPrefix || String(gsi ? i.GSI1SK : i.SK).startsWith(skPrefix)))
      .sort((a, b) => String(gsi ? a.GSI1SK : a.SK).localeCompare(String(gsi ? b.GSI1SK : b.SK)))
      .map((i) => structuredClone(i));
  return {
    items,
    ops,
    async get(key) {
      await sleepNone();
      const it = items.get(idOf(key));
      return it ? structuredClone(it) : undefined;
    },
    async put(item, ifNotExists) {
      await sleepNone();
      if (ifNotExists && items.has(idOf(item))) return false;
      items.set(idOf(item), structuredClone(item));
      return true;
    },
    async update(key, spec) {
      await sleepNone();
      ops.updates++;
      const cur = items.get(idOf(key));
      if (!passes(cur, spec.cond)) return undefined;
      const it = apply(cur, key, spec);
      items.set(idOf(key), it);
      return structuredClone(it);
    },
    async transact(ops) {
      await sleepNone();
      for (const o of ops) {
        if ('check' in o) {
          if (!passes(items.get(idOf(o.check)), o.cond)) return false;
        } else if ('put' in o) {
          const cur = items.get(idOf(o.put));
          if (o.ifFreeAt !== undefined ? cur && !(String(cur.expiresAt ?? '') <= o.ifFreeAt) : o.ifNotExists && cur) return false;
        } else if (!passes(items.get(idOf(o.key)), o.spec.cond)) return false;
      }
      for (const o of ops) {
        if ('check' in o) continue;
        if ('put' in o) items.set(idOf(o.put), structuredClone(o.put));
        else items.set(idOf(o.key), apply(items.get(idOf(o.key)), o.key, o.spec));
      }
      return true;
    },
    async query(pk, skPrefix) {
      return list(pk, skPrefix, false);
    },
    async queryGsi1(pk, skPrefix) {
      return list(pk, skPrefix, true);
    },
    async remove(ks) {
      for (const k of ks) items.delete(idOf(k));
    },
  };
}

export function memoryScanStore(): ScanStore & { objects: Map<string, Uint8Array> } {
  const objects = new Map<string, Uint8Array>();
  return {
    objects,
    async presignPost(o) {
      return { url: 'https://scans.example.invalid/', fields: { key: o.firstKey, 'Content-Type': o.contentType, policy: `max=${o.maxBytes};prefix=${o.prefix};exp=${o.expiresSec}` } };
    },
    async presignGet(key, expiresSec) {
      return `https://scans.example.invalid/${key}?exp=${expiresSec}`;
    },
    async head(key, bytes) {
      const b = objects.get(key);
      return b ? { bytes: b.slice(0, bytes), size: b.byteLength } : undefined;
    },
    async getBytes(key) {
      const b = objects.get(key);
      if (!b) throw new Error('objet absent');
      return b;
    },
    async put(key, bytes) {
      objects.set(key, bytes);
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async deleteAll(prefix) {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    },
    async deleteKeys(keys) {
      for (const k of keys) objects.delete(k);
    },
  };
}

/** Bucket des figures en memoire (tests): la source de `copyFromScans` est le faux bucket des scans. */
export function memoryFigureStore(scans: { objects: Map<string, Uint8Array> }): FigureStore & { objects: Map<string, Uint8Array>; failCopy: { on: boolean } } {
  const objects = new Map<string, Uint8Array>();
  const failCopy = { on: false };
  return {
    objects,
    failCopy,
    async copyFromScans(src, dest) {
      if (failCopy.on) throw new Error('S3 indisponible');
      const b = scans.objects.get(src);
      if (!b) return false;
      objects.set(dest, b);
      return true;
    },
    async presignGet(key, expiresSec) {
      return `https://figures.example.invalid/${key}?exp=${expiresSec}`;
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async deleteAll(prefix) {
      for (const k of [...objects.keys()]) if (k.startsWith(prefix)) objects.delete(k);
    },
  };
}

/** Rognage factice (tests): renvoie un JPEG minimal qui dit s'il a ete rogne. */
export function memoryCrop(): CropPort & { calls: { box?: unknown }[]; fail: { on: boolean } } {
  const calls: { box?: unknown }[] = [];
  const fail = { on: false };
  return {
    calls,
    fail,
    async crop(_image, box) {
      if (fail.on) throw new Error('sharp indisponible');
      calls.push({ box });
      return new Uint8Array([0xff, 0xd8, 0xff, box ? 1 : 0]);
    },
  };
}

export function memorySfn(): Sfn & { started: { name: string; input: unknown }[]; success: string[]; failure: { token: string; error: string }[] } {
  const started: { name: string; input: unknown }[] = [];
  const success: string[] = [];
  const failure: { token: string; error: string }[] = [];
  return {
    started,
    success,
    failure,
    async start(name, input) {
      if (started.some((s) => s.name === name)) return;
      started.push({ name, input });
    },
    async taskSuccess(t) {
      success.push(t);
    },
    async taskFailure(token, error) {
      failure.push({ token, error });
    },
  };
}
