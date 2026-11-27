// Handler `cours-api` (contrat 1.3): GET /cours/{coursId} (texte corrige) et DELETE /cours/{coursId}?fiches=garder|supprimer.
// Eleve seulement: le parent a 403 (role d'abord, existence ensuite). Aucun texte de cours dans les journaux ni les erreurs.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { deleteCoursTree, deleteDocTree } from '../../../shared/delete-tree.js';
import { keys } from '../../../shared/ddb/keys.js';
import { ID_RE, mapLimit, type Ctx } from '../pipeline/ctx.js';
import { callerOf, fail, json, noContent, pathId, requireStudent } from '../pipeline/http.js';
import { treeDbFrom, type Item } from '../pipeline/ports.js';
import { coursFiguresPrefix } from '../pipeline/figures.js';
import { coursMeta } from './meta.js';
import { clearRevisionForDelete, isOpenRevision, revisionHolder } from '../revise/lock.js';
import { DELETING, MSG_APPEND, reclaimLock } from '../pipeline/append.js';
import { coursMarks, loadCoursBlocks, signFigures } from './view.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;
const BATCH = 25;
const MSG_REVISION_BUSY = 'Une modification est en cours';

async function get(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const sid = requireStudent(await callerOf(ctx, event));
  const coursId = pathId(event, 'coursId');
  const head = (await ctx.db.get(keys.cours(sid, coursId))) ?? fail('introuvable', 'Introuvable');
  const prefix = `COURS#${coursId}#T`;
  // Seules les pages du cours (`pages`): le texte d'un ajout interrompu, ecrit avant sa restauration, n'est jamais montre.
  const texts = (await ctx.db.query(`STUDENT#${sid}`, prefix)).filter((t) => t.SK.startsWith(prefix) && Number(t.page) <= Number(head.pages));
  const sections = Array.isArray(head.sections) ? (head.sections as { docId?: unknown }[]) : [];
  const ids = [...new Set(sections.map((s) => s.docId).filter((d): d is string => typeof d === 'string' && ID_RE.test(d)))];
  const existing = new Set((await Promise.all(ids.map(async (id) => ((await ctx.db.get(keys.doc(sid, id))) ? id : undefined)))).filter((x): x is string => x !== undefined));
  const extra = await loadCoursBlocks(ctx, sid, coursId); // absent pour un cours ancien: l'ecran affiche les phrases
  const marks = extra ? await coursMarks(ctx, sid, head) : [];
  // M1 #90: tant qu'une modification est ouverte, un autre appareil de l'eleve voit la banniere.
  const rev = await revisionHolder(ctx, sid, head);
  return json(200, {
    ...coursMeta(head, existing),
    ...(rev && isOpenRevision(rev) ? { revision: { revisionId: rev.SK.slice('JOB#'.length), etat: 'en_cours' } } : {}),
    ...(extra ? { figureCount: extra.figures.length, blocks: extra.blocks, figures: await signFigures(ctx, sid, coursId, extra.figures), marks } : {}),
    texts: texts.map((t) => ({ page: Number(t.page), sentences: t.sentences ?? [] })).sort((a, b) => a.page - b.page), // tri numerique (la page 10 apres la 2)
  });
}

/**
 * Fiches d'abord, puis le cours: interrompue, la suppression se reprend par un second DELETE (l'en-tete existe encore).
 * `garder`: les fiches perdent `coursId`, `sectionIndex` et `sectionCount`. `supprimer`: elles sont supprimees avec leur arbre.
 * Dans les deux cas le job (7 jours) perd `coursId`, sinon `GET /scans` renverrait un lien mort.
 */
