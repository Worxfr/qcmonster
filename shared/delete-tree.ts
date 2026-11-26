// Suppression en cascade (design-v2 4.8). Permis a travers les proprietaires: effacer n'est pas ecrire.
// Chaque fonction part de requetes sur PK (pas de Scan) et supprime par lots de 25.
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Key } from './ddb/keys.js';
import { recount, type TestLine } from './tests-history.js';

/** Port minimal: liste les cles d'une partition (avec prefixe de SK facultatif) et supprime des cles. */
export type TreeKey = Key & { studentId?: string; docId?: string; docIds?: string[] };
/** Resultat de `mutateTest`: supprimer l'element, le garder tel quel, ou l'ecrire reecrit. */
export type TestMutation = 'supprimer' | 'garder' | Record<string, unknown>;
export interface TreeDb {
  /**
   * Q1: lit un passage `TEST#` (lecture coherente), applique `fn`, puis ecrit CONDITIONNELLEMENT a la version lue (`v`). Sur conflit, relit et recommence
   * (5 essais, attente exponentielle), puis erreur « suppression incomplete »: jamais d'oubli silencieux. Element absent: ne fait rien.
   */
  mutateTest(key: Key, fn: (item: Record<string, unknown>) => TestMutation): Promise<void>;
  /** `studentId` et `docId` (signalements) sont lus pour rattacher un signalement a l'eleve; les autres elements n'en portent pas. */
  list(pk: string, skPrefix?: string): Promise<TreeKey[]>;
  remove(keys: Key[]): Promise<void>;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Identifiants valides: ni vide, ni `#`, ni separateur (evite qu'un id vide ou piege elargisse une suppression). */
function assertIds(...ids: string[]): void {
  for (const id of ids) if (!ID.test(id)) throw new RangeError('identifiant invalide');
}

async function removeAll(db: TreeDb, ks: Key[]): Promise<number> {
  if (ks.length) await db.remove(ks);
  return ks.length;
}

/**
 * Fiche: elle-meme, ses CLAIM, VERDICT, QCM, GAP, et les passages de test (TEST#) de l'eleve sur cette fiche. Renvoie le nombre d'elements supprimes.
 * Controle d'appartenance: si la fiche n'est pas liee a l'eleve (`STUDENT#<sid>` / `DOC#<docId>`), ne supprime RIEN et renvoie 0
 * (un handler qui passe un docId pris dans l'URL ne peut pas effacer la fiche d'un autre eleve).
 */
export async function deleteDocTree(db: TreeDb, sid: string, docId: string, opts: { garderTests?: boolean } = {}): Promise<number> {
  assertIds(sid, docId);
  const link = (await db.list(`STUDENT#${sid}`, `DOC#${docId}`)).filter((k) => k.SK === `DOC#${docId}`);
  if (link.length === 0) return 0;
  let n = await removeAll(db, await db.list(`DOC#${docId}`));
  // Historique des tests (H1, decision P2): les passages sur cette fiche partent avec elle (`docId` est porte par chaque element TEST#).
  // Q1: un passage sur plusieurs fiches (`docIds` de 2 fiches ou plus) perd seulement les lignes de cette fiche; les autres passages partent comme avant.
  if (!opts.garderTests) {
    const tests = (await db.list(`STUDENT#${sid}`, 'TEST#')).filter((k) => k.docId === docId || (k.docIds?.includes(docId) ?? false));
    const multi = (k: TreeKey): boolean => (k.docIds?.length ?? 0) > 1 && (k.docIds as string[]).includes(docId);
    n += await removeAll(db, tests.filter((k) => !multi(k)).map(({ PK, SK }) => ({ PK, SK })));
    for (const k of tests.filter(multi)) await db.mutateTest({ PK: k.PK, SK: k.SK }, (it) => withoutDoc(it, docId));
  }
  n += await removeAll(db, link);
  return n;
}

/** Passage multi-fiches sans la fiche `docId`: ses lignes partent, les compteurs sont recalcules; plus aucune ligne = le passage disparait (section 7). */
export function withoutDoc(it: Record<string, unknown>, docId: string): TestMutation {
  const all = Array.isArray(it.items) ? (it.items as TestLine[]) : [];
  const lines = all.filter((l) => !l.q.startsWith(`${docId}:`));
  if (lines.length === 0) return 'supprimer';
  const ids = (Array.isArray(it.docIds) ? (it.docIds as string[]) : []).filter((d) => d !== docId);
  const removed = all.length - lines.length;
  const total = Math.max(1, Number(it.total) || 1);
  const kinds = new Set(lines.map((l) => l.k));
  const out: Record<string, unknown> = {
    ...it,
    items: lines,
    ...recount(lines),
    mode: kinds.size > 1 ? 'mixte' : kinds.has('gap') ? 'gap' : 'qcm',
    docIds: ids,
    docId: ids[0] ?? String(it.docId ?? ''),
    // Passage complet: `total` = lignes restantes; sinon valeur approchee (le tirage n'est pas stocke dans TEST#).
    total: all.length >= total ? lines.length : Math.max(lines.length, total - removed),
  };
  if (ids.length === 1) out.scope = 'fiche';
  else if (it.scope === 'fiches') out.titre = `${ids.length} fiches`;
  return out;
}

/**
 * Cours conserve (contrat 1.3): son en-tete `COURS#<coursId>`, ses textes `COURS#<coursId>#T<nn>` et ses blocs `COURS#<coursId>#B` (R1), dans la partition de l'eleve.
 * Controle d'appartenance: si l'en-tete n'est pas dans `STUDENT#<sid>`, ne supprime RIEN et renvoie 0. Les cles sont comparees EXACTEMENT
 * (`COURS#<id>`) ou avec le prefixe `COURS#<id>#T` (jamais `COURS#<id>x`). `jobId` (lu dans l'en-tete par le handler) supprime aussi la copie
 * de travail `JOB#<jobId>/TEXT#` (7 jours), pour que supprimer le cours n'en laisse pas de copie. Ne touche pas aux fiches.
 */
export async function deleteCoursTree(db: TreeDb, sid: string, coursId: string, opts: { jobId?: string } = {}): Promise<number> {
  assertIds(sid, coursId);
  if (opts.jobId !== undefined) assertIds(opts.jobId);
  const head = (await db.list(`STUDENT#${sid}`, `COURS#${coursId}`)).filter((k) => k.SK === `COURS#${coursId}`);
  if (head.length === 0) return 0;
  const texts = (await db.list(`STUDENT#${sid}`, `COURS#${coursId}#T`)).filter((k) => k.SK.startsWith(`COURS#${coursId}#T`));
  const blocks = (await db.list(`STUDENT#${sid}`, `COURS#${coursId}#B`)).filter((k) => k.SK === `COURS#${coursId}#B`); // blocs et figures (R1)
  let n = await removeAll(db, [...texts, ...blocks, ...head]);
  if (opts.jobId !== undefined) {
    n += await removeAll(db, (await db.list(`JOB#${opts.jobId}`, 'TEXT#')).filter((k) => k.SK.startsWith('TEXT#')));
    n += await removeAll(db, (await db.list(`JOB#${opts.jobId}`, 'BLOCKS')).filter((k) => k.SK === 'BLOCKS'));
  }
  return n;
}

/** Elements de la famille qui portent l'identifiant de l'eleve: lien eleve, quotas et classements, par PREFIXE explicite. */
const FAMILY_STUDENT_PREFIXES = ['QUOTA#', 'WEEK#'] as const;
const isFamilyStudentItem = (k: Key, sid: string): boolean =>
  k.SK === `STUDENT#${sid}` || (FAMILY_STUDENT_PREFIXES.some((p) => k.SK.startsWith(p)) && k.SK.endsWith(`#${sid}`));

/**
 * Eleve: ses fiches (arbres complets), jobs et transcriptions, profil, jours, tentatives, compteurs, puis ses quotas et classements.
 * Ne fait rien (renvoie 0) si l'eleve n'appartient pas a la famille. Ne touche ni Cognito ni S3 ni PASSAGE#/CLAIMCACHE#
 * (partages): le handler (L3) supprime l'utilisateur Cognito.
 */
export async function deleteStudentTree(db: TreeDb, familyId: string, sid: string): Promise<number> {
  assertIds(familyId, sid);
  const fam = await db.list(`FAMILY#${familyId}`);
  if (!fam.some((k) => k.SK === `STUDENT#${sid}`)) return 0;
  let n = 0;
  const docIds = new Set<string>();
  for (const k of await db.list(`STUDENT#${sid}`)) {
    if (k.SK.startsWith('DOC#')) {
      docIds.add(k.SK.slice(4));
      n += await deleteDocTree(db, sid, k.SK.slice(4), { garderTests: true }); // les TEST# partent tous ensemble plus bas: aucun mutateTest
    }
    if (k.SK.startsWith('JOB#')) n += await removeAll(db, await db.list(`JOB#${k.SK.slice(4)}`)); // TEXT#
  }
  n += await removeAll(db, (await db.list(`STUDENT#${sid}`)).filter((k) => !k.SK.startsWith('DOC#')));
  // Signalements de l'eleve (commentaire libre): ceux qui portent son `studentId`, ou, pour les anciens sans `studentId`, ceux d'une de ses fiches.
  const mine = (k: TreeKey): boolean => k.SK.startsWith('REPORT#') && (k.studentId === sid || (k.studentId === undefined && k.docId !== undefined && docIds.has(k.docId)));
  n += await removeAll(db, (await db.list(`FAMILY#${familyId}`)).filter((k) => isFamilyStudentItem(k, sid) || mine(k)).map(({ PK, SK }) => ({ PK, SK })));
  return n;
}

/** Famille: tous ses eleves, puis ce qui reste sous FAMILY#. */
export async function deleteFamilyTree(db: TreeDb, familyId: string): Promise<number> {
  assertIds(familyId);
  let n = 0;
  const fam = await db.list(`FAMILY#${familyId}`);
  for (const k of fam.filter((x) => x.SK.startsWith('STUDENT#'))) n += await deleteStudentTree(db, familyId, k.SK.slice(8));
  n += await removeAll(db, await db.list(`FAMILY#${familyId}`));
  return n;
}

export function dynamoTreeDb(client: DynamoDBDocumentClient, table: string, sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms))): TreeDb {
  return {
    async list(pk, skPrefix) {
      const out: TreeKey[] = [];
      let start: Record<string, unknown> | undefined;
      do {
        const r = await client.send(
          new QueryCommand({
            TableName: table,
            KeyConditionExpression: skPrefix ? 'PK = :p AND begins_with(SK, :s)' : 'PK = :p',
            ExpressionAttributeValues: skPrefix ? { ':p': pk, ':s': skPrefix } : { ':p': pk },
            ProjectionExpression: 'PK, SK, studentId, docId, docIds',
            ExclusiveStartKey: start,
            ConsistentRead: true, // un element ecrit juste avant ne doit pas echapper a une suppression (RGPD)
          }),
        );
        for (const i of r.Items ?? []) out.push({ PK: i.PK as string, SK: i.SK as string, ...(typeof i.studentId === 'string' ? { studentId: i.studentId } : {}), ...(typeof i.docId === 'string' ? { docId: i.docId } : {}), ...(Array.isArray(i.docIds) ? { docIds: i.docIds as string[] } : {}) });
        start = r.LastEvaluatedKey;
      } while (start);
      return out;
    },
    async mutateTest(key, fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        if (attempt > 0) await sleep(50 * 2 ** attempt);
        const cur = (await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item;
        if (!cur) return;
        const r = fn(cur);
        if (r === 'garder') return;
        const cond = typeof cur.v === 'number' ? { ConditionExpression: 'v = :ev', ExpressionAttributeValues: { ':ev': cur.v } } : { ConditionExpression: 'attribute_not_exists(v)' };
        try {
          if (r === 'supprimer') await client.send(new DeleteCommand({ TableName: table, Key: key, ...cond }));
          else await client.send(new PutCommand({ TableName: table, Item: { ...r, PK: key.PK, SK: key.SK, v: (typeof cur.v === 'number' ? cur.v : 0) + 1 }, ...cond }));
          return;
        } catch (e) {
          if ((e as { name?: string }).name !== 'ConditionalCheckFailedException') throw e;
        }
      }
      throw new Error('suppression incomplete (conflit persistant)');
    },
    async remove(ks) {
      for (let i = 0; i < ks.length; i += 25) {
        let req: Record<string, { DeleteRequest: { Key: Key } }[]> = { [table]: ks.slice(i, i + 25).map((Key) => ({ DeleteRequest: { Key } })) };
        for (let attempt = 0; attempt < 6 && Object.keys(req).length; attempt++) {
          if (attempt > 0) await sleep(50 * 2 ** attempt); // backoff exponentiel sur les elements non traites
          const r = await client.send(new BatchWriteCommand({ RequestItems: req }));
          req = (r.UnprocessedItems ?? {}) as typeof req;
        }
        if (Object.keys(req).length) throw new Error('suppression incomplete (elements non traites)');
      }
    },
  };
}

