// Controles d'acces communs: l'identite vient du jeton, la ressource vient de la base, et les deux doivent concorder.
import { keys } from '../../../shared/ddb/keys.js';
import type { Deps } from '../lib/deps.js';
import { forbidden, type StudentCtx } from '../lib/http.js';
import type { Item } from '../lib/store.js';

/** Eleve actif de la famille du jeton, dont le `sub` est celui enregistre a la creation. Sinon 403 (suspendu, supprime, jeton d'un autre compte). */
export async function activeStudent(deps: Deps, ctx: StudentCtx): Promise<Item> {
  const s = await deps.store.get(keys.student(ctx.familyId, ctx.studentId));
  if (!s || s.statut !== 'actif' || s.cognitoSub !== ctx.sub) throw forbidden();
  return s;
}

export interface StudentView {
  studentId: string;
  pseudo: string;
  schoolLevel: 'seconde' | 'premiere' | 'terminale';
  under15: boolean;
  status: 'actif' | 'suspendu';
  pageQuota: number;
}

/** Eleve du contrat (`Student`), sans aucun attribut interne (cognitoSub, hache d'activation). */
export const studentView = (it: Item): StudentView => ({
  studentId: it.SK.slice('STUDENT#'.length),
  pseudo: String(it.pseudo),
  schoolLevel: it.niveau as StudentView['schoolLevel'],
  under15: it.moins15 === true,
  status: it.statut === 'suspendu' ? 'suspendu' : 'actif',
  pageQuota: Number(it.quotaPages ?? 0),
});