async function del(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const coursId = pathId(event, 'coursId');
  const fiches = event.queryStringParameters?.fiches;
  if (fiches !== 'garder' && fiches !== 'supprimer') return fail('requete_invalide', 'Demande invalide'); // obligatoire, pas de defaut
  let head = (await ctx.db.get(keys.cours(sid, coursId))) ?? fail('introuvable', 'Introuvable');
  // Ajout de pages (F10): pendant un ajout reellement ouvert, 409. Un verrou laisse par un ajout fini ou restaure est repris. Sinon le verrou `suppression` est pose
  // (condition: aucun autre verrou) AVANT toute suppression: aucun ajout ne peut demarrer pendant que le cours disparait. Une suppression interrompue se reprend par un second DELETE.
  if (head.appendJobId !== DELETING) {
    // M1 #90: une modification ouverte = 409; une modification bloquee (`rev-fail` a plante) est nettoyee ICI (copie de travail supprimee, verrou libere).
    if (!(await clearRevisionForDelete(ctx, sid, head))) fail('etat_invalide', MSG_REVISION_BUSY);
    head = (await ctx.db.get(keys.cours(sid, coursId))) ?? fail('introuvable', 'Introuvable');
    if (!(await reclaimLock(ctx, sid, head))) fail('etat_invalide', MSG_APPEND.deleteBusy);
    const locked = await ctx.db.update(keys.cours(sid, coursId), { set: { appendJobId: DELETING }, cond: { exists: true, absent: ['appendJobId'] } });
    head = locked ?? fail('etat_invalide', MSG_APPEND.deleteBusy);
  }
  // Figures conservees d'abord (S3 avant DynamoDB): interrompue, l'en-tete existe encore et un second DELETE reprend.
  await ctx.figures.deleteAll(coursFiguresPrefix(sid, coursId));
  const sectionDocs = new Set((Array.isArray(head.sections) ? (head.sections as { docId?: unknown }[]) : []).map((s) => s.docId).filter((d): d is string => typeof d === 'string'));
  const docs: Item[] = (await ctx.db.query(`STUDENT#${sid}`, 'DOC#')).filter((d) => d.coursId === coursId || sectionDocs.has(d.SK.slice('DOC#'.length)));
  const tree = treeDbFrom(ctx.db);
  // Signalements AVANT les fiches (comme `DELETE /docs`: le commentaire libre ne survit pas a sa fiche). Interrompue apres les fiches,
  // la reprise ne retrouverait plus rien a rattacher; ici, interrompue entre les deux, les fiches existent encore pour le second DELETE.
  if (fiches === 'supprimer' && docs.length) {
    const gone = new Set(docs.map((d) => d.SK.slice('DOC#'.length)));
    const reports = (await ctx.db.query(`FAMILY#${caller.familyId}`, 'REPORT#')).filter((r) => typeof r.docId === 'string' && gone.has(r.docId)).map((r) => ({ PK: r.PK, SK: r.SK }));
    if (reports.length) await ctx.db.remove(reports);
  }
  for (let i = 0; i < docs.length; i += BATCH) {
    await mapLimit(docs.slice(i, i + BATCH), BATCH, async (d) => {
      const docId = d.SK.slice('DOC#'.length);
      if (fiches === 'supprimer') await deleteDocTree(tree, sid, docId, { deleteFiles: (ks) => ctx.s3.deleteKeys(ks), deleteShares: { familyId: caller.familyId } }); // S1: liens de la fiche supprimes d'abord (`garder`: aucun effet)
      else await ctx.db.update({ PK: d.PK, SK: d.SK }, { remove: ['coursId', 'sectionIndex', 'sectionCount'], cond: { exists: true } });
    });
  }
  const jobId = typeof head.jobId === 'string' && ID_RE.test(head.jobId) ? head.jobId : undefined;
  // Tous les jobs qui ont construit le cours (le scan d'origine et ses ajouts): chacun perd `coursId` et sa copie de travail (cours ancien: `jobId` seul).
  const jobIds = [...new Set([...(Array.isArray(head.jobIds) ? (head.jobIds as unknown[]) : []), ...(jobId ? [jobId] : [])])].filter((j): j is string => typeof j === 'string' && ID_RE.test(j));
  for (const j of jobIds) {
    await ctx.db.update(keys.job(sid, j), { remove: ['coursId'], cond: { exists: true } }); // le job a pu expirer: sans effet
    // Copie de travail du texte AVANT l'en-tete du cours: interrompue, l'en-tete reste et un second DELETE finit le travail.
    const texts = (await ctx.db.query(`JOB#${j}`)).filter((t) => t.SK.startsWith('TEXT#') || t.SK === 'BLOCKS').map((t) => ({ PK: t.PK, SK: t.SK }));
    if (texts.length) await ctx.db.remove(texts);
  }
  await deleteCoursTree(tree, sid, coursId, { ...(jobId ? { jobId } : {}) });
  return noContent();
}

export async function coursApi(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  if (event.routeKey === 'GET /cours/{coursId}') return get(ctx, event);
  if (event.routeKey === 'DELETE /cours/{coursId}') return del(ctx, event);
  return fail('introuvable', 'Introuvable');
}
