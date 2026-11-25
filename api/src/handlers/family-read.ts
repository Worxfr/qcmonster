// Handler Lambda `family-read` (L3). Identite tiree du jeton; aucun corps journalise.
import { getDashboard, getLeaderboard } from '../game/family-read.js';
import { authOf, forbidden, json, notFound, requireParent, requireStudent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

/** GET /family/dashboard (parent) et GET /family/leaderboard (parent ou eleve de la famille). */
export const handler = wrap('family-read', async (e) => {
  const a = authOf(e);
  if (e.routeKey === 'GET /family/dashboard') return json(200, await getDashboard(gameDeps(), requireParent(a)));
  if (e.routeKey === 'GET /family/leaderboard') {
    if (!a.role || !a.familyId) throw forbidden();
    return json(200, await getLeaderboard(gameDeps(), a.familyId, a.role === 'eleve' ? requireStudent(a) : undefined));
  }
  throw notFound();
});
