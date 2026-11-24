// Suppression en cascade (design-v2 4.8). Permis a travers les proprietaires: effacer n'est pas ecrire.
// Chaque fonction part de requetes sur PK (pas de Scan) et supprime par lots de 25.
import { BatchWriteCommand, DynamoDBDocumentClient, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Key } from './ddb/keys.js';

/** Port minimal: liste les cles d'une partition (avec prefixe de SK facultatif) et supprime des cles. */
export interface TreeDb {
  list(pk: string, skPrefix?: string): Promise<Key[]>;
  remove(keys: Key[]): Promise<void>;
}

async function removeAll(db: TreeDb, ks: Key[]): Promise<number> {
  if (ks.length) await db.remove(ks);
  return ks.length;
}

/** Fiche: elle-meme, ses CLAIM, VERDICT, QCM, GAP. Renvoie le nombre d'elements supprimes. */
export async function deleteDocTree(db: TreeDb, sid: string, docId: string): Promise<number> {
  let n = await removeAll(db, await db.list(`DOC#${docId}`));
  n += await removeAll(db, [{ PK: `STUDENT#${sid}`, SK: `DOC#${docId}` }]);
  return n;
}

/** Eleve: ses fiches (arbres complets), jobs et transcriptions, profil, jours, tentatives, compteurs, puis les quotas et classements de la famille. */
export async function deleteStudentTree(db: TreeDb, familyId: string, sid: string): Promise<number> {
  let n = 0;
  const own = await db.list(`STUDENT#${sid}`);
  for (const k of own) {
    if (k.SK.startsWith('DOC#')) n += await deleteDocTree(db, sid, k.SK.slice(4));
    if (k.SK.startsWith('JOB#')) n += await removeAll(db, await db.list(`JOB#${k.SK.slice(4)}`)); // TEXT#
  }
  n += await removeAll(db, (await db.list(`STUDENT#${sid}`)).filter((k) => !k.SK.startsWith('DOC#')));
  const fam = await db.list(`FAMILY#${familyId}`);
  n += await removeAll(db, fam.filter((k) => k.SK === `STUDENT#${sid}` || k.SK.endsWith(`#${sid}`)));
  return n;
}

/** Famille: tous ses eleves, puis ce qui reste sous FAMILY#. */
export async function deleteFamilyTree(db: TreeDb, familyId: string): Promise<number> {
  let n = 0;
  const fam = await db.list(`FAMILY#${familyId}`);
  for (const k of fam.filter((x) => x.SK.startsWith('STUDENT#'))) n += await deleteStudentTree(db, familyId, k.SK.slice(8));
  n += await removeAll(db, await db.list(`FAMILY#${familyId}`));
  return n;
}

export function dynamoTreeDb(client: DynamoDBDocumentClient, table: string): TreeDb {
  return {
    async list(pk, skPrefix) {
      const out: Key[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const r = await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: skPrefix ? 'PK = :p AND begins_with(SK, :s)' : 'PK = :p',
            ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk },
            ProjectionExpression: 'PK, SK',
            ExclusiveStartKey: start,
          }),
        );
        for (const i of r.Items ?? []) out.push({ PK: i.PK as string, SK: i.SK as string });
        start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async remove(ks) {
      for (let i = 0; i < ks.length; i += 25) {
        let req: Record<string, { DeleteRequest: { Key: Key } }[]> = { [table]: ks.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
        for (let attempt = 0; attempt < 5 && Object.keys(req).length; attempt++) {
          const r = await client.send(new BatchWriteCommand({ RequestItems: req }));
          req = (r.UnprocessedItems ?? {}) as typeof req;
        }
        if (Object.keys(req).length) throw new Error('suppression incomplete (elements non traites)');
      }
    },
  };
}

/** Implementation memoire (tests). */
export function memoryTreeDb(initial: Key[]): TreeDb & { keys: () => Key[] } {
  const set = new Map(initial.map((k) => [`${k.PK}|${k.SK}`, k]));
  return {
    keys: () => [...set.values()],
    async list(pk, skPrefix) {
      return [...set.values()].filter((k) => k.PK === pk && (!skPrefix || k.SK.startsWith(skPrefix)));
    },
    async remove(ks) {
      for (const k of ks) set.delete(`${k.PK}|${k.SK}`);
    },
  };
}
