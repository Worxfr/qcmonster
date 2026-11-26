// Exercices de raisonnement et correction de copie (E1, docs/E1-design.md): fonctions PURES partagees par l'API et les tests.
// Le modele ne produit JAMAIS une note: il classe des etapes et cite la copie; ICI, le code verifie les citations, lit les nombres, calcule la note et l'XP.
import { z } from 'zod';
import { EXO_VOCAB } from './exo-vocab.js';
import { isSafeText } from './latex.js';

// ---------------------------------------------------------------- constantes (valeurs par defaut P7, P8, P9, P13)
export const XP_EXO_MAX = 10;
/** Plafond d'XP des exercices d'une fiche, SEPARE des 50 XP de la banque de questions (Q1). */
export const EXO_DOC_XP_CAP = 20;
export const MAX_EXO_PER_DOC = 5;
export const MAX_COPIES_PER_EXO = 3;
export const MAX_COPIES_PER_DAY = 5;
export const MAX_GEN_PER_DAY = 5;
export const MAX_ILLISIBLE_PER_EXO_DAY = 2;
export const MIN_COPIE_DELAY_MS = 60_000;
export const SOLUTION_WAIT_MS = 10 * 60_000;
export const GEN_STALE_MS = 3 * 60_000;
export const LOCK_STALE_MS = 5 * 60_000;
export const MAX_PAGES = 3;
export const MAX_PAGE_BYTES = 3_750_000;
export const UPLOAD_EXPIRES_S = 600;
export const MIN_VERIFIED_CLAIMS = 2;
export const DEFAULT_TOL_REL = 0.01;
export const GENERIC_HINT = 'Relis cette étape avec ton cours.';

// ---------------------------------------------------------------- schemas (exercice genere)
const Num = z.object({ v: z.number().finite(), unite: z.string().max(20).optional(), tolRel: z.number().min(0.0001).max(0.05).default(DEFAULT_TOL_REL) });
export const EtapeSchema = z.object({
  id: z.string().regex(/^e[1-6]$/),
  libelle: z.string().min(1).max(120),
  pts: z.number().int().min(1).max(4),
  attendu: z.string().min(1).max(200),
  num: Num.optional(),
});
export const FinaleSchema = z.object({ libelle: z.string().min(1).max(120), attendu: z.string().min(1).max(200), pts: z.number().int().min(1).max(8), num: Num });
export const ExoDraftSchema = z.object({
  titre: z.string().min(1).max(80),
  enonce: z.string().min(20).max(1500),
  niveau: z.number().int().min(1).max(3).default(2),
  etapes: z.array(EtapeSchema).min(2).max(6),
  finale: FinaleSchema,
  indices: z.array(z.string().min(1).max(200)).length(3),
  solution: z.string().min(1).max(2500),
  claimIds: z.array(z.string().regex(/^[0-9]{1,3}$/)).max(20).default([]),
});
export type ExoDraft = z.infer<typeof ExoDraftSchema>;
export type Etape = z.infer<typeof EtapeSchema>;
export type Finale = z.infer<typeof FinaleSchema>;

/** Controles de code sur l'exercice ecrit par le modele (design 2.1): poids, bornes, indices sans la valeur finale, LaTeX sur. Renvoie la raison du rejet, ou undefined. */
export function checkDraft(d: ExoDraft): string | undefined {
  const ids = d.etapes.map((e) => e.id);
  if (new Set(ids).size !== ids.length || ids.some((id, i) => id !== `e${i + 1}`)) return 'ids';
  const steps = d.etapes.reduce((n, e) => n + e.pts, 0);
  const total = steps + d.finale.pts;
  if (total < 6 || total > 16) return 'total';
  if (d.finale.pts < 0.3 * total) return 'finale_legere'; // la reponse finale compte au moins 30 %
  if (steps < 0.5 * total) return 'etapes_legeres'; // le raisonnement pese au moins la moitie
  const texts = [d.titre, d.enonce, d.solution, ...d.indices, ...d.etapes.flatMap((e) => [e.libelle, e.attendu]), d.finale.libelle, d.finale.attendu];
  if (texts.some((t) => !isSafeText(t))) return 'latex';
  if (d.indices.some((h) => numberMatches(h, d.finale.num.v, d.finale.num.tolRel))) return 'indice_donne_la_valeur';
  return undefined;
}
export const totalPts = (d: { etapes: { pts: number }[]; finale: { pts: number } }): number => d.etapes.reduce((n, e) => n + e.pts, 0) + d.finale.pts;

