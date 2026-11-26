// Handler Lambda `family-create` (L3). Identite tiree du jeton; aucun corps journalise.
// Sert aussi POST /family/policy (contract-v1.4.1): re-acceptation de la politique par un parent qui a deja une famille.
import { acceptPolicy, createFamily } from '../family/family.js';
import { FamilyCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { authOf, forbidden, json, noContent, parseBody, requireParent, wrap } from '../lib/http.js';
import { familyDeps } from './runtime.js';

export const handler = wrap('family-create', async (e) => {
  const a = authOf(e);
  if (a.role === 'eleve') throw forbidden(); // refus avant de lire le corps
  if (e.routeKey === 'POST /family/policy') {
    await acceptPolicy(familyDeps(), requireParent(a), parseBody(e, FamilyCreateRequestSchema));
    return noContent();
  }
  return json(201, await createFamily(familyDeps(), a, parseBody(e, FamilyCreateRequestSchema)));
});
