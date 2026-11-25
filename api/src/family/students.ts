// Comptes eleves cote parent: creation, nouveau lien, suspension/quota, suppression. Toute operation part de la famille du JETON:
// un parent ne peut ni lire, ni modifier, ni supprimer l'eleve d'une autre famille (la cle STUDENT#<sid> est sous FAMILY#<fid du jeton>).
import { deleteStudentTree } from '../../../shared/delete-tree.js';
import { keys } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { setLimit } from '../../../shared/quota.js';
import { studentView } from '../game/access.js';
import { MAX_STUDENTS_PER_FAMILY } from '../game/rules.js';
import { parisMonth } from '../game/time.js';
import { badRequest, conflict, forbidden, notFound, type ParentCtx } from '../lib/http.js';
import { AliasTakenError } from '../lib/identity.js';
import type { Item } from '../lib/store.js';
import { issueActivation } from './activation.js';
import type { FamilyDeps } from './ports.js';

const studentOf = async (deps: FamilyDeps, fid: string, sid: string): Promise<Item> => {
  const s = await deps.store.get(keys.student(fid, sid));
  if (!s) throw notFound();
  return s;
};

export async function createStudent(deps: FamilyDeps, ctx: ParentCtx, body: { pseudo: string; schoolLevel: string; under15: boolean }) {
  const meta = await deps.store.get(keys.family(ctx.familyId));
  if (!meta) throw forbidden();
  const existing = await deps.store.query(`FAMILY#${ctx.familyId}`, 'STUDENT#');
  if (existing.length >= MAX_STUDENTS_PER_FAMILY) throw forbidden('Nombre maximal d\'eleves atteint');

  const studentId = deps.newId();
  const base = body.pseudo.trim().replace(/\s+/g, '-');
  let pseudo = '';
  let sub = '';
  for (let i = 0; ; i++) {
    pseudo = `${base}-${deps.suffix()}`; // suffixe aleatoire: le pseudo n'est pas devinable et reste unique
    try {
      ({ sub } = await deps.identity.createStudent({ studentId, familyId: ctx.familyId, alias: pseudo }));
      break;
    } catch (e) {
      if (!(e instanceof AliasTakenError) || i >= 2) throw e;
    }
  }

  const link = issueActivation(deps, deps.webOrigin, ctx.familyId, studentId);
  const student: Item = {
    ...keys.student(ctx.familyId, studentId),
    pseudo,
    niveau: body.schoolLevel,
    moins15: body.under15,
    statut: 'actif',
    cognitoSub: sub,
    quotaPages: quotaDefaults(deps.env).studentPages,
    activationHash: link.hash,
    createdAt: deps.now().toISOString(),
  };
  try {
    if (!(await deps.store.commit([{ item: student, when: 'absent' }, link.write]))) throw conflict();
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

export async function updateStudent(deps: FamilyDeps, ctx: ParentCtx, sid: string, body: { status?: 'actif' | 'suspendu'; pageQuota?: number }) {
  if (body.status === undefined && body.pageQuota === undefined) throw badRequest();
  const s = await studentOf(deps, ctx.familyId, sid);
  const meta = await deps.store.get(keys.family(ctx.familyId));
  const familyLimit = Number(meta?.plafondPages ?? quotaDefaults(deps.env).familyPages);
  // Le quota d'un eleve ne depasse pas le plafond de la famille (design 4.7).
  if (body.pageQuota !== undefined && body.pageQuota > familyLimit) throw badRequest('Quota superieur au plafond de la famille');
  const next: Item = { ...s };
  if (body.status !== undefined) next.statut = body.status;
  if (body.pageQuota !== undefined) next.quotaPages = body.pageQuota;
  // Base d'abord: un eleve suspendu est refuse par l'API immediatement, meme si Cognito echoue ensuite.
  if (!(await deps.store.commit([{ item: next, when: s.v ?? 'any' }]))) throw conflict('Reessayez');
  // A chaque requete portant `status` (idempotent): si Cognito a echoue, relancer la meme requete repare.
  if (body.status !== undefined) await deps.identity.setEnabled(sid, body.status === 'actif');
  if (body.pageQuota !== undefined) {
    await setLimit(deps.quota, { familyId: ctx.familyId, studentId: sid, month: parisMonth(deps.now()), studentLimit: body.pageQuota, familyLimit }, body.pageQuota);
  }
  return studentView(next);
}

/** Efface les donnees d'un eleve hors table (utilisateur Cognito, photos en cours, lien d'activation), puis son arbre DynamoDB. */
export async function purgeStudent(deps: FamilyDeps, fid: string, s: Item): Promise<void> {
  const sid = s.SK.slice('STUDENT#'.length);
  await deps.identity.deleteUser(sid);
  const jobs = await deps.store.query(`STUDENT#${sid}`, 'JOB#');
  await deps.photos.deleteForJobs(jobs.map((j) => j.SK.slice('JOB#'.length)));
  if (typeof s.activationHash === 'string') await deps.store.remove({ PK: `ACTIVATION#${s.activationHash}`, SK: 'META' });
  await deleteStudentTree(deps.tree, fid, sid);
}

export async function deleteStudent(deps: FamilyDeps, ctx: ParentCtx, sid: string): Promise<void> {
  await purgeStudent(deps, ctx.familyId, await studentOf(deps, ctx.familyId, sid));
}
