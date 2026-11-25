// Handler Lambda `family-create` (L3). Identite tiree du jeton; aucun corps journalise.
import { createFamily } from '../family/family.js';
import { FamilyCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { authOf, forbidden, json, parseBody, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('family-create', async (e) => {
  const a = authOf(e);
  if (a.role === 'eleve') throw forbidden(); // refus avant de lire le corps
  return json(201, await createFamily(familyDeps(), a, parseBody(e, FamilyCreateRequestSchema)));
});
