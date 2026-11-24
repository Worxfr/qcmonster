// Quota de pages (design-v2 4.7). Reservation ATOMIQUE: une transaction DynamoDB met a jour le compteur de l'eleve
// ET celui de la famille; chacun a un attribut `restant` (= limite + bonus - utilise - reserve) avec la condition
// restant >= pages (DynamoDB n'a pas d'arithmetique dans les conditions, d'ou `restant`).
import { DynamoDBDocumentClient, GetCommand, PutCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { keys, type Key } from './ddb/keys.js';

export interface QuotaItem extends Key {
  limite: number;
  utilise: number;
  reserve: number;
  bonus: number;
  restant: number;
}

export interface TxUpdate {
  key: Key;
  add: Record<string, number>;
  requireAtLeast?: { attr: string; value: number };
  /** Verrou optimiste: la mise a jour n'a lieu que si l'attribut vaut exactement `value`. */
  requireEquals?: { attr: string; value: number };
}

/** Port minimal: l'implementation DynamoDB est la vraie, la memoire sert aux tests unitaires. */
export interface QuotaDb {
  putIfAbsent(item: QuotaItem): Promise<void>;
  get(key: Key): Promise<Record<string, number | string> | undefined>;
  /** Applique toutes les mises a jour ou aucune. Renvoie false si une condition echoue. */
  transact(updates: TxUpdate[]): Promise<boolean>;
}

export interface QuotaScope {
  familyId: string;
  studentId: string;
  month: string; // aaaa-mm (monthParis)
  studentLimit: number;
  familyLimit: number;
}

const fresh = (key: Key, limite: number): QuotaItem => ({ ...key, limite, utilise: 0, reserve: 0, bonus: 0, restant: limite });

async function ensure(db: QuotaDb, s: QuotaScope): Promise<{ student: Key; family: Key }> {
  const student = keys.quota(s.familyId, s.month, s.studentId);
  const family = keys.quotaFamily(s.familyId, s.month);
  await db.putIfAbsent(fresh(student, s.studentLimit));
  await db.putIfAbsent(fresh(family, s.familyLimit));
  return { student, family };
}

const both = (k: { student: Key; family: Key }, add: Record<string, number>, need?: number): TxUpdate[] =>
  [k.student, k.family].map((key) => ({ key, add, requireAtLeast: need === undefined ? undefined : { attr: 'restant', value: need } }));

/** Reserve `pages`. Renvoie false si l'eleve ou la famille n'a plus assez de pages. */
export async function reservePages(db: QuotaDb, s: QuotaScope, pages: number): Promise<boolean> {
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError('pages doit etre un entier >= 1');
  const k = await ensure(db, s);
  return db.transact(both(k, { reserve: pages, restant: -pages }, pages));
}

/** Rend des pages reservees (job rejete, annule ou expire avant l'etape 8). */
export async function releasePages(db: QuotaDb, s: QuotaScope, pages: number): Promise<void> {
  const k = await ensure(db, s);
  await db.transact(both(k, { reserve: -pages, restant: pages }));
}

/** Consomme definitivement (etape 8). */
export async function consumePages(db: QuotaDb, s: QuotaScope, pages: number): Promise<void> {
  const k = await ensure(db, s);
  await db.transact(both(k, { reserve: -pages, utilise: pages }));
}

/** Ajoute des pages bonus a l'eleve (serie de 7 jours: +2). Atomique: `bonus` et `restant` bougent ensemble. */
export async function addBonus(db: QuotaDb, s: QuotaScope, pages: number): Promise<void> {
  if (!Number.isInteger(pages) || pages < 1) throw new RangeError('pages doit etre un entier >= 1');
  const k = await ensure(db, s);
  await db.transact([{ key: k.student, add: { bonus: pages, restant: pages } }]);
}

/**
 * Change le plafond mensuel d'un eleve (PATCH /students). `limite` et `restant` bougent du meme delta, avec un verrou
 * optimiste sur l'ancienne limite (reessaye 3 fois si un autre appel change la limite en meme temps).
 * Le plafond de la famille n'est pas touche ici.
 */
export async function setLimit(db: QuotaDb, s: QuotaScope, limit: number): Promise<void> {
  if (!Number.isInteger(limit) || limit < 0) throw new RangeError('limit doit etre un entier >= 0');
  const k = await ensure(db, s);
  for (let i = 0; i < 3; i++) {
    const cur = await db.get(k.student);
    const old = (cur?.limite as number | undefined) ?? 0;
    const delta = limit - old;
    if (delta === 0) return;
    if (await db.transact([{ key: k.student, add: { limite: delta, restant: delta }, requireEquals: { attr: 'limite', value: old } }])) return;
  }
  throw new Error('setLimit: conflit persistant');
}

export function dynamoQuotaDb(client: DynamoDBDocumentClient, table: string): QuotaDb {
  return {
    async putIfAbsent(item) {
      try {
        await client.send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
      } catch (e) {
        if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
      }
    },
    async get(key) {
      const r = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      return r.Item as Record<string, number | string> | undefined;
    },
    async transact(updates) {
      try {
        await client.send(
          new TransactWriteCommand({
            TransactItems: updates.map((u) => {
              const names: Record<string, string> = {};
              const values: Record<string, number> = {};
              const sets = Object.entries(u.add).map(([attr, v], i) => {
                names[`#a${i}`] = attr;
                values[`:v${i}`] = v;
                return `#a${i} :v${i}`;
              });
              let cond: string | undefined;
              if (u.requireAtLeast) {
                names['#req'] = u.requireAtLeast.attr;
                values[':min'] = u.requireAtLeast.value;
                cond = 'attribute_exists(PK) AND #req >= :min';
              }
              if (u.requireEquals) {
                names['#eq'] = u.requireEquals.attr;
                values[':eq'] = u.requireEquals.value;
                cond = 'attribute_exists(PK) AND #eq = :eq';
              }
              return {
                Update: {
                  TableName: table,
                  Key: u.key,
                  UpdateExpression: `ADD ${sets.join(', ')}`,
                  ConditionExpression: cond,
                  ExpressionAttributeNames: names,
                  ExpressionAttributeValues: values,
                },
              };
            }),
          }),
        );
        return true;
      } catch (e) {
        if ((e as { name?: string }).name === 'TransactionCanceledException') return false;
        throw e;
      }
    },
  };
}

/** Implementation en memoire (tests). Chaque appel est atomique car JS est mono-thread entre deux await. */
export function memoryQuotaDb(): QuotaDb & { items: Map<string, Record<string, number | string>> } {
  const items = new Map<string, Record<string, number | string>>();
  const id = (k: Key) => `${k.PK}|${k.SK}`;
  return {
    items,
    async putIfAbsent(item) {
      await Promise.resolve();
      if (!items.has(id(item))) items.set(id(item), { ...item });
    },
    async get(key) {
      await Promise.resolve();
      const it = items.get(id(key));
      return it ? { ...it } : undefined;
    },
    async transact(updates) {
      await Promise.resolve();
      for (const u of updates) {
        const it = items.get(id(u.key));
        if (u.requireEquals && (!it || it[u.requireEquals.attr] !== u.requireEquals.value)) return false;
        if (u.requireAtLeast && (!it || (it[u.requireAtLeast.attr] as number) < u.requireAtLeast.value)) return false;
      }
      for (const u of updates) {
        const it = items.get(id(u.key)) ?? { ...u.key };
        for (const [a, v] of Object.entries(u.add)) it[a] = ((it[a] as number | undefined) ?? 0) + v;
        items.set(id(u.key), it);
      }
      return true;
    },
  };
}
