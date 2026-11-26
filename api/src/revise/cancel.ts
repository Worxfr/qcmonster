// POST /cours/{coursId}/revisions/{revisionId}/cancel (handler `revise-cancel`, M1 #90, docs/M1-design.md 3.5): annule AVANT le debut de la validation.
// Ne fait que marquer le job annule et liberer le verrou (UpdateItem, verrou en dernier). La machine voit l'annulation a sa tache suivante et lance `rev-fail`,
// qui supprime la copie de travail et regle le cout. Machine deja arretee: la copie reste jusqu'a son ttl de 7 jours (inerte, invisible).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { releaseLock } from '../pipeline/append.js';
import { iso, jobKey, type Ctx } from '../pipeline/ctx.js';
import { callerOf, fail, noContent, pathId, requireStudent } from '../pipeline/http.js';
import { isRevision, MSG_REVISION } from './lock.js';
import { revisionIdOf } from './store.js';

export async function reviseCancel(ctx: Ctx, event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> {
  const sid = requireStudent(await callerOf(ctx, event));
  const coursId = pathId(event, 'coursId');
  const revisionId = pathId(event, 'revisionId');
  const job = await ctx.db.get(jobKey(sid, revisionId));
  if (!isRevision(job) || job.coursId !== coursId) return fail('introuvable', 'Introuvable');
  // Le premier qui change l'etat gagne la course contre `rev-commit` (qui pose `commitStartedAt` sous la condition etat `verification`).
  const won = await ctx.db.update(jobKey(sid, revisionIdOf(job)), { set: { state: 'rejete', finishedAt: iso(ctx), message: MSG_REVISION.cancelled }, cond: { exists: true, eq: { state: 'verification' }, absent: ['commitStartedAt'] } });
  if (!won) return fail('etat_invalide', MSG_REVISION.cannotCancel);
  await releaseLock(ctx, sid, coursId, revisionId);
  return noContent();
}
