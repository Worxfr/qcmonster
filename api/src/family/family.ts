// Famille: creation paresseuse (POST /family), export et suppression complete.
import { deleteFamilyTree } from '../../../shared/delete-tree.js';
import { keys, sha256 } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { studentView } from '../game/access.js';
import { conflict, forbidden, type Auth, type ParentCtx } from '../lib/http.js';
import type { FamilyDeps } from './ports.js';
import { purgeStudent } from './students.js';

/** Identifiant de famille derive du `sub` du parent: deux appels simultanes visent le MEME element, donc un seul gagne (pas de famille orpheline). */
export const familyIdFor = (sub: string): string => `f${sha256(`qcm-family:${sub}`).slice(0, 30)}`;

/**
 * POST /family: premiere connexion d'un parent invite. Cree FAMILY#<fid>/META, pose `custom:famille_id` et le groupe `parent`.
 * Le jeton deja emis ne les contient pas: le front DOIT obtenir un nouveau jeton (rafraichissement avec le refresh token, ou reconnexion)
 * avant tout autre appel. Un eleve, ou un parent qui a deja une famille, recoit une erreur.
 */
export async function createFamily(deps: FamilyDeps, a: Auth) {
  if (a.role === 'eleve') throw forbidden();
  if (a.familyId || !a.username) throw conflict('Famille deja creee');
  const fid = familyIdFor(a.sub);
  const existing = await deps.store.get(keys.family(fid));
  if (!existing) {
    const meta = { ...keys.family(fid), createdAt: deps.now().toISOString(), ownerSub: a.sub, plafondPages: quotaDefaults(deps.env).familyPages };
    if (!(await deps.store.commit([{ item: meta, when: 'absent' }]))) throw conflict('Famille deja creee');
  } else if (existing.ownerSub !== a.sub) throw conflict('Famille deja creee');
  // Reprise possible: si Cognito a echoue apres l'ecriture de META, un nouvel appel arrive ici avec la meme famille.
  if (!(await deps.identity.attachFamily(a.username, fid))) throw conflict('Famille deja creee');
  return { userId: a.sub, role: 'parent' as const, familyId: fid };
}

/** GET /family/export: eleves et fiches (titres) de la famille. Le texte des cours n'est pas exporte ici (contrat). */
export async function exportFamily(deps: FamilyDeps, ctx: ParentCtx) {
  const students = (await deps.store.query(`FAMILY#${ctx.familyId}`, 'STUDENT#')).map(studentView);
  const docs = (await deps.store.query(`FAMILY#${ctx.familyId}`, 'DOC#', true)).map((d) => ({
    docId: d.SK.slice('DOC#'.length),
    title: String(d.titre ?? ''),
    subject: String(d.matiere ?? 'autre'),
    createdAt: String(d.createdAt ?? ''),
  }));
  return { familyId: ctx.familyId, exportedAt: deps.now().toISOString(), students, docs };
}

/** DELETE /family: tout, y compris les utilisateurs Cognito des eleves et du parent. Sans PITR: effectif immediatement. */
export async function deleteFamily(deps: FamilyDeps, ctx: ParentCtx): Promise<void> {
  for (const s of await deps.store.query(`FAMILY#${ctx.familyId}`, 'STUDENT#')) await purgeStudent(deps, ctx.familyId, s);
  await deleteFamilyTree(deps.tree, ctx.familyId);
  await deps.identity.deleteUser(ctx.username); // en dernier: si une etape echoue, le parent peut relancer
}
