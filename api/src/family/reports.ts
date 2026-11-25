// POST /reports/{id}/validate: le parent valide ou rejette un signalement. Un signalement valide rapporte 15 XP a l'eleve et le badge
// « chasseur d'erreurs ». L2a ecrit le signalement (docs-report); L3 ne change que `statut` (docs/data-model.md).
import { keys } from '../../../shared/ddb/keys.js';
import { SignalementItemSchema } from '../../../shared/items.js';
import { awardBadges, credit, mutate } from '../game/state.js';
import { XP } from '../game/rules.js';
import { grantStreakBonus } from '../game/bonus.js';
import type { Deps } from '../lib/deps.js';
import { conflict, notFound, type ParentCtx } from '../lib/http.js';

export interface ReportView {
  reportId: string;
  docId?: string;
  claimId?: string;
  status: 'ouvert' | 'valide' | 'rejete';
}

export async function validateReport(deps: Deps, ctx: ParentCtx, reportId: string, decision: 'valide' | 'rejete'): Promise<ReportView> {
  const key = keys.report(ctx.familyId, reportId); // sous FAMILY#<fid du jeton>: l'identifiant d'une autre famille n'existe pas ici
  const first = await deps.store.get(key);
  const parsed = SignalementItemSchema.safeParse(first);
  if (!first || !parsed.success) throw notFound();
  const view = (status: ReportView['status']): ReportView => ({ reportId, docId: parsed.data.docId, ...(parsed.data.claimId ? { claimId: parsed.data.claimId } : {}), status });
  if (parsed.data.statut !== 'ouvert') throw conflict('Signalement déjà traité');

  if (decision === 'rejete') {
    if (!(await deps.store.commit([{ item: { ...first, statut: 'rejete' }, when: first.v ?? 'any' }]))) throw conflict('Réessaie');
    return view('rejete');
  }

  // Auteur du signalement: `studentId` s'il est ecrit, sinon l'eleve de la famille qui possede la fiche.
  const students = (await deps.store.query(`FAMILY#${ctx.familyId}`, 'STUDENT#')).map((s) => s.SK.slice('STUDENT#'.length));
  const declared = typeof first.studentId === 'string' ? [first.studentId] : [];
  let owner: string | undefined;
  let subject = 'autre';
  for (const sid of [...declared, ...students]) {
    const doc = students.includes(sid) ? await deps.store.get(keys.doc(sid, parsed.data.docId)) : undefined;
    if (doc) {
      owner = sid;
      subject = String(doc.matiere ?? 'autre');
      break;
    }
  }

  if (!owner) {
    // Fiche supprimee entre-temps: le signalement est valide, sans XP.
    if (!(await deps.store.commit([{ item: { ...first, statut: 'valide' }, when: first.v ?? 'any' }]))) throw conflict('Réessaie');
    return view('valide');
  }
  const sid = owner;
  const { st, result } = await mutate(
    deps,
    ctx.familyId,
    sid,
    async (s) => {
      const cur = await deps.store.get(key); // relu a chaque essai: deux validations simultanees ne paient qu'une fois
      if (!cur || cur.statut !== 'ouvert') throw conflict('Signalement déjà traité');
      s.profile.validReports += 1;
      const c = credit(s, XP.report, subject);
      return { extra: [{ item: { ...cur, statut: 'valide' }, when: cur.v ?? 'any' }], result: { streakBonus: c.streakBonus, badges: awardBadges(s) } };
    },
    () => conflict('Réessaie'),
  );
  if (result.streakBonus) await grantStreakBonus(deps, ctx.familyId, sid, st.month);
  return view('valide');
}
