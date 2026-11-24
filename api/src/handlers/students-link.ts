// Handler Lambda `students-link` (L3). Identite tiree du jeton; aucun corps journalise.
import { createLink } from '../family/students.js';
import { authOf, json, pathId, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('students-link', async (e) => json(201, await createLink(familyDeps(), requireParent(authOf(e)), pathId(e, 'sid'))));
