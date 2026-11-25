// Handler `folders-api` (contrat 1.3): dossiers de l'eleve. L'appartenance d'une fiche est portee par `DOC#.dossierId` (une seule source).
// Eleve: toutes les routes. Parent: GET /folders seulement (lecture, `studentId` obligatoire). Role d'abord (403), existence ensuite (404).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { FolderNameRequestSchema, FolderScansRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { keys } from '../../../shared/ddb/keys.js';
import { cleanFolderName, labelKey, MAX_FOLDERS_PER_STUDENT } from '../../../shared/scans.js';
import { mapLimit, type Ctx } from '../pipeline/ctx.js';
import { bodyOf, callerOf, fail, json, noContent, pathId, requireStudent } from '../pipeline/http.js';
import type { Item } from '../pipeline/ports.js';
import { studentIdsOf } from '../scans/list.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;

const BATCH = 25;
const view = (f: Item, scanCount: number) => ({ folderId: f.SK.slice('FOLDER#'.length), name: String(f.nom), createdAt: String(f.createdAt), scanCount });
/** Erreurs propres aux dossiers (hors `ErrorCode` de pipeline/http.ts, qui n'est pas a ce lot). */
const coded = (status: number, code: string, message: string) => json(status, { code, message });

const foldersOf = (ctx: Ctx, sid: string) => ctx.db.query(`STUDENT#${sid}`, 'FOLDER#');
const docsOf = (ctx: Ctx, sid: string) => ctx.db.query(`STUDENT#${sid}`, 'DOC#');
const countIn = (docs: Item[], folderId: string) => docs.filter((d) => d.dossierId === folderId).length;

/** Le dossier DE L'ELEVE (une cle dans sa partition: un dossier d'un autre eleve est introuvable). */
async function folderOf(ctx: Ctx, sid: string, folderId: string): Promise<Item> {
  return (await ctx.db.get(keys.folder(sid, folderId))) ?? fail('introuvable', 'Introuvable');
}

async function list(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const asked = event.queryStringParameters?.studentId;
  if (asked !== undefined && (asked.length < 1 || asked.length > 64)) return fail('requete_invalide', 'Demande invalide');
  let sid: string;
  if (c.role === 'eleve') {
    if (asked !== undefined && asked !== c.studentId) return fail('introuvable', 'Introuvable');
    sid = c.studentId!;
  } else {
    if (asked === undefined) return fail('requete_invalide', 'Demande invalide');
    if (!(await studentIdsOf(ctx, c.familyId)).includes(asked)) return fail('introuvable', 'Introuvable');
    sid = asked;
  }
  const [folders, docs] = await Promise.all([foldersOf(ctx, sid), docsOf(ctx, sid)]);
  const items = folders.map((f) => ({ f, key: labelKey(String(f.nom)) })).sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)).map(({ f }) => view(f, countIn(docs, f.SK.slice('FOLDER#'.length))));
  return json(200, { items });
}

async function create(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const sid = requireStudent(await callerOf(ctx, event));
  const parsed = FolderNameRequestSchema.safeParse(bodyOf(event));
  const name = parsed.success ? cleanFolderName(parsed.data.name) : undefined;
  if (!name) return fail('requete_invalide', 'Demande invalide');
  const existing = await foldersOf(ctx, sid);
  if (existing.length >= MAX_FOLDERS_PER_STUDENT) return coded(400, 'dossiers_limite', 'Tu as atteint 50 dossiers');
  const nomCle = labelKey(name);
  // shortcut: deux creations simultanees du meme nom peuvent passer (deux dossiers homonymes, sans consequence), voir docs/data-model.md.
  if (existing.some((f) => f.nomCle === nomCle)) return coded(409, 'dossier_nom_pris', 'Tu as deja un dossier avec ce nom');
  const item = { ...keys.folder(sid, ctx.newId()), nom: name, nomCle, createdAt: ctx.now().toISOString() };
  await ctx.db.put(item);
  return json(201, view(item, 0));
}

