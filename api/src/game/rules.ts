// Regles du jeu (docs/game-rules.md, source de verite). Fonctions pures: aucun acces a la base ni a l'horloge.
export const XP = { qcmFirst: 5, qcmSecond: 2, gap: 5, seriesDone: 20, seriesPerfect: 30, review: 8, report: 15, scanPage: 10 } as const;
export const DAILY_XP_CAP = 250;
/** Q1 (decision du proprietaire): 50 XP au plus par fiche, pour toute la vie de la fiche (points de reponse seulement; ni serie, ni page, ni revision). */
export const DOC_XP_CAP = 50;
/** XP deja payes sur une fiche, depuis ses lignes ATT. Une ancienne ligne sans `xp` compte 5 si `rewarded` (valeur haute), sinon 0. */
export const paidXp = (rows: Record<string, unknown>[]): number =>
  rows.reduce((n, r) => n + (typeof r.xp === 'number' ? r.xp : r.rewarded === true ? XP.gap : 0), 0);
export const PAID_PAGES_PER_DAY = 2;
/** Un jour compte pour la serie a partir de 30 XP. */
export const DAY_VALID_XP = 30;
export const SERIES_LENGTH = 10;
/** Anti-triche (game-rules 7): reponse en moins de 1 s, serie de 10 en moins de 20 s, plus de 100 bonnes reponses en 10 min. */
export const MIN_ANSWER_MS = 1000;
export const MIN_SERIES_MS = 20_000;
export const BURST_MAX_CORRECT = 100;
export const BURST_WINDOW_MS = 10 * 60_000;
export const FREEZES_PER_MONTH = 2;
export const STREAK_BONUS_EVERY = 7;
export const STREAK_BONUS_PAGES = 2;
export const STREAK_BONUS_FAMILY_MONTH_CAP = 6;
export const LEADERBOARD_MIN_ACTIVE_DAYS = 3;
export const MAX_STUDENTS_PER_FAMILY = 10;

/** Niveau: plus grand n tel que 25 x n x (n + 1) <= xp (50, 150, 300, 500, 750 pour 1 a 5). */
export function levelOf(xp: number): number {
  if (!Number.isFinite(xp) || xp < 50) return 0;
  let n = Math.floor((-1 + Math.sqrt(1 + (4 * xp) / 25)) / 2);
  while (25 * (n + 1) * (n + 2) <= xp) n++; // garde contre l'arrondi flottant
  while (n > 0 && 25 * n * (n + 1) > xp) n--;
  return n;
}

/** Stade de la mascotte: 1 oeuf (niveau 0), 2 bebe (1-4), 3 jeune (5-9), 4 confirme (10-19), 5 legendaire (20+). */
export const stageOf = (level: number): 1 | 2 | 3 | 4 | 5 => (level >= 20 ? 5 : level >= 10 ? 4 : level >= 5 ? 3 : level >= 1 ? 2 : 1);

/** Comparaison du texte a trous: minuscules, sans accents, ligatures (œ, æ) et apostrophes typographiques unifiees, espaces et ponctuation de bord retires (aucune tolerance de faute). */
export const normalizeGap = (s: string): string =>
  s
    .replace(/[œŒ]/g, 'oe')
    .replace(/[æÆ]/g, 'ae')
    .replace(/[’‘`´]/g, "'")
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/^[\s\p{P}]+|[\s\p{P}]+$/gu, '');

export const MATIERES = ['maths', 'physique', 'svt', 'histoire_geo', 'francais', 'autre'] as const;
export type Matiere = (typeof MATIERES)[number];
