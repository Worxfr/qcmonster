import type { Claim, JobState } from './types';

/** Seuil cumule du niveau n (design-v2 section 7): 25 x n x (n + 1) XP, soit 50, 150, 300, 500, 750. */
export const levelThreshold = (n: number) => 25 * n * (n + 1);

export function levelProgress(xp: number, level: number) {
  const from = level <= 0 ? 0 : levelThreshold(level);
  const to = levelThreshold(level + 1);
  const pct = Math.max(0, Math.min(100, Math.round(((xp - from) / (to - from)) * 100)));
  return { from, to, pct, remaining: Math.max(0, to - xp) };
}

export const STAGES = [
  { stage: 1, name: 'Œuf', levels: 'niveau 0' },
  { stage: 2, name: 'Bébé monstre', levels: 'niveaux 1 à 4' },
  { stage: 3, name: 'Jeune monstre', levels: 'niveaux 5 à 9' },
  { stage: 4, name: 'Monstre confirmé', levels: 'niveaux 10 à 19' },
  { stage: 5, name: 'Monstre légendaire', levels: 'niveau 20 et plus' },
] as const;

export const stageName = (stage: number) => STAGES[Math.min(5, Math.max(1, stage)) - 1].name;

export const CLAIM_LABEL: Record<Claim['status'], { text: string; icon: string; cls: string } | null> = {
  verifiee: { text: 'Vérifié', icon: '✓', cls: 'pill-ok' },
  erreur: { text: 'Erreur', icon: '✗', cls: 'pill-bad' },
  non_verifiable: { text: 'Non vérifiable', icon: '?', cls: 'pill-warn' },
  non_factuelle: null,
};

export const JOB_STEPS: { state: JobState; label: string }[] = [
  { state: 'verification_fichier', label: 'Contrôle du fichier' },
  { state: 'transcription', label: 'Lecture du cours' },
  { state: 'a_confirmer', label: 'À toi de vérifier le texte' },
  { state: 'verification', label: 'Vérification des faits' },
  { state: 'generation', label: 'Fabrication des questions' },
  { state: 'termine', label: 'Fiche prête' },
];

export const JOB_FINAL: JobState[] = ['termine', 'rejete', 'echec', 'expire'];

/**
 * Catalogue des badges (identifiants de docs/game-rules.md section 4). shortcut: copie locale tant que le serveur
 * (L3) ne publie pas son catalogue; un identifiant inconnu s'affiche quand meme (repli sur l'identifiant lisible).
 */
export const BADGES: { id: string; icon: string; label: string; hint: string }[] = [
  { id: 'premier_scan', icon: '📷', label: 'Premier scan', hint: "Lis ta première fiche jusqu'au bout" },
  { id: 'serie_7', icon: '🔥', label: 'Série de 7 jours', hint: 'Reviens 7 jours de suite' },
  { id: 'serie_30', icon: '🌋', label: 'Série de 30 jours', hint: 'Reviens 30 jours de suite' },
  { id: 'cent_bonnes_reponses', icon: '💯', label: '100 bonnes réponses', hint: 'Réponds juste 100 fois' },
  { id: 'serie_parfaite_x5', icon: '🎯', label: 'Cinq séries parfaites', hint: 'Fais 5 séries sans faute' },
  { id: 'chasseur_d_erreurs', icon: '🔎', label: "Chasseur d'erreurs", hint: 'Un signalement validé par ton parent' },
  { id: 'explorateur', icon: '🧭', label: 'Explorateur', hint: 'Travaille 5 matières dans le mois' },
  { id: 'maitre_maths', icon: '➗', label: 'Maître des maths', hint: '500 XP en maths' },
  { id: 'maitre_physique', icon: '⚗️', label: 'Maître de la physique', hint: '500 XP en physique-chimie' },
  { id: 'maitre_svt', icon: '🌱', label: 'Maître des SVT', hint: '500 XP en SVT' },
  { id: 'maitre_histoire_geo', icon: '🗺️', label: "Maître de l'histoire-géo", hint: '500 XP en histoire-géo' },
  { id: 'maitre_francais', icon: '📚', label: 'Maître du français', hint: '500 XP en français' },
];
export const badgeLabel = (id: string) => BADGES.find((b) => b.id === id)?.label ?? id.replace(/_/g, ' ');

/** Les liens de sources viennent du serveur: on n'ouvre que https. */
export function safeUrl(u: string): string | null {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' ? p.href : null;
  } catch {
    return null;
  }
}

/** Nombre de pages d'un PDF, par comptage des objets /Type /Page. shortcut: heuristique, le serveur controle le vrai nombre (4.8). */
export function countPdfPages(bytes: Uint8Array): number {
  const text = new TextDecoder('latin1').decode(bytes);
  return (text.match(/\/Type\s*\/Page(?![a-zA-Z])/g) ?? []).length;
}
