// Handler `scans-list` (GET /scans, contrat 1.3): lit les jobs, fiches et dossiers visibles puis laisse `listScans` filtrer, trier, paginer.
// Aucun texte de cours: les champs lus sont une liste blanche (jamais `resume`, `empreinteMinHash`, ni TEXT#).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { BadCursorError, LIST_MAX_LIMIT, listScans, SUBJECTS, UnknownFolderError, type ScanItem, type ScanQuery } from '../../../shared/scans.js';
import type { Ctx } from '../pipeline/ctx.js';
import { callerOf, fail, json } from '../pipeline/http.js';
import type { Item } from '../pipeline/ports.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;

const JOB_FIELDS = ['PK', 'SK', 'state', 'stage', 'pages', 'uploadedKeys', 'readPages', 'createdAt', 'finishedAt', 'message', 'docId', 'docIds', 'coursId', 'draftTitle', 'draftSubject', 'suggestedSubject', 'suggestedTopic', 'subjectChoice', 'topicChoice', 'folderId', 'confirmExpiresAt'] as const;
const DOC_FIELDS = ['PK', 'SK', 'titre', 'matiere', 'sujet', 'dossierId', 'pages', 'pagesConsommees', 'jobId', 'createdAt', 'coursId', 'sectionIndex', 'sectionCount'] as const;

/**
 * Garde seulement les champs lus par `listScans`.
 * shortcut: le port `Db` (pipeline/ports.ts, lot B1) n'a pas de `ProjectionExpression`: la Query lit l'element entier et le filtre se fait ici,
 * en memoire. Les unites de lecture sont les memes qu'avec une projection; seule la memoire retenue et la reponse sont allegees. A passer en
 * projection DynamoDB si `Db.query` en recoit une.
 */
export const pick = (it: Item, fields: readonly string[]): ScanItem => Object.fromEntries(fields.filter((f) => it[f] !== undefined).map((f) => [f, it[f]])) as ScanItem;

const STATUSES = ['en_cours', 'a_confirmer', 'termine', 'echec'] as const;
const SORTS = ['date', 'subject', 'topic', 'status'] as const;

function parseQuery(event: APIGatewayProxyEventV2): ScanQuery & { studentId?: string } {
  const p = event.queryStringParameters ?? {};
  const bad = (): never => fail('requete_invalide', 'Demande invalide');
  const text = (name: string, max: number): string | undefined => {
    const v = p[name];
    if (v === undefined) return undefined;
    return v.length >= 1 && v.length <= max ? v : bad();
  };
  const oneOf = <T extends string>(name: string, allowed: readonly T[]): T | undefined => {
    const v = p[name];
    if (v === undefined) return undefined;
    return (allowed as readonly string[]).includes(v) ? (v as T) : bad();
  };
  let limit: number | undefined;
  if (p.limit !== undefined) {
    if (!/^\d{1,3}$/.test(p.limit)) bad();
    limit = Number(p.limit);
    if (limit < 1 || limit > LIST_MAX_LIMIT) bad();
  }
  return {
    studentId: text('studentId', 64),
    subject: oneOf('subject', [...SUBJECTS, 'none'] as const),
    topic: text('topic', 80),
    folderId: text('folderId', 64),
    status: oneOf('status', STATUSES),
    sort: oneOf('sort', SORTS),
    order: oneOf('order', ['asc', 'desc'] as const),
    limit,
    cursor: text('cursor', 200),
  };
}

/** Eleves de la famille (lus dans `FAMILY#<fid>`, jamais dans la requete). */
export const studentIdsOf = async (ctx: Ctx, familyId: string): Promise<string[]> => (await ctx.db.query(`FAMILY#${familyId}`, 'STUDENT#')).map((s) => s.SK.slice('STUDENT#'.length));

export async function scansList(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const { studentId, ...query } = parseQuery(event);
  // Role d'abord, existence ensuite: un parent ne doit pas apprendre qu'un identifiant existe ailleurs.
  let sids: string[];
  if (c.role === 'eleve') {
    if (studentId !== undefined && studentId !== c.studentId) return fail('introuvable', 'Introuvable');
    sids = [c.studentId!];
  } else {
    const family = await studentIdsOf(ctx, c.familyId);
    if (studentId !== undefined && !family.includes(studentId)) return fail('introuvable', 'Introuvable');
    sids = studentId !== undefined ? [studentId] : family;
  }
  const jobs: ScanItem[] = [];
  const docs: ScanItem[] = [];
  const folders: { studentId: string; folderId: string }[] = [];
  for (const sid of sids) {
    // `Db.query` pagine jusqu'au bout (LastEvaluatedKey): pas de liste tronquee a 1 Mo.
    const [j, d, f] = await Promise.all([ctx.db.query(`STUDENT#${sid}`, 'JOB#'), ctx.db.query(`STUDENT#${sid}`, 'DOC#'), ctx.db.query(`STUDENT#${sid}`, 'FOLDER#')]);
    jobs.push(...j.filter((x) => x.kind !== 'revision').map((x) => pick(x, JOB_FIELDS))); // M1 #90: une modification de cours n'est pas un scan
    docs.push(...d.map((x) => pick(x, DOC_FIELDS)));
    folders.push(...f.map((x) => ({ studentId: sid, folderId: x.SK.slice('FOLDER#'.length) })));
  }
  try {
    return json(200, listScans({ jobs, docs, folders, query, now: ctx.now() }));
  } catch (e) {
    if (e instanceof UnknownFolderError) return fail('introuvable', 'Introuvable');
    if (e instanceof BadCursorError) return fail('requete_invalide', 'Demande invalide');
    throw e;
  }
}
