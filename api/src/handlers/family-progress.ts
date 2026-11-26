// Handler Lambda `family-progress` (H1-B): vue parent en lecture seule. Le parent et sa famille viennent du jeton; `sid` du chemin est verifie en base.
import { getStudentProgress, getStudentTest, listStudentTests } from '../game/family-progress.js';
import { authOf, json, notFound, pathId, requireParent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('family-progress', async (e) => {
  const ctx = requireParent(authOf(e));
  const sid = pathId(e, 'sid');
  if (e.routeKey === 'GET /students/{sid}/progress') return json(200, await getStudentProgress(gameDeps(), ctx, sid));
  if (e.routeKey === 'GET /students/{sid}/tests') return json(200, await listStudentTests(gameDeps(), ctx, sid, e.queryStringParameters ?? {}));
  if (e.routeKey === 'GET /students/{sid}/tests/{testId}') return json(200, await getStudentTest(gameDeps(), ctx, sid, pathId(e, 'testId')));
  throw notFound();
});
