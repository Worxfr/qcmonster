import type { TreeDb } from '../../../shared/delete-tree.js';
import type { Deps } from '../lib/deps.js';
import type { Identity } from '../lib/identity.js';
import type { Photos } from '../lib/photos.js';

/** Tout ce dont les operations de famille ont besoin. `webOrigin`: origine du front, base du lien d'activation. */
export interface FamilyDeps extends Deps {
  identity: Identity;
  photos: Photos;
  tree: TreeDb;
  webOrigin: string;
}