// ---------------------------------------------------------------- texte
const strip = (s: string): string => s.normalize('NFD').replace(/\p{M}/gu, '');
/** Texte compare: minuscules, sans accents, espaces uniques. */
export const norm = (s: string): string => strip(s).toLowerCase().replace(/[œŒ]/g, 'oe').replace(/\s+/g, ' ').trim();
const wordsOf = (s: string): string[] => norm(s).split(/[^a-z0-9]+/).filter(Boolean);

/** Retire les balises que la copie pourrait contenir pour sortir de son cadre (<copie>, <enonce>, <bareme>), puis toute autre balise. */
export const defangCopie = (s: string): string => s.replace(/<\/?\s*(copie|enonce|énoncé|bareme|barème)[^>]*>/gi, ' ').replace(/[<>]/g, ' ');

/** Motifs d'instruction (design 6.7): ils posent `suspecte`, sans changer la note. */
const INJECTION = /\b(ignore[rz]?|consigne|note[rz]?|20\s*\/\s*20|10\s*\/\s*10|syst[eè]me|prompt)\b/i;
export const looksLikeInjection = (transcription: string): boolean => INJECTION.test(transcription);

// ---------------------------------------------------------------- nombres
/** Tous les nombres d'un texte: virgule ou point decimal, espaces fines et normales comme separateur de milliers, `1,5e3`, `1,5x10^3`, signe moins. */
export function numbersIn(text: string): number[] {
  const t = text.replace(/[\u00a0\u202f\u2009]/g, ' ').replace(/[−–]/g, '-').replace(/\$/g, ' ');
  const out: number[] = [];
  const re = /(-?)\s?(\d{1,3}(?:[ ]\d{3})+(?:[.,]\d+)?|\d+(?:[.,]\d+)?)(?:\s*(?:[eE]|[x×*]\s*10\s*\^?\s*)\s*\{?(-?\d{1,3})\}?)?/g;
  for (let m = re.exec(t); m; m = re.exec(t)) {
    let v = Number(m[2].replace(/ /g, '').replace(',', '.'));
    if (m[3] !== undefined) v *= 10 ** Number(m[3]);
    if (Number.isFinite(v)) out.push(m[1] === '-' ? -v : v);
  }
  return out;
}
export const closeTo = (x: number, v: number, tolRel: number): boolean => (v === 0 ? Math.abs(x) <= 1e-9 : Math.abs(x - v) <= Math.abs(v) * tolRel);
export const numberMatches = (text: string, v: number, tolRel: number): boolean => numbersIn(text).some((x) => closeTo(x, v, tolRel));

// ---------------------------------------------------------------- correction: etapes
export const STATUTS = ['ok', 'partiel', 'faux', 'absent', 'reporte'] as const;
export type Statut = (typeof STATUTS)[number];
const COEF: Record<Statut, number> = { ok: 1, reporte: 0.75, partiel: 0.5, faux: 0, absent: 0 };

/** Sortie de notation du modele, liste blanche de champs (tout autre champ, notamment une note, est ignore par Zod). */
export const GradeSchema = z.object({
  etapes: z.array(z.object({ id: z.string().max(8), statut: z.enum(STATUTS), preuve: z.string().max(200).default(''), indice: z.string().max(400).default('') })).max(8),
  finale: z.object({ statut: z.enum(['juste', 'fausse', 'absente']).default('absente'), valeurLue: z.string().max(100).default(''), preuve: z.string().max(200).default('') }),
  instructionsVues: z.boolean().default(false),
});
export type Grade = z.infer<typeof GradeSchema>;

