// Handler Lambda `family-export-archive` (H1-B): POST /family/export/archive. Parent seul; la famille vient du jeton, aucun parametre ni corps lu.
import { createExportArchive } from '../family/archive.js';
import { authOf, json, notFound, requireParent, wrap } from '../lib/http.js';
import { archiveDeps } from './runtime.js';

export const handler = wrap('family-export-archive', async (e) => {
  const ctx = requireParent(authOf(e));
  if (e.routeKey !== 'POST /family/export/archive') throw notFound();
  return json(200, await createExportArchive(archiveDeps(), ctx));
});
