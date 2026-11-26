// Fonctions pures des ecrans d'exercices (E1-W): libelles, messages d'erreur en mots simples, points restants.
import { ApiError } from './api';
import type { Copie, CopieEtape, Subject } from './types';

/** Matieres qui ont des exercices (le serveur refuse les autres avec `matiere_non_prevue`). */
export const EXO_SUBJECTS: Subject[] = ['maths', 'physique'];
export const hasExercices = (subject?: string) => EXO_SUBJECTS.includes(subject as Subject);

export const POLL_MS = 2000;
/** Au-dela, on arrete d'interroger et on le dit (la correction normale dure 10 a 40 secondes). */
export const COPIE_WAIT_MS = 3 * 60_000;
export const EXO_WAIT_MS = 3 * 60_000;
export const MAX_EXERCICES = 5;
export const MAX_PAGES_COPIE = 3;
export const XP_EXO_MAX = 10;
/** 3 Mo 750: limite d'une page de copie (section 5.1 de la conception). */
export const MAX_COPIE_BYTES = 3.75 * 1024 * 1024;

/** Points encore possibles apres `vus` indices: chaque indice retire 20 % (10, 8, 6, 4). */
export const pointsLeft = (vus: number) => Math.round(XP_EXO_MAX * (1 - 0.2 * Math.min(3, Math.max(0, vus))));

export const STEP_STATUS: Record<CopieEtape['statut'], { label: string; icon: string; cls: string }> = {
  ok: { label: 'Juste', icon: '✅', cls: 'ok' },
  partiel: { label: 'À compléter', icon: '🟡', cls: 'partiel' },
  faux: { label: 'Faux', icon: '❌', cls: 'faux' },
  absent: { label: 'Pas trouvé', icon: '🔍', cls: 'absent' },
  reporte: { label: 'Cohérent avec ton erreur d\'avant', icon: '🔁', cls: 'reporte' },
};
export const stepStatus = (s: string) => STEP_STATUS[s as CopieEtape['statut']] ?? { label: 'À revoir', icon: '🔍', cls: 'absent' };

export const FINALE_STATUS: Record<NonNullable<Copie['finale']>['statut'], { label: string; icon: string; cls: string }> = {
  juste: { label: 'Juste', icon: '✅', cls: 'ok' },
  fausse: { label: 'Faux', icon: '❌', cls: 'faux' },
  absente: { label: 'Pas trouvé', icon: '🔍', cls: 'absent' },
};
export const finaleStatus = (s: string) => FINALE_STATUS[s as keyof typeof FINALE_STATUS] ?? { label: 'À revoir', icon: '🔍', cls: 'absent' };

export const AI_NOTICE = 'Cette correction est faite par une IA, elle peut se tromper. Si tu n\'es pas d\'accord, regarde la solution ou demande à ton professeur.';
export const ILLISIBLE_MSG = 'Je n\'arrive pas à lire, reprends en photo plus net. Ça ne compte pas dans tes essais.';

/** « 2 corrections possibles », « Dernière correction possible », « Plus de correction possible ». */
export function triesText(left: number): string {
  if (left <= 0) return 'Tu as utilisé tes 3 corrections pour cet exercice.';
  if (left === 1) return 'Il te reste 1 correction pour cet exercice.';
  return `Il te reste ${left} corrections pour cet exercice.`;
}

export function fmtDate(iso?: string): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('fr-FR', { day: 'numeric', month: 'long', timeZone: 'Europe/Paris' });
}

/** Un exercice qui se prepare, une copie corrigee, etc.: libelle court de l'etat d'un exercice dans la liste. */
export function etatExercice(etat: string): { label: string; icon: string } {
  if (etat === 'generation') return { label: 'En préparation…', icon: '⏳' };
  if (etat === 'echec') return { label: 'Pas réussi', icon: '😕' };
  return { label: 'Prêt', icon: '✏️' };
}

export type ExoCtx = 'creation' | 'indice' | 'solution' | 'copie' | 'envoi' | 'supprimer' | 'charger';

