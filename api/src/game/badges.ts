// Catalogue des badges (docs/game-rules.md section 4). Seuls ces identifiants sortent de l'API (test: badges.test.ts).
export const BADGE_IDS = [
  'premier_scan',
  'serie_7',
  'serie_30',
  'cent_bonnes_reponses',
  'serie_parfaite_x5',
  'chasseur_d_erreurs',
  'explorateur',
  'maitre_maths',
  'maitre_physique',
  'maitre_svt',
  'maitre_histoire_geo',
  'maitre_francais',
] as const;
export type BadgeId = (typeof BADGE_IDS)[number];
export const isBadge = (s: string): s is BadgeId => (BADGE_IDS as readonly string[]).includes(s);

export const MASTER_XP = 500;
export const EXPLORER_SUBJECTS = 5;

export interface BadgeFacts {
  readFirst: boolean;
  streak: number;
  correct: number;
  perfectSeries: number;
  validReports: number;
  subjectsThisMonth: number;
  xpBySubject: Record<string, number>;
}

/** Tous les badges merites d'apres les faits (le serveur retire ceux deja obtenus). */
export function earned(f: BadgeFacts): BadgeId[] {
  const out: BadgeId[] = [];
  if (f.readFirst) out.push('premier_scan');
  if (f.streak >= 7) out.push('serie_7');
  if (f.streak >= 30) out.push('serie_30');
  if (f.correct >= 100) out.push('cent_bonnes_reponses');
  if (f.perfectSeries >= 5) out.push('serie_parfaite_x5');
  if (f.validReports >= 1) out.push('chasseur_d_erreurs');
  if (f.subjectsThisMonth >= EXPLORER_SUBJECTS) out.push('explorateur');
  for (const m of ['maths', 'physique', 'svt', 'histoire_geo', 'francais'] as const) if ((f.xpBySubject[m] ?? 0) >= MASTER_XP) out.push(`maitre_${m}`);
  return out;
}
