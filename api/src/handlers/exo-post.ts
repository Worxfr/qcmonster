// Handler Lambda `exo-post` (E1): POST /docs/{docId}/exercices. Eleve seul; identite tiree du jeton. Cree la progression puis lance `exo-gen` en asynchrone.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { lambdaInvoker } from '../exo/aws.js';
import { createExo } from '../exo/play.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('exo-post', async (e) => json(202, await createExo(gameDeps(), requireStudent(authOf(e)), pathId(e, 'docId'), lambdaInvoker())));
