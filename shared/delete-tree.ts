// Suppression en cascade (design-v2 4.8). Permis a travers les proprietaires: effacer n'est pas ecrire.
// Chaque fonction part de requetes sur PK (pas de Scan) et supprime par lots de 25.
import { BatchWriteCommand, DeleteCommand, DynamoDBDocumentClient, GetCommand, PutCommand, QueryCommand } from '@aws-sdk/lib-dynamodb';
import type { Key } from './ddb/keys.js';
import { recount, type TestLine } from './tests-history.js';

/** Port minimal: liste les cles d'une partition (avec prefixe de SK facultatif) et supprime des cles. */
export type TreeKey = Key & { studentId?: string; docId?: string; docIds?: string[]; /** E1: nombre de pages d'une COPIE#, pour deduire les cles S3 exactes. */ pages?: number;
  /** S1: `SHAREREF#` porte `hash` (cle de la copie publique `SHARE#<hash>`), `famSlot` (emplacement famille) et `docId`; `SHARESLOT#` porte `sid`. */
  hash?: string; famSlot?: number; sid?: string };
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
  /**
   * S1 (relecture #111 m2): pose `sharing: false` sur l'element eleve `FAMILY#<fid>/STUDENT#<sid>` (sans effet s'il n'existe pas). Appele AVANT la suppression des liens d'un eleve:
   * une creation de lien qui part pendant la suppression echoue sur la verification de l'eleve (`sharing=true`), donc aucune copie orpheline. Ecrit par BatchWriteItem (PutRequest),
   * seul droit d'ecriture des roles de suppression. Facultatif pour les faux ports de test; tous les ports reels l'implementent (test).
   */
  closeSharing?(key: Key): Promise<void>;
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
export async function deleteDocTree(db: TreeDb, sid: string, docId: string, opts: { garderTests?: boolean; /** S1 (#34): supprime AVANT TOUT (copies publiques, puis references et emplacements) les liens de cette fiche. DESACTIVE par defaut: failJob, append et les roles du pipeline ne l'activent jamais. */ deleteShares?: { familyId: string }; /** E1: supprime ces cles S3 EXACTES (images de copie) AVANT toute suppression DynamoDB (S3 d'abord: interrompue, la reprise retrouve les elements). */ deleteFiles?: (keys: string[]) => Promise<void> } = {}): Promise<number> {
  assertIds(sid, docId);
  const link = (await db.list(`STUDENT#${sid}`, `DOC#${docId}`)).filter((k) => k.SK === `DOC#${docId}`);
  if (link.length === 0) return 0;
  // S1: la copie PUBLIQUE d'abord. Si sa suppression echoue, l'erreur remonte et RIEN d'autre n'est supprime (jamais de copie orpheline lisible sans sa fiche).
  let n = opts.deleteShares ? await deleteSharesOf(db, opts.deleteShares.familyId, sid, { docId }) : 0;
  // E1: copies de cette fiche (images a supprimer, cles exactes deduites de `pages`) et progressions des exercices (EXOP#). EXO# part avec DOC#<docId>.
  const copies = (await db.list(`STUDENT#${sid}`, 'COPIE#')).filter((k) => k.docId === docId);
  const files = copies.flatMap((k) => Array.from({ length: Math.min(3, Math.max(0, k.pages ?? 0)) }, (_, i) => `copies/${sid}/${k.SK.slice('COPIE#'.length)}/p${i + 1}`));
  if (files.length && opts.deleteFiles) await opts.deleteFiles(files);
  n += await removeAll(db, await db.list(`DOC#${docId}`));
  n += await removeAll(db, [...copies, ...(await db.list(`STUDENT#${sid}`, `EXOP#${docId}:`))].map(({ PK, SK }) => ({ PK, SK })));
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

const HASH = /^[0-9a-f]{64}$/;
/**
 * S1 (#34): supprime les liens de partage d'un eleve (`filter.docId`: ceux d'une seule fiche). ORDRE: les copies publiques `SHARE#<hache>` (META, DAY#, REPORT#) d'abord, puis
 * les references `SHAREREF#` de l'eleve, puis ses emplacements famille `SHARESLOT#` (seulement ceux dont `sid` est cet eleve: un emplacement libere puis reutilise par un
 * frere n'est jamais supprime). Rejouable: une reference sans copie se supprime sans erreur. Une copie dont la reference a deja disparu n'est plus atteignable (son `ttl` la purge).
 * N'est appelee que par l'option `deleteShares` des fonctions ci-dessous, activee par docs-delete, cours-delete (`fiches=supprimer`), students-delete, family-admin et shares-parent-delete.
 */
export async function deleteSharesOf(db: TreeDb, familyId: string, sid: string, filter: { docId?: string } = {}): Promise<number> {
  assertIds(familyId, sid);
  if (filter.docId !== undefined) assertIds(filter.docId);
  const refs = (await db.list(`STUDENT#${sid}`, 'SHAREREF#')).filter((k) => /^SHAREREF#[1-5]$/.test(k.SK) && (filter.docId === undefined || k.docId === filter.docId));
  if (refs.length === 0 && filter.docId !== undefined) return 0;
  let n = 0;
  for (const hash of new Set(refs.map((r) => r.hash).filter((h): h is string => typeof h === 'string' && HASH.test(h)))) n += await removeAll(db, (await db.list(`SHARE#${hash}`)).map(({ PK, SK }) => ({ PK, SK })));
  const slots = (await db.list(`FAMILY#${familyId}`, 'SHARESLOT#')).filter((k) => /^SHARESLOT#([1-9]|10)$/.test(k.SK) && k.sid === sid && (filter.docId === undefined || refs.some((r) => `SHARESLOT#${r.famSlot}` === k.SK)));
  return n + (await removeAll(db, [...refs, ...slots].map(({ PK, SK }) => ({ PK, SK }))));
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
  // Une seule fiche restante: le passage redevient un passage d'une fiche; l'etiquette « N fiches » est recalculee (le nom d'un dossier reste, c'est un nom, pas un nombre).
  if (ids.length === 1) out.scope = 'fiche';
  if (it.scope === 'fiches') out.titre = ids.length === 1 ? '1 fiche' : `${ids.length} fiches`;
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
const isFamilyStudentItem = (k: Key & { studentId?: string }, sid: string): boolean =>
  k.SK === `STUDENT#${sid}` || (k.SK.startsWith('NAME#') && k.studentId === sid) || (FAMILY_STUDENT_PREFIXES.some((p) => k.SK.startsWith(p)) && k.SK.endsWith(`#${sid}`));

/**
 * Eleve: ses fiches (arbres complets), jobs et transcriptions, profil, jours, tentatives, compteurs, puis ses quotas et classements.
 * Ne fait rien (renvoie 0) si l'eleve n'appartient pas a la famille. Ne touche ni Cognito ni S3 ni PASSAGE#/CLAIMCACHE#
 * (partages): le handler (L3) supprime l'utilisateur Cognito.
 */
export async function deleteStudentTree(db: TreeDb, familyId: string, sid: string, opts: { /** S1: supprime d'abord tous les liens de l'eleve. Desactive par defaut. */ deleteShares?: boolean } = {}): Promise<number> {
  assertIds(familyId, sid);
  const fam = await db.list(`FAMILY#${familyId}`);
  if (!fam.some((k) => k.SK === `STUDENT#${sid}`)) return 0;
  if (opts.deleteShares) await db.closeSharing?.({ PK: `FAMILY#${familyId}`, SK: `STUDENT#${sid}` }); // plus aucune creation possible, PUIS les liens
  let n = opts.deleteShares ? await deleteSharesOf(db, familyId, sid) : 0; // les copies publiques AVANT tout le reste
  const docIds = new Set<string>();
  for (const k of await db.list(`STUDENT#${sid}`)) {
    if (k.SK.startsWith('DOC#')) {
      docIds.add(k.SK.slice(4));
      n += await deleteDocTree(db, sid, k.SK.slice(4), { garderTests: true }); // les TEST# partent tous ensemble plus bas: aucun mutateTest
    }
    if (k.SK.startsWith('JOB#')) {
      n += await removeAll(db, await db.list(`JOB#${k.SK.slice(4)}`)); // TEXT#, CHANGES
      // M1 #90: une modification de cours ouverte a des fiches de travail `DOC#<revisionId>-<k>` (sans en-tete: aucun `DOC#` de l'eleve ne les montre); le job les liste dans `docIds`.
      for (const d of k.docIds ?? []) if (d.startsWith(`${k.SK.slice(4)}-`)) n += await removeAll(db, await db.list(`DOC#${d}`));
    }
  }
  n += await removeAll(db, (await db.list(`STUDENT#${sid}`)).filter((k) => !k.SK.startsWith('DOC#')));
  // Signalements de l'eleve (commentaire libre): ceux qui portent son `studentId`, ou, pour les anciens sans `studentId`, ceux d'une de ses fiches.
  const mine = (k: TreeKey): boolean => k.SK.startsWith('REPORT#') && (k.studentId === sid || (k.studentId === undefined && k.docId !== undefined && docIds.has(k.docId)));
  n += await removeAll(db, (await db.list(`FAMILY#${familyId}`)).filter((k) => isFamilyStudentItem(k, sid) || mine(k)).map(({ PK, SK }) => ({ PK, SK })));
  return n;
}

/** Famille: tous ses eleves, puis ce qui reste sous FAMILY#. */
export async function deleteFamilyTree(db: TreeDb, familyId: string, opts: { /** S1: voir deleteStudentTree. Desactive par defaut. */ deleteShares?: boolean } = {}): Promise<number> {
  assertIds(familyId);
  let n = 0;
  const fam = await db.list(`FAMILY#${familyId}`);
  for (const k of fam.filter((x) => x.SK.startsWith('STUDENT#'))) n += await deleteStudentTree(db, familyId, k.SK.slice(8), opts);
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
            ProjectionExpression: 'PK, SK, studentId, docId, docIds, pages, #h, famSlot, sid', // `hash` est un mot reserve de DynamoDB
            ExpressionAttributeNames: { '#h': 'hash' },
            ExclusiveStartKey: start,
            ConsistentRead: true, // un element ecrit juste avant ne doit pas echapper a une suppression (RGPD)
          }),
        );
        for (const i of r.Items ?? []) out.push({ PK: i.PK as string, SK: i.SK as string, ...(typeof i.studentId === 'string' ? { studentId: i.studentId } : {}), ...(typeof i.docId === 'string' ? { docId: i.docId } : {}), ...(typeof i.pages === 'number' ? { pages: i.pages } : {}), ...(Array.isArray(i.docIds) ? { docIds: i.docIds as string[] } : {}), ...(typeof i.hash === 'string' ? { hash: i.hash } : {}), ...(typeof i.famSlot === 'number' ? { famSlot: i.famSlot } : {}), ...(typeof i.sid === 'string' ? { sid: i.sid } : {}) });
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
    async closeSharing(key) {
      const cur = (await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }))).Item;
      if (!cur || cur.sharing !== true) return;
      const r = await client.send(new BatchWriteCommand({ RequestItems: { [table]: [{ PutRequest: { Item: { ...cur, sharing: false } } }] } }));
      if (Object.keys(r.UnprocessedItems ?? {}).length) throw new Error('fermeture du partage incomplete');
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
    async closeSharing(key) {
      const cur = set.get(`${key.PK}|${key.SK}`);
      if (cur && cur.sharing === true) set.set(`${key.PK}|${key.SK}`, { ...cur, sharing: false });
    },
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
