// Modification d'un cours confirme (M1 #90, docs/M1-design.md 3.1): fonctions PURES. Quelles parties du cours (donc quelles fiches) une demande touche,
// et quels refus lui opposer. Aucun acces a la base; messages CONSTANTS (jamais le texte d'une phrase).
import { REVISION_MAX_CHANGES, REVISION_MAX_DOCS } from '../../../shared/scans.js';
import { MIN_WORDS } from '../pipeline/steps.js';
import { words } from '../pipeline/text.js';

export interface SectionDef {
  fromSentenceId: string;
  ignore?: boolean;
  statut?: string;
  docId?: string;
}
export interface Sent {
  id: string;
  text: string;
}
export type PlanError = 'aucun' | 'trop' | 'debut' | 'vide' | 'trop_court' | 'fiches';
export const PLAN_MESSAGES: Record<PlanError, string> = {
  aucun: 'Aucun changement demandé',
  trop: `Trop de changements (${REVISION_MAX_CHANGES} au plus)`,
  debut: 'Tu ne peux pas retirer la première phrase d’une partie du cours',
  vide: 'Une partie du cours ne peut pas devenir vide',
  trop_court: `Il faut garder au moins ${MIN_WORDS} mots dans les parties gardées`,
  fiches: `Trop de fiches touchées (${REVISION_MAX_DOCS} au plus)`,
};

/** Phrases [start, end[ de chaque partie du cours, dans l'ordre du texte. La premiere partie commence toujours a 0 (une phrase ajoutee tout au debut lui appartient). */
export function rangesOf(ids: string[], sections: SectionDef[]): { start: number; end: number }[] {
  const starts = sections.map((s, n) => (n === 0 ? 0 : ids.indexOf(s.fromSentenceId)));
  return starts.map((start, n) => ({ start, end: n + 1 < starts.length ? starts[n + 1] : ids.length }));
}
const sectionOf = (ranges: { start: number; end: number }[], at: number): number => ranges.findIndex((r) => at >= r.start && at < r.end);

export interface Touched {
  /** Rang (dans `head.sections`) de chaque partie touchee, croissant. */
  sections: number[];
  /** Parties touchees qui ont une fiche. */
  fiches: number[];
}

/**
 * `before` = phrases du cours avant la modification, `after` = apres (`applyChanges`). `corrected`, `removed` sont des identifiants d'AVANT, `added` d'APRES.
 * Refus (400) : premiere phrase d'une partie retiree, partie vide, moins de 40 mots dans les parties gardees, plus de 3 fiches touchees.
 */
export function analyse(before: Sent[], after: Sent[], sections: SectionDef[], c: { corrected: string[]; removed: string[]; added: string[] }): { ok: true; touched: Touched } | { ok: false; error: PlanError } {
  const n = c.corrected.length + c.removed.length + c.added.length;
  if (n === 0) return { ok: false, error: 'aucun' };
  if (n > REVISION_MAX_CHANGES) return { ok: false, error: 'trop' };
  const removed = new Set(c.removed);
  if (sections.some((s) => removed.has(s.fromSentenceId))) return { ok: false, error: 'debut' };
  const bIds = before.map((s) => s.id);
  const aIds = after.map((s) => s.id);
  const bR = rangesOf(bIds, sections);
  const aR = rangesOf(aIds, sections);
  if (aR.some((r) => r.end <= r.start)) return { ok: false, error: 'vide' };
  const kept = after.reduce((total, s, k) => total + (sections[sectionOf(aR, k)]?.ignore ? 0 : words(s.text).length), 0);
  if (kept < MIN_WORDS) return { ok: false, error: 'trop_court' };
  const touched = new Set<number>();
  for (const id of [...c.corrected, ...c.removed]) touched.add(sectionOf(bR, bIds.indexOf(id)));
  for (const id of c.added) touched.add(sectionOf(aR, aIds.indexOf(id)));
  touched.delete(-1);
  const list = [...touched].sort((a, b) => a - b);
  const fiches = list.filter((k) => sections[k].statut === 'fiche' && typeof sections[k].docId === 'string' && !sections[k].ignore);
  if (fiches.length > REVISION_MAX_DOCS) return { ok: false, error: 'fiches' };
  return { ok: true, touched: { sections: list, fiches } };
}

/**
 * Phrases a donner a l'extraction pour la partie `section`: les phrases corrigees ou ajoutees (jamais les autres: leurs affirmations existent deja),
 * dans l'ordre du texte, et jusqu'a `lead` phrases de contexte juste avant la premiere (lecture seule, aucune affirmation n'en est gardee).
 */
export function extractionInput(after: Sent[], sections: SectionDef[], section: number, changed: Set<string>, lead = 2): { owned: Sent[]; context: Sent[] } {
  const r = rangesOf(after.map((s) => s.id), sections)[section];
  const slice = after.slice(r.start, r.end);
  const owned = slice.filter((s) => changed.has(s.id));
  const first = owned.length ? slice.indexOf(owned[0]) : 0;
  return { owned, context: slice.slice(Math.max(0, first - lead), first) };
}
