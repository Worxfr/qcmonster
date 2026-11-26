// Handler Lambda `me-export` (R1): POST /me/export/archive (202, lance la construction) et GET /me/export/archive/{exportId}. Eleve seul (le parent a 403).
import { getExport, requestExport } from '../family/student-export.js';
import { authOf, json, notFound, pathId, requireStudent, wrap } from '../lib/http.js';
import { studentExportDeps } from './runtime.js';

export const handler = wrap('me-export', async (e) => {
  const ctx = requireStudent(authOf(e));
  if (e.routeKey === 'POST /me/export/archive') return json(202, await requestExport(studentExportDeps(), ctx));
  if (e.routeKey === 'GET /me/export/archive/{exportId}') return json(200, await getExport(studentExportDeps(), ctx, pathId(e, 'exportId')));
  throw notFound();
});
