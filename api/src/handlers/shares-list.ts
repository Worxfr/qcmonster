// Handler Lambda `shares-list` (S1 #34): GET /me/shares.
import { authOf, json, requireStudent, wrap } from '../lib/http.js';
import { listMine } from '../shares/manage.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-list', async (e) => json(200, await listMine(shareCtx(), requireStudent(authOf(e)))));
