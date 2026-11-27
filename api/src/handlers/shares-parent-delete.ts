// Handler Lambda `shares-parent-delete` (S1 #34): DELETE /students/{sid}/shares (tous, rejouable) et DELETE /students/{sid}/shares/{shareId} (un seul).
import { authOf, noContent, pathId, requireParent, wrap } from '../lib/http.js';
import { deleteForParent } from '../shares/manage.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-parent-delete', async (e) => {
  await deleteForParent(shareCtx(), requireParent(authOf(e)), pathId(e, 'sid'), e.pathParameters?.shareId === undefined ? undefined : pathId(e, 'shareId'));
  return noContent();
});
