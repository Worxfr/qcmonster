// Handler Lambda `docs-mark-read` (L3). Identite tiree du jeton; aucun corps journalise.
import { markRead } from '../game/read.js';
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('docs-mark-read', async (e) => json(200, await markRead(gameDeps(), requireStudent(authOf(e)), pathId(e, 'docId'))));