/** Phrase en mots simples pour une erreur de l'API d'exercices (409 par code, 429, 403, 404). */
export function exoError(e: unknown, ctx: ExoCtx = 'charger'): string {
  if (!(e instanceof ApiError)) return e instanceof Error && ctx === 'envoi' && /Envoi impossible/.test(e.message) ? 'L\'envoi de ta photo n\'a pas marché. Vérifie ta connexion et réessaie.' : 'Une erreur est survenue. Réessaie dans un instant.';
  if (e.status === 429) return 'Tu vas un peu vite. Attends quelques secondes, puis réessaie.';
  if (e.status === 403) return 'Cet écran est réservé à l\'élève.';
  if (e.status === 404) return 'Cet exercice n\'existe plus.';
  switch (e.code) {
    case 'matiere_non_prevue': return 'Les exercices existent pour les maths et la physique-chimie.';
    case 'plafond_exercices': return 'Tu as atteint la limite d\'exercices : 5 par fiche, et un nouveau par fiche et par jour. Travaille un exercice déjà prêt, ou reviens demain.';
    case 'fiche_trop_courte': return 'Cette fiche est trop courte pour fabriquer un exercice. Scanne un cours plus complet.';
    case 'pas_encore': return 'Essaie d\'abord l\'exercice. Tu pourras voir la solution après une correction, ou après 3 indices et 10 minutes.';
    case 'solution_vue': return 'Tu as déjà vu la solution : cette copie ne rapporte plus de points.';
    case 'trop_tot': return 'Prends le temps de faire l\'exercice, puis rends ta copie. Tu peux réessayer dans un instant.';
    case 'deja_en_cours': return 'Une correction est déjà en route. Attends son retour avant d\'en envoyer une autre.';
    case 'quota_copies': return e.resetDate ? `Tu as utilisé toutes tes pages de copie ce mois-ci. Elles reviennent le ${fmtDate(e.resetDate)}.` : 'Tu as utilisé toutes tes pages de copie ce mois-ci. Elles reviennent le mois prochain.';
    case 'plafond_copies': return 'Tu as atteint la limite de corrections : 3 par exercice et 5 par jour. Regarde la solution, ou reviens demain.';
    case 'copie_deja_rendue': return 'Cette photo a déjà été rendue. Prends ta copie du moment en photo.';
    case 'en_correction': return 'La correction est encore en cours. Attends son retour, puis tu pourras supprimer cette copie.';
    case 'etat_invalide': return ctx === 'indice' ? 'Tu as déjà tous les indices.' : 'Ce n\'est pas possible maintenant. Recharge la page et réessaie.';
    default:
      if (ctx === 'indice' && e.status === 409) return 'Tu as déjà tous les indices.';
      return e.status >= 500 ? 'Le service ne répond pas bien. Réessaie dans un instant.' : 'Ça n\'a pas marché. Réessaie dans un instant.';
  }
}

/** Message pour une copie qui ne sera pas corrigee (`illisible`, `echec`, `annulee`). */
export function copieEndMessage(c: Pick<Copie, 'etat' | 'motif'>): string | null {
  if (c.etat === 'illisible') return ILLISIBLE_MSG;
  if (c.etat === 'annulee') return 'Cette copie a été annulée.';
  if (c.etat === 'echec') return c.motif === 'copie_deja_rendue'
    ? 'Cette photo a déjà été rendue. Prends ta copie du moment en photo, puis rends-la.'
    : 'La correction n\'a pas marché. Tes pages te sont rendues et ça ne compte pas dans tes essais. Réessaie dans un instant.';
  return null;
}

/** Bilan « 2 étapes sur 4 » si le serveur n'en donne pas. */
export const bilanOf = (c: Pick<Copie, 'bilan' | 'etapes'>): string => c.bilan ?? (c.etapes ? `${c.etapes.filter((x) => x.statut === 'ok' || x.statut === 'reporte').length} étapes sur ${c.etapes.length}` : '');

/** Controle d'une photo choisie: type identique aux pages deja choisies (une seule `contentType` par copie), taille, nombre. */
export function checkPhoto(f: { name: string; type: string; size: number }, have: { type: string }[]): string | null {
  if (f.type !== 'image/jpeg' && f.type !== 'image/png') return `« ${f.name} » n'est pas une photo JPEG ou PNG.`;
  if (f.size > MAX_COPIE_BYTES) return `« ${f.name} » est trop lourde (3,7 Mo au maximum). Reprends la photo en qualité moyenne.`;
  if (have.length >= MAX_PAGES_COPIE) return `${MAX_PAGES_COPIE} pages au maximum : la photo en trop n'a pas été ajoutée.`;
  if (have.length && have[0].type !== f.type) return `« ${f.name} » n'est pas du même type que tes autres photos. Prends-les toutes en JPEG, ou toutes en PNG.`;
  return null;
}

/** Libelle d'une ligne `kind: exo` de l'historique (aucun texte dans le contrat): « Étape 1 » ... « Résultat final ». */
export function exoLineLabel(questionId: string, rank?: number): string {
  const step = /#(?:e|etape-?)?(\d+)$/i.exec(questionId);
  if (step) return `Étape ${Number(step[1])}`;
  if (/#(?:finale?|f|final)$/i.test(questionId)) return 'Résultat final';
  return rank ? `Étape ${rank}` : 'Étape';
}
