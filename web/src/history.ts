// Aides d'affichage de l'historique des tests (H1-W). Dates en heure de Paris, comme l'annee scolaire du serveur.
import { ApiError } from './api';
import { exoLineLabel } from './exo';
import type { TestSummary } from './types';

const TZ = 'Europe/Paris';
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

/** « Mardi 1 décembre, 18 h 02 ». */
export function fmtWhen(iso: string): string {
  const d = new Date(iso);
  const day = d.toLocaleDateString('fr-FR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: TZ });
  const time = d.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', timeZone: TZ }).replace(':', ' h ');
  return `${cap(day)}, ${time}`;
}
/** « 1 déc. » pour les listes. */
export const fmtShort = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'short', timeZone: TZ });

export const yearLabel = (y: string) => `Année ${y.replace('-', ' - ')}`;

export type Tone = 'top' | 'mid' | 'low';
/** Trois paliers de couleur; jamais de rouge pour un score (on encourage). */
export const toneOf = (pct: number): Tone => (pct >= 80 ? 'top' : pct >= 50 ? 'mid' : 'low');
export const encouragement = (pct: number) => (pct >= 80 ? 'Bravo, super résultat !' : pct >= 50 ? 'Bien joué, tu progresses !' : 'Continue, chaque test te fait progresser !');

/** Valeur inconnue du contrat = « Test » (des modes s'ajouteront). */
export const MODE_LABEL: Record<string, string> = { mixte: 'QCM et trous', qcm: 'QCM', gap: 'Texte à trous', exercice: 'Exercice' };
export const modeLabel = (m: string) => MODE_LABEL[m] ?? 'Test';
export const KIND_LABEL: Record<string, string> = { qcm: 'QCM', gap: 'Texte à trous', exo: 'Exercice' };

/** Regroupe en gardant l'ordre reçu (récent d'abord): une rubrique par année scolaire. */
export function groupByYear(items: TestSummary[]): { year: string; items: TestSummary[] }[] {
  const out: { year: string; items: TestSummary[] }[] = [];
  for (const t of items) {
    const g = out.find((x) => x.year === t.schoolYear);
    if (g) g.items.push(t);
    else out.push({ year: t.schoolYear, items: [t] });
  }
  return out;
}

export const verdict = (q: { correct: boolean; attempts: number; firstTry: boolean; kind?: string }) =>
  q.kind === 'exo' ? (q.correct ? { icon: '✅', text: 'Juste', cls: 'pill-ok' } : { icon: '❌', text: 'À revoir', cls: 'pill-warn' }) :
  q.correct ? (q.firstTry ? { icon: '✅', text: 'Juste du premier coup', cls: 'pill-ok' } : { icon: '✅', text: 'Juste au 2e essai', cls: 'pill-ok' }) : { icon: '❌', text: q.attempts > 1 ? 'À revoir (2 essais)' : 'À revoir', cls: 'pill-warn' };

/** Message pour l'export en archive: 429 `quota_epuise` (3 par heure et par famille) ou limite de débit de la route. */
export function archiveError(e: unknown): string {
  if (e instanceof ApiError && e.status === 429) {
    return e.code === 'quota_epuise'
      ? "Tu as déjà demandé 3 archives cette heure-ci. Réessaie dans une heure : le lien de la dernière archive reste valable 10 minutes après sa création."
      : 'Trop de demandes en même temps. Patiente quelques secondes et réessaie.';
  }
  return e instanceof Error ? e.message : 'Une erreur est survenue';
}

/** « Question 3 » pour un QCM ou un trou; « Étape 1 » ... « Résultat final » pour une ligne d exercice (kind exo, sans texte). */
export const lineLabel = (q: { kind: string; rank: number; questionId: string }) => (q.kind === 'exo' ? exoLineLabel(q.questionId, q.rank) : `Question ${q.rank}`);
