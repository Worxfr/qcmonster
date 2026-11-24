// Handler Lambda `me-get` (L3). Identite tiree du jeton; aucun corps journalise.
import { getMe, getProgress } from '../game/family-read.js';
import { authOf, json, notFound, requireStudent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

/** GET /me et GET /me/progress. */
export const handler = wrap('me-get', async (e) => {
  const a = authOf(e);
  if (e.routeKey === 'GET /me') return json(200, await getMe(gameDeps(), a));
  if (e.routeKey === 'GET /me/progress') return json(200, await getProgress(gameDeps(), requireStudent(a)));
  throw notFound();
});
