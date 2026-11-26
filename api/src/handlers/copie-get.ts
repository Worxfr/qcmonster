// Handler Lambda `copie-get` (E1): GET /copies/{copieId}. Credite les points a la premiere lecture d'une copie corrigee (idempotent).
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { getCopie } from '../exo/copies.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('copie-get', async (e) => json(200, await getCopie(gameDeps(), requireStudent(authOf(e)), pathId(e, 'copieId'))));
