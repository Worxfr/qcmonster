// Handler Lambda `exo-hint-post` (E1): POST /exercices/{exoId}/indice.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { nextHint } from '../exo/play.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('exo-hint-post', async (e) => json(200, await nextHint(gameDeps(), requireStudent(authOf(e)), pathId(e, 'exoId'))));