/** La preuve (80 caracteres au plus) est-elle un extrait de la transcription? Comparaison sans accents ni casse. */
export function proofOk(preuve: string, transcription: string): boolean {
  const p = norm(preuve).slice(0, 80).trim();
  return p.length >= 2 && norm(transcription).includes(p);
}

export interface Graded {
  statut: Statut;
  preuveOk: boolean;
}

/**
 * Statuts FINAUX d'une copie. Regles de code (design 6.4): une etape sans preuve valide passe a `absent`; une etape qui porte `num` exige la
 * valeur attendue (a `tolRel` pres) DANS la preuve citee; `reporte` exige une etape fausse plus haut et une preuve valide.
 */
export function finalStatuts(exo: { etapes: Etape[] }, grade: Grade, transcription: string): Record<string, Statut> {
  const out: Record<string, Statut> = {};
  let fauxAvant = false;
  for (const e of exo.etapes) {
    const g = grade.etapes.find((x) => x.id === e.id);
    let s: Statut = g?.statut ?? 'absent';
    if (s !== 'absent') {
      if (!g || !proofOk(g.preuve, transcription)) s = 'absent';
      else if (e.num && s !== 'faux' && !numberMatches(g.preuve, e.num.v, e.num.tolRel)) s = 'absent';
      else if (s === 'reporte' && !fauxAvant) s = 'absent';
    }
    if (s === 'faux') fauxAvant = true;
    out[e.id] = s;
  }
  return out;
}

/** Valeur finale lue PAR LE CODE: dans `valeurLue`, puis dans la derniere ligne de la transcription. `juste` seulement si le nombre est dans la tolerance. */
export function finalVerdict(finale: Finale, grade: Grade, transcription: string): 'juste' | 'fausse' | 'absente' {
  // Le nombre n'est retenu que s'il figure dans les 2 dernieres lignes de la copie: `valeurLue` vient du modele, il ne peut pas inventer une finale juste.
  const tail = transcription.split('\n').map((l) => l.trim()).filter(Boolean).slice(-2).join('\n');
  const inTail = numbersIn(tail);
  const candidates = [...numbersIn(grade.finale.valeurLue).filter((x) => inTail.some((y) => closeTo(y, x, 1e-9))), ...numbersIn(tail.split('\n').pop() ?? '')];
  if (candidates.length === 0) return 'absente';
  return candidates.some((x) => closeTo(x, finale.num.v, finale.num.tolRel)) ? 'juste' : 'fausse';
}

/** Note en milliemes (0 a 1000): somme(pts x coef) / somme(pts), la finale suit le verdict du code. */
export function scoreMilli(exo: { etapes: Etape[]; finale: Finale }, statuts: Record<string, Statut>, finale: 'juste' | 'fausse' | 'absente'): number {
  const got = exo.etapes.reduce((n, e) => n + e.pts * COEF[statuts[e.id] ?? 'absent'], 0) + (finale === 'juste' ? exo.finale.pts : 0);
  return Math.round((1000 * got) / totalPts(exo));
}

/** « 3 étapes sur 5 »: etapes `ok` ou `reporte`, plus la finale juste. */
export function bilanOf(statuts: Record<string, Statut>, finale: 'juste' | 'fausse' | 'absente'): { correct: number; total: number; text: string } {
  const list = Object.values(statuts);
  const correct = list.filter((s) => s === 'ok' || s === 'reporte').length + (finale === 'juste' ? 1 : 0);
  const total = list.length + 1;
  return { correct, total, text: `${correct} étape${correct > 1 ? 's' : ''} sur ${total}` };
}

// ---------------------------------------------------------------- correction: texte du retour
/** Vocabulaire de l'exercice: enonce, libelles, indices ecrits a la generation, plus la liste fixe de mots de conseil. */
export function vocabularyOf(exo: { enonce: string; titre: string; etapes: { libelle: string }[]; finale: { libelle: string }; indices: string[] }): Set<string> {
  const v = new Set<string>(EXO_VOCAB);
  for (const t of [exo.enonce, exo.titre, exo.finale.libelle, ...exo.etapes.map((e) => e.libelle), ...exo.indices]) for (const w of wordsOf(t)) v.add(w);
  return v;
}

