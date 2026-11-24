// Handler Lambda `session-get` (L3). Identite tiree du jeton; aucun corps journalise.
import { getSession } from '../game/session.js';
import { json, pathId, requireStudent, authOf, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('session-get', async (e) => json(200, await getSession(gameDeps(), requireStudent(authOf(e)), pathId(e, 'docId'))));
