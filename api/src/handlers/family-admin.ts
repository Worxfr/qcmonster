// Handler Lambda `family-admin` (L3). Identite tiree du jeton; aucun corps journalise.
import { deleteFamily, exportFamily } from '../family/family.js';
import { authOf, json, noContent, notFound, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

/** GET /family/export et DELETE /family (parent). */
export const handler = wrap('family-admin', async (e) => {
  const ctx = requireParent(authOf(e));
  if (e.routeKey === 'GET /family/export') return json(200, await exportFamily(familyDeps(), ctx));
  if (e.routeKey === 'DELETE /family') {
    await deleteFamily(familyDeps(), ctx);
    return noContent();
  }
  throw notFound();
});
