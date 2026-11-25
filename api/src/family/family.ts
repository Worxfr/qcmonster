// Famille: creation paresseuse (POST /family), export et suppression complete.
import { deleteFamilyTree } from '../../../shared/delete-tree.js';
import { keys, sha256 } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { POLICY_VERSION } from '../../../shared/policy.js';
import { coursMeta } from '../cours/meta.js';
import { studentView } from '../game/access.js';
import type { Item } from '../lib/store.js';
import { badRequest, conflict, forbidden, type Auth, type ParentCtx } from '../lib/http.js';
import type { FamilyDeps } from './ports.js';
import { purgeStudent } from './students.js';

/** Identifiant de famille derive du `sub` du parent: deux appels simultanes visent le MEME element, donc un seul gagne (pas de famille orpheline). */
export const familyIdFor = (sub: string): string => `f${sha256(`qcm-family:${sub}`).slice(0, 30)}`;

/**
 * POST /family: premiere connexion d'un parent invite. Cree FAMILY#<fid>/META, pose `custom:famille_id` et le groupe `parent`.
 * Le jeton deja emis ne les contient pas: le front DOIT obtenir un nouveau jeton (rafraichissement avec le refresh token, ou reconnexion)
 * avant tout autre appel. Un eleve, ou un parent qui a deja une famille, recoit une erreur.
 */
export async function createFamily(deps: FamilyDeps, a: Auth, body: { consent: boolean; policyVersion: string }) {
  if (a.role === 'eleve' || a.conflicting) throw forbidden();
  // Consentement explicite a la politique EN VIGUEUR (la version affichee au parent doit etre la version actuelle).
  if (body.consent !== true || body.policyVersion !== POLICY_VERSION) throw badRequest('Consentement requis');
  if (a.familyId || !a.username) throw conflict('Famille déjà créée');
  const fid = familyIdFor(a.sub);
  const existing = await deps.store.get(keys.family(fid));
  if (!existing) {
    const now = deps.now().toISOString();
    const meta = { ...keys.family(fid), createdAt: now, consentementLe: now, versionPolitique: body.policyVersion, ownerSub: a.sub, plafondPages: quotaDefaults(deps.env).familyPages };
    if (!(await deps.store.commit([{ item: meta, when: 'absent' }]))) throw conflict('Famille déjà créée');
  } else if (existing.ownerSub !== a.sub) throw conflict('Famille déjà créée');
  // Reprise possible: si Cognito a echoue apres l'ecriture de META, un nouvel appel arrive ici avec la meme famille.
  if (!(await deps.identity.attachFamily(a.username, fid))) throw conflict('Famille déjà créée');
  return { userId: a.sub, role: 'parent' as const, familyId: fid };
}

/**
 * GET /family/export: toutes les donnees de la famille DU JETON (droit d'acces et portabilite): e-mail du parent, eleves (profil de jeu,
 * jours actifs, tentatives), fiches avec affirmations, sources et questions, signalements. Chaque partition lue (STUDENT#, DOC#) est
 * atteinte depuis la famille du jeton (liste des eleves, GSI1 des fiches): aucun identifiant ne vient de la requete.
 * Les cours conserves sortent sans leur texte (structure, sections, liens vers les fiches; l'eleve lit le texte par GET /cours).
 * Non exporte (dit dans la politique): le texte brut lu sur les photos (TEXT#, supprime au bout de 7 jours) et les extraits web partages.
 */
