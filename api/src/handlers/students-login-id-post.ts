// Handler Lambda `students-login-id-post` (ID1). Identite tiree du jeton; aucun corps.
import { regenerateLoginId } from '../family/students.js';
import { authOf, json, pathId, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

/** POST /students/{sid}/login-id: nouvel identifiant de connexion (parent de la famille du jeton seulement). */
export const handler = wrap('students-login-id-post', async (e) => json(200, await regenerateLoginId(familyDeps(), requireParent(authOf(e)), pathId(e, 'sid'))));
