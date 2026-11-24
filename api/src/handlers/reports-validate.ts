// Handler Lambda `reports-validate` (L3). Identite tiree du jeton; aucun corps journalise.
import { ReportValidateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { validateReport } from '../family/reports.js';
import { authOf, json, parseBody, pathId, requireParent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('reports-validate', async (e) => json(200, await validateReport(gameDeps(), requireParent(authOf(e)), pathId(e, 'id'), parseBody(e, ReportValidateRequestSchema).decision)));