/**
 * Indice d'etape ecrit par un modele qui a lu la copie (design 6.6). Renvoie le texte garde, ou le texte generique: plus de 200 caracteres, balise,
 * lien, citation de plus de 6 mots de la copie, valeur finale, ou mot hors vocabulaire (un prenom cite en un mot ne passe pas).
 */
export function cleanHint(raw: string, ctx: { transcription: string; finaleValue: number; tolRel: number; vocab: Set<string> }): string {
  const t = raw.replace(/\s+/g, ' ').trim();
  if (t.length === 0 || t.length > 200 || /[<>]|https?|:\/\/|www\./i.test(t) || !isSafeText(t)) return GENERIC_HINT;
  if (numberMatches(t, ctx.finaleValue, ctx.tolRel)) return GENERIC_HINT;
  const tw = wordsOf(t);
  const cw = wordsOf(ctx.transcription).join(' ');
  for (let i = 0; i + 7 <= tw.length; i++) if (cw.includes(tw.slice(i, i + 7).join(' '))) return GENERIC_HINT;
  const mathless = t.replace(/\$[^$]*\$/g, ' ');
  for (const w of wordsOf(mathless)) if (!/^\d+$/.test(w) && !ctx.vocab.has(w)) return GENERIC_HINT;
  return t;
}

/**
 * En-tete de feuille (nom, prenom, classe, date): les 2 premieres lignes sont retirees si elles ne contiennent AUCUN signe d'operation ni formule.
 * shortcut: le design disait « ni chiffre ni signe », mais une classe (« 2nde B ») ou une date contient des chiffres; un chiffre seul ne protege donc pas la ligne.
 * Limite: une premiere ligne de reponse sans signe (« Reponse 20 ») est retiree aussi; la valeur finale se lit sur la derniere ligne.
 */
export function stripHeader(lines: string[]): string[] {
  const out = [...lines];
  const isHeader = (l: string): boolean => /^\s*\d{1,2}\s*[/.-]\s*\d{1,2}\s*[/.-]\s*\d{2,4}\s*$/.test(l) || !/[=+*/×÷^$<>]/.test(l); // une date porte des `/` sans etre une operation
  for (let i = 0; i < 2 && out.length > 0; i++) if (isHeader(out[0])) out.shift();
  return out;
}

// ---------------------------------------------------------------- points
export const xpMax = (indicesVus: number): number => Math.round(XP_EXO_MAX * (1 - 0.2 * Math.min(3, Math.max(0, indicesVus))));
/** XP d'une correction: `max(0, floor(xpMax x note) - dejaPaye)`, par complement, jamais deux fois. 0 si la solution a ete vue. */
export function exoXp(a: { scoreMilli: number; indicesVus: number; xpPaye: number; solutionVue: boolean }): number {
  if (a.solutionVue) return 0;
  return Math.max(0, Math.floor((xpMax(a.indicesVus) * a.scoreMilli) / 1000) - a.xpPaye);
}
/** XP reellement payes apres le plafond de fiche (20 pour les exercices) : le reste de la fiche est `cap - dejaPayeSurLaFiche`. */
export const capToDoc = (amount: number, paidOnDoc: number): number => Math.max(0, Math.min(amount, EXO_DOC_XP_CAP - paidOnDoc));

/** Reference d'exercice: `<docId>-<nn>` (nn sur 2 chiffres; le point n'est pas accepte dans un identifiant de chemin). */
export const exoRef = (docId: string, nn: number): string => `${docId}-${String(nn).padStart(2, '0')}`;
export function parseExoRef(ref: string): { docId: string; nn: number } | undefined {
  const m = /^([A-Za-z0-9_-]{1,64})-([0-9]{2})$/.exec(ref);
  return m ? { docId: m[1], nn: Number(m[2]) } : undefined;
}
/** Ligne d'historique d'une etape: `<docId>:exo:<nn>#<etapeId>` (la finale est `#f`). */
export const exoLineId = (docId: string, nn: number, step: string): string => `${docId}:exo:${String(nn).padStart(2, '0')}#${step}`;
