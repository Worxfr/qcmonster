// Handler Lambda `exo-list` (E1): GET /docs/{docId}/exercices.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { listExo } from '../exo/play.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('exo-list', async (e) => json(200, await listExo(gameDeps(), requireStudent(authOf(e)), pathId(e, 'docId'))));
