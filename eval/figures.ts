// Mesure des cadres de figures et des marquages douteux (R1, docs/R1-design.md 3.5 et 4.1). Fonctions pures: aucun appel de modele.
// Les cadres sont [x, y, largeur, hauteur] en fractions de la page. La mesure reelle (10 pages avec schemas) demande des appels payants: voir eval/README.md.

export type Box = [number, number, number, number];

/** Recouvrement (intersection sur union) de deux cadres, entre 0 et 1. */
export function iou(a: Box, b: Box): number {
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  const inter = w * h;
  const union = a[2] * a[3] + b[2] * b[3] - inter;
  return union > 0 ? inter / union : 0;
}

export const BOX_OK_IOU = 0.6; // « cadre correct »: recouvrement d'au moins 0,6 avec le cadre trace a la main
export const BOX_SONNET_BELOW = 0.7; // sous 70 % de cadres corrects: mode « Sonnet d'abord » (FIGURE_BOX_MODEL=sonnet)

export interface BoxMeasure {
  figures: number;
  correct: number;
  rate: number;
  /** Figures sans cadre (page entiere): comptees a part, jamais « correctes ». */
  fullPage: number;
  sonnetFirst: boolean;
}

/** `pairs`: cadre propose (absent = page entiere) et cadre de reference de chaque figure. */
export function measureBoxes(pairs: { proposed?: Box; truth: Box }[]): BoxMeasure {
  const correct = pairs.filter((p) => p.proposed && iou(p.proposed, p.truth) >= BOX_OK_IOU).length;
  const rate = pairs.length ? correct / pairs.length : 0;
  return { figures: pairs.length, correct, rate, fullPage: pairs.filter((p) => !p.proposed).length, sonnetFirst: pairs.length > 0 && rate < BOX_SONNET_BELOW };
}

/** Taux de phrases marquees douteuses sur une page (le code supprime tout marquage au-dela de 40 %). */
export const doubtRate = (sentences: { doubt?: boolean }[]): number => (sentences.length ? sentences.filter((s) => s.doubt).length / sentences.length : 0);
