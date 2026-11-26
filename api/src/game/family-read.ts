// Lectures: GET /me, GET /me/progress, GET /family/dashboard, GET /family/leaderboard. Une famille ne lit jamais une autre:
// la cle de partition vient de `famille_id` du jeton, jamais d'un parametre.
import { keys } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { POLICY_VERSION } from '../../../shared/policy.js';
import type { Deps } from '../lib/deps.js';
import { forbidden, notFound, type Auth, type ParentCtx, type StudentCtx } from '../lib/http.js';
import { activeStudent, displayNameOf, loginIdOf, studentView, type StudentView } from './access.js';
import { LEADERBOARD_MIN_ACTIVE_DAYS } from './rules.js';
import { progressOf, readProfile, type Progress } from './state.js';
import { isoWeek, parisDate } from './time.js';

export interface MeView {
  userId: string;
  role: 'parent' | 'eleve';
  familyId: string;
  studentId?: string;
  /** Eleve seulement. Compatibilite 1.8.0: vaut `loginId`. */
  pseudo?: string;
  loginId?: string;
  displayName?: string;
  /** Parent seulement, present (vrai) quand le consentement de la famille porte sur une autre version de la politique que celle en vigueur. */
  policyOutdated?: true;
}

/** GET /me. Un parent sans famille (jeton emis avant POST /family) recoit 404: le front appelle alors POST /family puis rafraichit le jeton. */
export async function getMe(deps: Deps, a: Auth): Promise<MeView> {
  // Sans role ni famille (admin seul, parent invite avant POST /family): profil absent, le front propose de creer la famille.
  if (!a.role) throw a.conflicting || a.familyId ? forbidden() : notFound();
  if (!a.familyId) throw notFound();
  if (a.role === 'parent') {
    const meta = await deps.store.get(keys.family(a.familyId));
    // Une famille creee avant l'enregistrement de la version (aucune `versionPolitique`) doit aussi relire le texte.
    const outdated = meta !== undefined && meta.versionPolitique !== POLICY_VERSION;
    return { userId: a.sub, role: 'parent', familyId: a.familyId, ...(outdated ? { policyOutdated: true as const } : {}) };
  }
  const ctx: StudentCtx = { sub: a.sub, studentId: a.username, familyId: a.familyId };
  const s = await activeStudent(deps, ctx);
  return { userId: a.sub, role: 'eleve', familyId: a.familyId, studentId: ctx.studentId, pseudo: loginIdOf(s), loginId: loginIdOf(s), displayName: displayNameOf(s) };
}

export async function getProgress(deps: Deps, ctx: StudentCtx): Promise<Progress> {
  const s = await activeStudent(deps, ctx);
  return progressOf(deps, ctx.familyId, ctx.studentId, await readProfile(deps, ctx.studentId), Number(s.quotaPages), parisDate(deps.now()));
}

const studentsOf = async (deps: Deps, fid: string) => (await deps.store.query(`FAMILY#${fid}`, 'STUDENT#')).sort((a, b) => a.SK.localeCompare(b.SK));

export async function getDashboard(deps: Deps, ctx: ParentCtx) {
  const today = parisDate(deps.now());
  const items = await studentsOf(deps, ctx.familyId);
  const students = await Promise.all(
    items.map(async (it) => {
      const view = studentView(it);
      return { student: view, progress: await progressOf(deps, ctx.familyId, view.studentId, await readProfile(deps, view.studentId), view.pageQuota, today) };
    }),
  );
  const [fq, meta] = await Promise.all([deps.store.get(keys.quotaFamily(ctx.familyId, today.slice(0, 7))), deps.store.get(keys.family(ctx.familyId))]);
  const limit = typeof fq?.limite === 'number' ? fq.limite : Number(meta?.plafondPages ?? quotaDefaults(deps.env).familyPages);
  const remaining = typeof fq?.restant === 'number' ? fq.restant : limit;
  return { students, familyPagesRemaining: Math.max(0, remaining), familyPagesLimit: limit };
}

/** Classement de la famille (le `pseudo` des lignes est le surnom affiche, jamais l'identifiant de connexion: ID1). Un eleve (`who`) doit etre actif: un eleve suspendu n'y accede plus meme avec un jeton encore valide. */
export async function getLeaderboard(deps: Deps, fid: string, who?: StudentCtx) {
  if (who) await activeStudent(deps, who);
  const week = isoWeek(parisDate(deps.now()));
  const pseudos = new Map((await studentsOf(deps, fid)).map((s) => [s.SK.slice('STUDENT#'.length), studentView(s)] as const));
  const entries = (await deps.store.query(`FAMILY#${fid}`, `WEEK#${week}#`))
    .map((w) => ({ sid: w.SK.slice(`WEEK#${week}#`.length), xp: Number(w.xp ?? 0), days: Array.isArray(w.days) ? w.days.length : 0 }))
    // Seulement les eleves encore dans la famille, avec au moins 3 jours actifs dans la semaine.
    .filter((e) => pseudos.has(e.sid) && e.days >= LEADERBOARD_MIN_ACTIVE_DAYS)
    .map((e) => ({ studentId: e.sid, pseudo: (pseudos.get(e.sid) as StudentView).displayName, xp: e.xp, activeDays: Math.min(7, e.days) }))
    .sort((x, y) => y.xp - x.xp || x.pseudo.localeCompare(y.pseudo));
  return { week, entries };
}
