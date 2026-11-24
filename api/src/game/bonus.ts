// Bonus de serie: +2 pages tous les 7 jours de serie, au plus +6 pages par famille et par mois (design-v2 4.7).
// Le compteur du mois est dans FAMILY#<fid>/META (ecrit par L3, de facon conditionnelle); le bonus lui-meme passe par `addBonus` de shared/quota.ts.
import { keys } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import { addBonus } from '../../../shared/quota.js';
import type { Deps } from '../lib/deps.js';
import { STREAK_BONUS_FAMILY_MONTH_CAP, STREAK_BONUS_PAGES } from './rules.js';

/** Renvoie le nombre de pages accordees (0 si le plafond du mois est atteint ou si la famille est inconnue). */
export async function grantStreakBonus(deps: Deps, fid: string, sid: string, month: string): Promise<number> {
  for (let i = 0; i < 3; i++) {
    const meta = await deps.store.get(keys.family(fid));
    const student = await deps.store.get(keys.student(fid, sid));
    if (!meta || !student) return 0;
    const used = meta.bonusMonth === month ? Number(meta.bonusPages ?? 0) : 0;
    const pages = Math.min(STREAK_BONUS_PAGES, STREAK_BONUS_FAMILY_MONTH_CAP - used);
    if (pages <= 0) return 0;
    const ok = await deps.store.commit([{ item: { ...meta, bonusMonth: month, bonusPages: used + pages }, when: meta.v ?? 'any' }]);
    if (!ok) continue;
    const defaults = quotaDefaults(deps.env);
    await addBonus(deps.quota, { familyId: fid, studentId: sid, month, studentLimit: Number(student.quotaPages ?? defaults.studentPages), familyLimit: Number(meta.plafondPages ?? defaults.familyPages) }, pages);
    return pages;
  }
  return 0;
}
