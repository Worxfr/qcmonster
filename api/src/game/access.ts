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

/** Identifiant de connexion: `loginId` (comptes ID1), sinon l'ancien `pseudo` (identique a l'alias Cognito). */
export const loginIdOf = (it: Item): string => (typeof it.loginId === 'string' ? it.loginId : String(it.pseudo ?? ''));

/** Surnom affiche: `displayName` (comptes ID1), sinon l'ancien `pseudo` sans son suffixe aleatoire (Lila-7k2f -> Lila). Jamais l'identifiant de connexion. */
export const displayNameOf = (it: Item): string => {
  if (typeof it.displayName === 'string') return it.displayName;
  const old = String(it.pseudo ?? '');
  return /^(.+)-[a-z0-9]{4}$/i.exec(old)?.[1] ?? old;
};

export interface StudentView {
  studentId: string;
  /** Compatibilite 1.8.0: vaut `loginId` (un ancien site y lit l'identifiant de connexion). */
  pseudo: string;
  loginId: string;
  displayName: string;
  schoolLevel: 'seconde' | 'premiere' | 'terminale';
  under15: boolean;
  status: 'actif' | 'suspendu';
  pageQuota: number;
}

/** Eleve du contrat (`Student`), sans aucun attribut interne (cognitoSub, hache d'activation). */
export const studentView = (it: Item): StudentView => ({
  studentId: it.SK.slice('STUDENT#'.length),
  pseudo: loginIdOf(it),
  loginId: loginIdOf(it),
  displayName: displayNameOf(it),
  schoolLevel: it.niveau as StudentView['schoolLevel'],
  under15: it.moins15 === true,
  status: it.statut === 'suspendu' ? 'suspendu' : 'actif',
  pageQuota: Number(it.quotaPages ?? 0),
});
