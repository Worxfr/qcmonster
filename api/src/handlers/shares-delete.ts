// Handler Lambda `shares-delete` (S1 #34): DELETE /me/shares/{shareId}.
import { authOf, noContent, pathId, requireStudent, wrap } from '../lib/http.js';
import { deleteMine } from '../shares/manage.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-delete', async (e) => {
  await deleteMine(shareCtx(), requireStudent(authOf(e)), pathId(e, 'shareId'));
  return noContent();
});
