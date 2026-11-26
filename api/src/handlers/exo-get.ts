// Handler Lambda `exo-get` (E1): GET /exercices/{exoId}. Enonce seul; jamais le bareme, les attendus ni la solution.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { getExo } from '../exo/play.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('exo-get', async (e) => json(200, await getExo(gameDeps(), requireStudent(authOf(e)), pathId(e, 'exoId'))));
