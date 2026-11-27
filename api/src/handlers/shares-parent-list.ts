// Handler Lambda `shares-parent-list` (S1 #34): GET /students/{sid}/shares. Jamais de question ni de lien.
import { authOf, json, pathId, requireParent, wrap } from '../lib/http.js';
import { listForParent } from '../shares/manage.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-parent-list', async (e) => json(200, await listForParent(shareCtx(), requireParent(authOf(e)), pathId(e, 'sid'))));
