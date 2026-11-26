// Handler Lambda `tests-read` (H1-A): GET /me/tests et GET /me/tests/{testId}. Eleve seul; identite tiree du jeton, aucun corps journalise.
import { getTest, listTests } from '../game/tests.js';
import { authOf, json, notFound, pathId, requireStudent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('tests-read', async (e) => {
  const ctx = requireStudent(authOf(e));
  if (e.routeKey === 'GET /me/tests') return json(200, await listTests(gameDeps(), ctx, e.queryStringParameters ?? {}));
  if (e.routeKey === 'GET /me/tests/{testId}') return json(200, await getTest(gameDeps(), ctx, pathId(e, 'testId')));
  throw notFound();
});
