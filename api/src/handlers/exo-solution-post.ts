// Handler Lambda `exo-solution-post` (E1): POST /exercices/{exoId}/solution. Ferme les points de l'exercice.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { showSolution } from '../exo/play.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('exo-solution-post', async (e) => json(200, await showSolution(gameDeps(), requireStudent(authOf(e)), pathId(e, 'exoId'))));