/** Implementation memoire (tests). */
export function memoryTreeDb(initial: TreeKey[], hooks: { beforeWrite?: (key: Key, attempt: number) => void } = {}): TreeDb & { keys: () => Key[]; get: (k: Key) => Record<string, unknown> | undefined; mutations: number } {
  const set = new Map<string, Record<string, unknown> & { PK: string; SK: string; v?: number }>(initial.map((k) => [`${k.PK}|${k.SK}`, { v: 0, ...k }]));
  const state = { mutations: 0 };
  return {
    get mutations() {
      return state.mutations;
    },
    get: (k) => set.get(`${k.PK}|${k.SK}`),
    async mutateTest(key, fn) {
      for (let attempt = 0; attempt < 5; attempt++) {
        const live = set.get(`${key.PK}|${key.SK}`);
        if (!live) return;
        const cur = structuredClone(live); // copie lue: une ecriture concurrente change `live`, pas `cur`
        const r = fn(cur);
        if (r === 'garder') return;
        hooks.beforeWrite?.(key, attempt); // un test simule ici une reponse concurrente: la version change
        const now = set.get(`${key.PK}|${key.SK}`);
        if (now?.v !== cur.v) continue;
        state.mutations++;
        if (r === 'supprimer') set.delete(`${key.PK}|${key.SK}`);
        else set.set(`${key.PK}|${key.SK}`, { ...r, PK: key.PK, SK: key.SK, v: (cur.v ?? 0) + 1 });
        return;
      }
      throw new Error('suppression incomplete (conflit persistant)');
    },
    keys: () => [...set.values()].map(({ PK, SK }) => ({ PK, SK })),
    async list(pk, skPrefix) {
      return [...set.values()].filter((k) => k.PK === pk && (!skPrefix || k.SK.startsWith(skPrefix)));
    },
    async remove(ks) {
      for (const k of ks) set.delete(`${k.PK}|${k.SK}`);
    },
  };
}