export async function exportFamily(deps: FamilyDeps, ctx: ParentCtx) {
  const fam = `FAMILY#${ctx.familyId}`;
  const meta = await deps.store.get(keys.family(ctx.familyId));
  const consent = (it: Item | undefined) =>
    it && typeof it.consentementLe === 'string' ? { consentementLe: it.consentementLe, ...(typeof it.versionPolitique === 'string' ? { versionPolitique: it.versionPolitique } : {}) } : undefined;
  const students = [];
  for (const s of await deps.store.query(fam, 'STUDENT#')) {
    const sid = s.SK.slice('STUDENT#'.length);
    const part = await deps.store.query(`STUDENT#${sid}`);
    const profile: Record<string, unknown> = { ...part.find((i) => i.SK === 'PROFILE') };
    for (const k of ['PK', 'SK', 'v']) delete profile[k];
    const c = consent(s);
    // Dossiers et cours de l'eleve (contrat 1.3). Les cours sortent SANS leur texte (`COURS#<id>#T<nn>` n'est jamais copie): le parent ne lit pas le texte.
    const partDocs = part.filter((i) => i.SK.startsWith('DOC#'));
    const existing = new Set(partDocs.map((i) => i.SK.slice('DOC#'.length)));
    const folders = part
      .filter((i) => i.SK.startsWith('FOLDER#'))
      .map((f) => ({ folderId: f.SK.slice('FOLDER#'.length), name: String(f.nom ?? ''), createdAt: String(f.createdAt ?? ''), scanCount: partDocs.filter((d) => d.dossierId === f.SK.slice('FOLDER#'.length)).length }))
      .sort((a, b) => a.name.localeCompare(b.name, 'fr'));
    const cours = part.filter((i) => /^COURS#[^#]+$/.test(i.SK)).map((h) => coursMeta(h, existing)).sort((a, b) => a.createdAt.localeCompare(b.createdAt));
    students.push({
      ...studentView(s),
      createdAt: String(s.createdAt ?? ''),
      ...(c ? { consentement: c } : {}),
      folders,
      cours,
      profile,
      activeDays: part.filter((i) => i.SK.startsWith('DAY#') && Number(i.xp ?? 0) > 0).map((i) => i.SK.slice('DAY#'.length)).sort(),
      attempts: part
        .filter((i) => i.SK.startsWith('ATT#'))
        .map((i) => {
          const [questionId, date] = i.SK.slice('ATT#'.length).split(/#(?=[^#]*$)/);
          return { questionId, date, attempts: Number(i.attempts ?? 0) };
        }),
    });
  }
  const docs = [];
  for (const d of await deps.store.query(fam, 'DOC#', true)) {
    const docId = d.SK.slice('DOC#'.length);
    const part = await deps.store.query(`DOC#${docId}`);
    const verdicts = new Map(part.filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [x.SK.slice('VERDICT#'.length), x]));
    const claims = part
      .filter((x) => x.SK.startsWith('CLAIM#'))
      .map((cl) => {
        const nn = cl.SK.slice('CLAIM#'.length);
        const v = verdicts.get(nn);
        const sources = Array.isArray(v?.sources) ? (v.sources as Record<string, unknown>[]).filter((x) => typeof x.url === 'string' && x.url.startsWith('https://')) : [];
        return { claimId: nn, text: String(cl.texte ?? ''), status: String(v?.statut ?? 'non_verifiable'), aRisque: cl.aRisque === true, sources };
      })
      .sort((a, b) => a.claimId.localeCompare(b.claimId));
    const questions = part
      .filter((x) => x.SK.startsWith('QCM#') || x.SK.startsWith('GAP#'))
      .map((q) =>
        q.SK.startsWith('QCM#')
          ? { questionId: String(q.questionId), kind: 'qcm', prompt: String(q.enonce ?? ''), choices: (q.choix as string[] | undefined) ?? [], answer: String((q.choix as string[] | undefined)?.[Number(q.cle)] ?? '') }
          : { questionId: String(q.questionId), kind: 'gap', prompt: String(q.phrase ?? ''), answer: String(q.attendu ?? '') },
      )
      .sort((a, b) => a.questionId.localeCompare(b.questionId));
    docs.push({
      docId,
      title: String(d.titre ?? ''),
      subject: String(d.matiere ?? 'autre'),
      createdAt: String(d.createdAt ?? ''),
      studentId: d.PK.slice('STUDENT#'.length),
      ...(typeof d.sujet === 'string' && d.sujet ? { topic: d.sujet.slice(0, 80) } : {}),
      ...(typeof d.dossierId === 'string' && d.dossierId ? { folderId: d.dossierId } : {}),
      ...(typeof d.coursId === 'string' && d.coursId ? { coursId: d.coursId } : {}),
      ...(typeof d.sectionIndex === 'number' ? { sectionIndex: d.sectionIndex } : {}),
      summary: typeof d.resume === 'string' ? d.resume : '',
      claims,
      questions,
    });
  }
  const reports = (await deps.store.query(fam, 'REPORT#')).map((r) => ({
    reportId: r.SK.slice('REPORT#'.length),
    docId: String(r.docId ?? ''),
    ...(typeof r.claimId === 'string' ? { claimId: r.claimId } : {}),
    ...(typeof r.studentId === 'string' ? { studentId: r.studentId } : {}),
    comment: String(r.commentaire ?? ''),
    status: String(r.statut ?? 'ouvert'),
    createdAt: String(r.createdAt ?? ''),
  }));
  const c = consent(meta);
  return { familyId: ctx.familyId, exportedAt: deps.now().toISOString(), ...(ctx.email ? { parentEmail: ctx.email } : {}), ...(c ? { consentement: c } : {}), students, docs, reports };
}

/** DELETE /family: tout, y compris les utilisateurs Cognito des eleves et du parent. Sans PITR: effectif immediatement. */
export async function deleteFamily(deps: FamilyDeps, ctx: ParentCtx): Promise<void> {
  for (const s of await deps.store.query(`FAMILY#${ctx.familyId}`, 'STUDENT#')) await purgeStudent(deps, ctx.familyId, s);
  await deleteFamilyTree(deps.tree, ctx.familyId);
  await deps.identity.deleteUser(ctx.username); // en dernier: si une etape echoue, le parent peut relancer
}
