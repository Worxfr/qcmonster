// GET /cours/{coursId}/revisions/{revisionId} (handler `revise-get`, M1 #90): l'etat d'une modification. Eleve seulement; jamais de texte du cours,
// jamais la copie de travail (`JOB#<revisionId>`: le role de lecture n'a pas cette partition).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { jobKey, type Ctx } from '../pipeline/ctx.js';
import { callerOf, fail, json, pathId, requireStudent } from '../pipeline/http.js';
import { isRevision } from './lock.js';
import { revisionView } from './store.js';

export async function reviseGet(ctx: Ctx, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const sid = requireStudent(await callerOf(ctx, event));
  const coursId = pathId(event, 'coursId');
  const job = await ctx.db.get(jobKey(sid, pathId(event, 'revisionId')));
  // Cle de l'appelant: un identifiant d'un autre eleve, d'un autre cours ou d'un scan repond comme un identifiant inconnu.
  if (!isRevision(job) || job.coursId !== coursId) return fail('introuvable', 'Introuvable');
  return json(200, revisionView(job));
}
