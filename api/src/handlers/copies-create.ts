// Handler Lambda `copies-create` (E1): POST /exercices/{exoId}/copies. Renvoie des envois pre-signes (cle exacte, type et taille fixes).
import { CopieCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { authOf, json, parseBody, pathId, requireStudent, wrap } from '../lib/http.js';
import { s3Files } from '../exo/aws.js';
import { createCopie } from '../exo/copies.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('copies-create', async (e) => json(201, await createCopie(gameDeps(), requireStudent(authOf(e)), pathId(e, 'exoId'), parseBody(e, CopieCreateRequestSchema), s3Files())));
