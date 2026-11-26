// Handler Lambda `copie-delete` (E1): DELETE /copies/{copieId}. 409 `en_correction` pendant la correction.
import { authOf, noContent, pathId, requireStudent, wrap } from '../lib/http.js';
import { s3Files } from '../exo/aws.js';
import { deleteCopie } from '../exo/copies.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('copie-delete', async (e) => {
  await deleteCopie(gameDeps(), requireStudent(authOf(e)), pathId(e, 'copieId'), s3Files());
  return noContent();
});
