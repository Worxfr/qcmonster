// Handler Lambda `copies-submit` (E1): POST /copies/{copieId}/submit. Aucun corps: le serveur calcule lui-meme les empreintes des pages.
import { authOf, json, pathId, requireStudent, wrap } from '../lib/http.js';
import { s3Files, sfnStarter } from '../exo/aws.js';
import { submitCopie } from '../exo/copies.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('copies-submit', async (e) => json(202, await submitCopie(gameDeps(), requireStudent(authOf(e)), pathId(e, 'copieId'), sfnStarter(), s3Files())));
