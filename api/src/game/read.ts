// POST /docs/{docId}/read: XP de lecture de la fiche, calcule a la lecture (option b du plan C4): l'XP vient de la Fiche ecrite par L2a
// (`pagesConsommees`, `doublon`), sans appel entre lots. Une recompense par fiche et par jour.
import { keys } from '../../../shared/ddb/keys.js';
import type { Deps } from '../lib/deps.js';
import { conflict, notFound, type StudentCtx } from '../lib/http.js';
import { activeStudent } from './access.js';
import { grantStreakBonus } from './bonus.js';
import { PAID_PAGES_PER_DAY, XP } from './rules.js';
import { awardBadges, credit, mutate, progressOf, type Progress } from './state.js';
import { parisDate } from './time.js';

export interface ReadResult {
  xpGained: number;
  badges: string[];
  progress: Progress;
}

export async function markRead(deps: Deps, ctx: StudentCtx, docId: string): Promise<ReadResult> {
  const student = await activeStudent(deps, ctx);
  const fiche = await deps.store.get(keys.doc(ctx.studentId, docId));
  if (!fiche) throw notFound();
  const createdDay = typeof fiche.createdAt === 'string' && !Number.isNaN(Date.parse(fiche.createdAt)) ? parisDate(new Date(fiche.createdAt)) : undefined;
  const pages = Number.isInteger(fiche.pagesConsommees) ? Number(fiche.pagesConsommees) : 0;
  const subject = String(fiche.matiere ?? 'autre');

  const { st, result } = await mutate(
    deps,
    ctx.familyId,
    ctx.studentId,
    (s) => {
      s.profile.readFirst = true;
      let amount = 0;
      if (!s.day.reads[docId]) {
        if (createdDay === s.today) {
          // Fiche du jour: 10 XP par page consommee dans le quota, 2 pages payees par jour, rien pour un doublon.
          const paid = fiche.doublon === true ? 0 : Math.max(0, Math.min(pages, PAID_PAGES_PER_DAY - s.day.pagesPaid));
          s.day.pagesPaid += paid;
          s.day.reads[docId] = paid > 0 ? 'scan' : 'none';
          amount = paid * XP.scanPage;
        } else {
          s.day.reads[docId] = 'review'; // revoir une fiche un autre jour que sa creation
          amount = XP.review;
        }
      }
      const c = credit(s, amount, subject);
      return { result: { gained: c.gained, newBadges: awardBadges(s), streakBonus: c.streakBonus } };
    },
    () => conflict('Reessayez'),
  );
  if (result.streakBonus) await grantStreakBonus(deps, ctx.familyId, ctx.studentId, st.month);
  return { xpGained: result.gained, badges: result.newBadges, progress: await progressOf(deps, ctx.familyId, ctx.studentId, st.profile, Number(student.quotaPages), st.today) };
}
