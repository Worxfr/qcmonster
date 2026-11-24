// Handler Lambda `family-create` (L3). Identite tiree du jeton; aucun corps journalise.
import { createFamily } from '../family/family.js';
import { authOf, json, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('family-create', async (e) => json(201, await createFamily(familyDeps(), authOf(e))));
