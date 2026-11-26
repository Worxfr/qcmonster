// Port d'acces DynamoDB du lot L3 (jeu et famille). Chaque element porte un compteur `v`: une ecriture est conditionnelle a la
// version lue (`when`), et plusieurs elements s'ecrivent en une transaction (tout ou rien). Un conflit renvoie false: l'appelant relit et recommence.
import { DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import type { Key } from '../../../shared/ddb/keys.js';
import type { TreeDb, TreeKey } from '../../../shared/delete-tree.js';

export type Item = Key & { v?: number } & Record<string, unknown>;
/** 'absent': l'element ne doit pas exister; un nombre: la version lue; 'any': ecriture sans condition. */
export type When = 'absent' | 'any' | number;
export interface Write {
  item: Item;
  when: When;
  /** Supprime l'element (seule sa cle compte) dans la meme ecriture; `when` est alors ignore. */
  remove?: true;
}

export interface Store {
  get(key: Key): Promise<Item | undefined>;
  /** Elements d'une partition, SK commencant par `skPrefix`. `gsi1` interroge l'index GSI1 (GSI1PK = pk, GSI1SK commence par skPrefix). */
  query(pk: string, skPrefix?: string, gsi1?: boolean): Promise<Item[]>;
  /** Ecrit tous les elements ou aucun. false si une condition echoue. */
  commit(writes: Write[]): Promise<boolean>;
  remove(key: Key): Promise<void>;
}

const condition = (when: When): { ConditionExpression?: string; ExpressionAttributeValues?: Record<string, unknown> } =>
  when === 'any'
    ? {}
    : when === 'absent'
      ? { ConditionExpression: 'attribute_not_exists(PK)' }
      : { ConditionExpression: 'v = :ev', ExpressionAttributeValues: { ':ev': when } };

const isConflict = (e: unknown): boolean => {
  const err = e as { name?: string; CancellationReasons?: { Code?: string }[] };
  if (err.name === 'ConditionalCheckFailedException') return true;
  return err.name === 'TransactionCanceledException' && (err.CancellationReasons ?? []).some((r) => r.Code === 'ConditionalCheckFailed');
};

const nextV = (w: Write): number => (typeof w.when === 'number' ? w.when + 1 : (w.item.v ?? 0) + 1);

export function dynamoStore(client: DynamoDBDocumentClient, table: string): Store {
  const stamp = (w: Write): Item => ({ ...w.item, v: nextV(w) });
  return {
    async get(key) {
      const r = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
      return r.Item as Item | undefined;
    },
    async query(pk, skPrefix, gsi1) {
      const [pkAttr, skAttr] = gsi1 ? ['GSI1PK', 'GSI1SK'] : ['PK', 'SK'];
      const out: Item[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const r = await client.send(
          new QueryCommand({
            TableName: table,
            IndexName: gsi1 ? 'GSI1' : undefined,
            KeyConditionExpression: skPrefix ? `${pkAttr} = :p AND begins_with(${skAttr}, :s)` : `${pkAttr} = :p`,
            ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk },
            ExclusiveStartKey: start,
            ConsistentRead: gsi1 ? undefined : true, // un index ne sait pas lire de facon coherente
          }),
        );
        out.push(...((r.Items ?? []) as Item[]));
        start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async commit(writes) {
      try {
        if (writes.length === 1 && !writes[0].remove) {
          await client.send(new PutCommand({ TableName: table, Item: stamp(writes[0]), ...condition(writes[0].when) }));
        } else {
          await client.send(
            new TransactWriteCommand({
              TransactItems: writes.map((w) => (w.remove ? { Delete: { TableName: table, Key: { PK: w.item.PK, SK: w.item.SK } } } : { Put: { TableName: table, Item: stamp(w), ...condition(w.when) } })),
            }),
          );
        }
        return true;
      } catch (e) {
        if (isConflict(e)) return false;
        throw e;
      }
    },
    async remove(key) {
      await client.send(new DeleteCommand({ TableName: table, Key: key }));
    },
  };
}

/** Implementation memoire (tests). Respecte les memes conditions que DynamoDB. */
export function memoryStore(): Store & { items: Map<string, Item>; failNextCommits: (n: number) => void } {
  const items = new Map<string, Item>();
  const id = (k: Key) => `${k.PK}|${k.SK}`;
  let fail = 0;
  return {
    items,
    failNextCommits: (n) => {
      fail = n;
    },
    async get(key) {
      await Promise.resolve();
      const it = items.get(id(key));
      return it ? structuredClone(it) : undefined;
    },
    async query(pk, skPrefix, gsi1) {
      await Promise.resolve();
      const [pkAttr, skAttr] = gsi1 ? ['GSI1PK', 'GSI1SK'] : ['PK', 'SK'];
      return [...items.values()].filter((i) => i[pkAttr] === pk && (!skPrefix || String(i[skAttr] ?? '').startsWith(skPrefix))).map((i) => structuredClone(i));
    },
    async commit(writes) {
      await Promise.resolve();
      if (fail > 0) {
        fail--;
        return false;
      }
      for (const w of writes) {
        if (w.remove) continue;
        const cur = items.get(id(w.item));
        if (w.when === 'absent' && cur) return false;
        if (typeof w.when === 'number' && cur?.v !== w.when) return false;
      }
      for (const w of writes) {
        if (w.remove) items.delete(id(w.item));
        else items.set(id(w.item), structuredClone({ ...w.item, v: nextV(w) }));
      }
      return true;
    },
    async remove(key) {
      await Promise.resolve();
      items.delete(id(key));
    },
  };
}

const treeKey = (i: Item): TreeKey => ({ PK: i.PK, SK: i.SK, ...(typeof i.studentId === 'string' ? { studentId: i.studentId } : {}), ...(typeof i.docId === 'string' ? { docId: i.docId } : {}), ...(Array.isArray(i.docIds) ? { docIds: i.docIds as string[] } : {}) });

/** Adaptateur `TreeDb` (shared/delete-tree.ts) au-dessus d'un Store: pour les tests; en production on passe `dynamoTreeDb` de shared. */
export const storeTreeDb = (store: Store): TreeDb => ({
  async mutateTest(key, fn) {
    for (let attempt = 0; attempt < 5; attempt++) {
      const cur = await store.get(key);
      if (!cur) return;
      const r = fn(cur);
      if (r === 'garder') return;
      if (r === 'supprimer') return store.remove(key);
      if (await store.commit([{ item: { ...(r as Item), PK: key.PK, SK: key.SK }, when: cur.v ?? 'any' }])) return;
    }
    throw new Error('suppression incomplete (conflit persistant)');
  },
  async list(pk, skPrefix) {
    return (await store.query(pk, skPrefix)).map(treeKey);
  },
  async remove(ks) {
    for (const k of ks) await store.remove(k);
  },
});
