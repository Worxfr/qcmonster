// Handler Lambda `admin-invitations` (A1). Autorisation par le groupe `admin` du jeton, verifiee ici (le serveur decide, pas le front).
// Le code genere n'est que dans la reponse: ni corps ni code ne sont journalises.
import { createInvitation } from '../admin/invitations.js';
import { json, notFound, requireAdmin, wrap } from '../lib/http.js';
import { inviteDeps } from './runtime.js';

/** POST /admin/invitations (administrateur). */
export const handler = wrap('admin-invitations', async (e) => {
  const admin = requireAdmin(e); // avant toute autre chose: aucun appel AWS pour un non-administrateur
  if (e.routeKey !== 'POST /admin/invitations') throw notFound();
  return json(201, await createInvitation(inviteDeps(), admin));
});
