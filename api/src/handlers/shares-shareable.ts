// Handler Lambda `shares-shareable` (S1 #34): GET /docs/{docId}/shareable. Identite tiree du jeton.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { shareable } from '../shares/shareable.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-shareable', async (e) => json(200, await shareable(shareCtx(), requireStudent(authOf(e)), pathId(e, 'docId'))));
