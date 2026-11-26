// Comptes eleves cote parent: creation, nouveau lien, suspension/quota, suppression. Toute operation part de la famille du JETON:
// un parent ne peut ni lire, ni modifier, ni supprimer l'eleve d'une autre famille (la cle STUDENT#<sid> est sous FAMILY#<fid du jeton>).
import { deleteStudentTree } from '../../../shared/delete-tree.js';
import { keys } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { POLICY_VERSION } from '../../../shared/policy.js';
import { setLimit } from '../../../shared/quota.js';
import { checkNickname, nameKey } from '../../../shared/pseudo-rules.js';
import { displayNameOf, loginIdOf, studentView } from '../game/access.js';
import { MAX_STUDENTS_PER_FAMILY } from '../game/rules.js';
import { parisMonth } from '../game/time.js';
import { badRequest, conflict, forbidden, notFound, pseudoPris, pseudoRefuse, type ParentCtx } from '../lib/http.js';
import { AliasTakenError, UserGoneError } from '../lib/identity.js';
import type { Item, Write } from '../lib/store.js';
import { issueActivation } from './activation.js';
import { nameSwap, nameTakenByOther, reservedByOther } from './names.js';
import type { FamilyDeps } from './ports.js';

/** Base de l'identifiant de connexion: le surnom de depart en minuscules ASCII, espaces et apostrophes en tirets (lila, marie-rose). */
const loginBaseOf = (display: string): string => {
  const b = display.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(/[\s'’]+/g, '-').replace(/[^a-z0-9-]/g, '').replace(/^-+|-+$/g, '');
  return b || 'eleve';
};

const studentOf = async (deps: FamilyDeps, fid: string, sid: string): Promise<Item> => {
  const s = await deps.store.get(keys.student(fid, sid));
  if (!s) throw notFound();
  return s;
};

export async function createStudent(deps: FamilyDeps, ctx: ParentCtx, body: { pseudo: string; schoolLevel: string; under15: boolean; parentalAuthority: boolean; policyVersion: string }) {
  // Consentement explicite (case cochee) a la politique en vigueur: sans lui, rien n'est cree ni dans la base ni dans Cognito.
  if (body.parentalAuthority !== true || body.policyVersion !== POLICY_VERSION) throw badRequest('Consentement requis');
  const meta = await deps.store.get(keys.family(ctx.familyId));
  if (!meta) throw forbidden();
  const existing = await deps.store.query(`FAMILY#${ctx.familyId}`, 'STUDENT#');
  if (existing.length >= MAX_STUDENTS_PER_FAMILY) throw forbidden('Nombre maximal d\'élèves atteint');

  // Surnom de depart: memes regles que le surnom choisi par l'eleve (liste de mots, chiffres, adresses), en plus de la forme du contrat.
  const nick = checkNickname(body.pseudo, { parentEmail: ctx.email });
  if (!nick.ok) throw pseudoRefuse();
  const displayName = nick.value;
  if (await nameTakenByOther(deps, ctx.familyId, '', displayName)) throw pseudoPris();

  const studentId = deps.newId();
  const base = loginBaseOf(displayName);
  let loginId = '';
  let sub = '';
  for (let i = 0; ; i++) {
    loginId = `${base}-${deps.suffix()}`; // suffixe aleatoire (5 caracteres sans ambiguite): l'identifiant n'est pas devinable et reste unique
    try {
      ({ sub } = await deps.identity.createStudent({ studentId, familyId: ctx.familyId, alias: loginId }));
      break;
    } catch (e) {
      if (!(e instanceof AliasTakenError) || i >= 2) throw e;
    }
  }

  const link = issueActivation(deps, deps.webOrigin, ctx.familyId, studentId);
  const student: Item = {
    ...keys.student(ctx.familyId, studentId),
    loginId,
    displayName,
    niveau: body.schoolLevel,
    moins15: body.under15,
    consentementLe: deps.now().toISOString(),
    versionPolitique: body.policyVersion,
    statut: 'actif',
    cognitoSub: sub,
    quotaPages: quotaDefaults(deps.env).studentPages,
    activationHash: link.hash,
    createdAt: deps.now().toISOString(),
  };
  try {
    // Le surnom est reserve dans la meme ecriture que l'eleve: deux creations en course sur le meme surnom, une seule gagne.
    const reserve: Write = { item: { ...keys.name(ctx.familyId, nameKey(displayName)), studentId, creeLe: deps.now().toISOString() }, when: 'absent' };
    if (!(await deps.store.commit([{ item: student, when: 'absent' }, link.write, reserve]))) {
      throw (await reservedByOther(deps, ctx.familyId, studentId, displayName)) ? pseudoPris() : conflict();
    }
  } catch (e) {
    await deps.identity.deleteUser(studentId); // pas d'utilisateur Cognito sans eleve en base
    throw e;
  }
  return { student: studentView(student), activationLink: { url: link.url, expiresAt: link.expiresAt } };
}

/** Nouveau lien (mot de passe perdu). L'ancien jeton cesse de fonctionner. */
export async function createLink(deps: FamilyDeps, ctx: ParentCtx, sid: string) {
  const s = await studentOf(deps, ctx.familyId, sid);
  const link = issueActivation(deps, deps.webOrigin, ctx.familyId, sid);
  if (!(await deps.store.commit([{ item: { ...s, activationHash: link.hash }, when: s.v ?? 'any' }, link.write]))) throw conflict();
  if (typeof s.activationHash === 'string') await deps.store.remove({ PK: `ACTIVATION#${s.activationHash}`, SK: 'META' });
  return { url: link.url, expiresAt: link.expiresAt };
}

export async function updateStudent(deps: FamilyDeps, ctx: ParentCtx, sid: string, body: { status?: 'actif' | 'suspendu'; pageQuota?: number; schoolLevel?: string; displayName?: string }) {
  if (body.status === undefined && body.pageQuota === undefined && body.schoolLevel === undefined && body.displayName === undefined) throw badRequest();
  const s = await studentOf(deps, ctx.familyId, sid);
  const meta = await deps.store.get(keys.family(ctx.familyId));
  const familyLimit = Number(meta?.plafondPages ?? quotaDefaults(deps.env).familyPages);
  // Le quota d'un eleve ne depasse pas le plafond de la famille (design 4.7).
  if (body.pageQuota !== undefined && body.pageQuota > familyLimit) throw badRequest('Quota supérieur au plafond de la famille');
  const next: Item = { ...s };
  if (body.status !== undefined) next.statut = body.status;
  if (body.pageQuota !== undefined) next.quotaPages = body.pageQuota;
  if (body.schoolLevel !== undefined) next.niveau = body.schoolLevel; // rectification (droit de correction); `under15` se refait en recreant l'eleve
  const writes: Write[] = [{ item: next, when: s.v ?? 'any' }];
  let renamed: string | undefined;
  if (body.displayName !== undefined) {
    // Le parent renomme: memes regles que l'eleve, et refus si un frere ou une soeur porte deja ce nom (reservation dans la meme ecriture).
    const nick = checkNickname(body.displayName, { parentEmail: ctx.email });
    if (!nick.ok) throw pseudoRefuse();
    if (await nameTakenByOther(deps, ctx.familyId, sid, nick.value)) throw pseudoPris();
    renamed = nick.value;
    next.displayName = nick.value;
    writes.push(...(await nameSwap(deps, ctx.familyId, sid, displayNameOf(s), nick.value)));
  }
  // Base d'abord: un eleve suspendu est refuse par l'API immediatement, meme si Cognito echoue ensuite.
  if (!(await deps.store.commit(writes))) throw renamed !== undefined && (await reservedByOther(deps, ctx.familyId, sid, renamed)) ? pseudoPris() : conflict('Réessaie');
  // A chaque requete portant `status` (idempotent): si Cognito a echoue, relancer la meme requete repare.
  if (body.status !== undefined) await deps.identity.setEnabled(sid, body.status === 'actif');
  if (body.pageQuota !== undefined) {
    await setLimit(deps.quota, { familyId: ctx.familyId, studentId: sid, month: parisMonth(deps.now()), studentLimit: body.pageQuota, familyLimit }, body.pageQuota);
  }
  return studentView(next);
}

/** Efface les donnees d'un eleve hors table (utilisateur Cognito, photos restantes, lien d'activation), puis son arbre DynamoDB. */
export async function purgeStudent(deps: FamilyDeps, fid: string, s: Item): Promise<void> {
  const sid = s.SK.slice('STUDENT#'.length);
  await deps.identity.deleteUser(sid);
  await deps.photos.deleteForStudent(sid); // toutes les photos scans/<eleve>/..., meme sans fiche JOB# restante
  await deps.archives.deleteFamily(sid); // archives de l'eleve `exports/<eleve>/` (R1 3.6; le prefixe est celui de l'identifiant, comme pour une famille)
  await deps.photos.deleteFiguresForStudent(sid); // figures/<eleve>/ AVANT l'arbre DynamoDB (R1 3.2): une suppression interrompue se reprend
  if (typeof s.activationHash === 'string') await deps.store.remove({ PK: `ACTIVATION#${s.activationHash}`, SK: 'META' });
  await deleteStudentTree(deps.tree, fid, sid);
}

export async function deleteStudent(deps: FamilyDeps, ctx: ParentCtx, sid: string): Promise<void> {
  await purgeStudent(deps, ctx.familyId, await studentOf(deps, ctx.familyId, sid));
  // Les archives d'export deja faites contiennent les passages et le profil de l'eleve: elles partent avec lui (celles de la famille entiere).
  await deps.archives.deleteFamily(ctx.familyId);
}

/**
 * Nouvel identifiant de connexion (parent seulement, mot de passe inchange). Cognito d'abord, base ensuite; rejouable: si Cognito porte deja un alias
 * different de la base (appel interrompu), c'est lui qu'on ecrit en base au lieu d'en generer un troisieme. La deconnexion globale a lieu a CHAQUE appel.
 */
export async function regenerateLoginId(deps: FamilyDeps, ctx: ParentCtx, sid: string): Promise<{ loginId: string }> {
  const s = await studentOf(deps, ctx.familyId, sid);
  const inBase = loginIdOf(s);
  let current: string | undefined;
  try {
    current = await deps.identity.getAlias(sid);
  } catch (e) {
    if (e instanceof UserGoneError) throw notFound();
    throw e;
  }
  let next: string;
  if (current && current !== inBase) next = current;
  else {
    const base = /^(.+)-[a-z0-9]{4,5}$/i.exec(inBase)?.[1]?.toLowerCase() ?? 'eleve';
    for (let i = 0; ; i++) {
      next = `${base}-${deps.suffix()}`;
      try {
        await deps.identity.updateAlias(sid, next);
        break;
      } catch (e) {
        if (e instanceof UserGoneError) throw notFound();
        if (!(e instanceof AliasTakenError) || i >= 2) throw e;
      }
    }
  }
  // Le champ `pseudo` brut d'un ancien compte n'est jamais reecrit: il garde l'ancien alias, sans effet (loginIdOf lit `loginId` d'abord).
  if (next !== inBase && !(await deps.store.commit([{ item: { ...s, loginId: next }, when: s.v ?? 'any' }]))) throw conflict('Réessaie');
  await deps.identity.signOut(sid);
  return { loginId: next };
}
