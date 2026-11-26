// Handler Lambda `session-get` (L3). Identite tiree du jeton; aucun corps journalise. `size` (Q1): 5, 10, 15 ou 20, defaut 10.
import { getSession } from '../game/session.js';
import { json, pathId, requireStudent, authOf, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('session-get', async (e) => json(200, await getSession(gameDeps(), requireStudent(authOf(e)), pathId(e, 'docId'), e.queryStringParameters?.size)));