async function rename(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const sid = requireStudent(await callerOf(ctx, event));
  const folderId = pathId(event, 'folderId');
  await folderOf(ctx, sid, folderId);
  const parsed = FolderNameRequestSchema.safeParse(bodyOf(event));
  const name = parsed.success ? cleanFolderName(parsed.data.name) : undefined;
  if (!name) return fail('requete_invalide', 'Demande invalide');
  const nomCle = labelKey(name);
  // Le meme nom que lui-meme est permis; celui d'un AUTRE dossier de l'eleve non.
  if ((await foldersOf(ctx, sid)).some((f) => f.nomCle === nomCle && f.SK !== `FOLDER#${folderId}`)) return coded(409, 'dossier_nom_pris', 'Tu as deja un dossier avec ce nom');
  const updated = await ctx.db.update(keys.folder(sid, folderId), { set: { nom: name, nomCle }, cond: { exists: true } });
  if (!updated) return fail('introuvable', 'Introuvable'); // supprime entre-temps
  return json(200, view(updated, countIn(await docsOf(ctx, sid), folderId)));
}

/** Retire `dossierId` des fiches d'abord, puis supprime le dossier: interrompue, elle laisse un dossier a re-supprimer (second DELETE), jamais des fiches rangees dans un dossier fantome. */
async function remove(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const sid = requireStudent(await callerOf(ctx, event));
  const folderId = pathId(event, 'folderId');
  await folderOf(ctx, sid, folderId);
  const docs = (await docsOf(ctx, sid)).filter((d) => d.dossierId === folderId);
  // Lots de 25 en parallele; la condition evite d'ecraser une fiche deplacee dans un autre dossier entre-temps.
  for (let i = 0; i < docs.length; i += BATCH) {
    await mapLimit(docs.slice(i, i + BATCH), BATCH, (d) => ctx.db.update({ PK: d.PK, SK: d.SK }, { remove: ['dossierId'], cond: { exists: true, eq: { dossierId: folderId } } }));
  }
  await ctx.db.remove([keys.folder(sid, folderId)]);
  return noContent();
}

async function addScans(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const sid = requireStudent(await callerOf(ctx, event));
  const folderId = pathId(event, 'folderId');
  const folder = await folderOf(ctx, sid, folderId);
  const parsed = FolderScansRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  // Tout est valide avant la premiere ecriture: un docId inconnu ou d'un autre eleve annule l'ensemble (404).
  const docs = await docsOf(ctx, sid);
  const known = new Set(docs.map((d) => d.SK.slice('DOC#'.length)));
  if (!parsed.data.docIds.every((id) => known.has(id))) return fail('introuvable', 'Introuvable');
  const ids = new Set(parsed.data.docIds);
  const toMove = docs.filter((d) => ids.has(d.SK.slice('DOC#'.length)) && d.dossierId !== folderId);
  for (let i = 0; i < toMove.length; i += BATCH) {
    const done = await mapLimit(toMove.slice(i, i + BATCH), BATCH, (d) => ctx.db.update({ PK: d.PK, SK: d.SK }, { set: { dossierId: folderId }, cond: { exists: true } }));
    if (done.some((x) => x === undefined)) return fail('introuvable', 'Introuvable'); // fiche supprimee entre-temps
  }
  return json(200, view(folder, countIn(docs, folderId) + toMove.length));
}

async function removeScan(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const sid = requireStudent(await callerOf(ctx, event));
  const folderId = pathId(event, 'folderId');
  const docId = pathId(event, 'docId');
  await folderOf(ctx, sid, folderId);
  const done = await ctx.db.update(keys.doc(sid, docId), { remove: ['dossierId'], cond: { exists: true, eq: { dossierId: folderId } } });
  if (!done) return fail('introuvable', 'Introuvable'); // fiche absente, d'un autre eleve, ou rangee dans un autre dossier
  return noContent();
}

const ROUTES: Record<string, (ctx: Ctx, e: APIGatewayProxyEventV2) => Res> = {
  'GET /folders': list,
  'POST /folders': create,
  'PATCH /folders/{folderId}': rename,
  'DELETE /folders/{folderId}': remove,
  'POST /folders/{folderId}/scans': addScans,
  'DELETE /folders/{folderId}/scans/{docId}': removeScan,
};

export async function foldersApi(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const h = ROUTES[event.routeKey];
  return h ? h(ctx, event) : fail('introuvable', 'Introuvable');
}
