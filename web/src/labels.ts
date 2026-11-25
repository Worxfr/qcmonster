import type { ScanStage, ScanStatus, Subject } from './types';

export const SUBJECTS: Record<Subject, string> = {
  maths: 'Maths', physique: 'Physique-chimie', svt: 'SVT', histoire_geo: 'Histoire-géo', francais: 'Français', autre: 'Autre',
};
export const SUBJECT_IDS = Object.keys(SUBJECTS) as Subject[];
export const subjectLabel = (s?: string) => (s && s in SUBJECTS ? SUBJECTS[s as Subject] : s ?? '');
/** Classe de couleur d'une matiere (style.css, `.subj-*`). */
export const subjectClass = (s?: string) => `subj subj-${s && s in SUBJECTS ? s : 'none'}`;

export const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

/** Etapes affichees dans la frise (spec 2), dans l'ordre. */
export const STAGES: { stage: ScanStage; label: string }[] = [
  { stage: 'envoi', label: 'Envoi' },
  { stage: 'lecture', label: 'Lecture' },
  { stage: 'a_confirmer', label: 'À confirmer' },
  { stage: 'fiche', label: 'Fiche' },
  { stage: 'verification', label: 'Vérification' },
  { stage: 'qcm', label: 'QCM' },
  { stage: 'termine', label: 'Terminé' },
];
export const stageLabel = (s: ScanStage) => (s === 'echec' ? 'Pas réussi' : STAGES.find((x) => x.stage === s)?.label ?? s);

export function stageIndex(stage: ScanStage): number {
  return STAGES.findIndex((s) => s.stage === stage);
}

/** « Il reste 9 h », « Il reste 1 h 20 », « Il reste 12 min ». */
export function timeLeft(expiresAt: string | undefined, now = Date.now()): string | null {
  if (!expiresAt) return null;
  const min = Math.floor((Date.parse(expiresAt) - now) / 60000);
  if (min <= 0) return 'Le délai est presque fini';
  if (min < 60) return `Il reste ${min} min`;
  const h = Math.floor(min / 60);
  const m = min % 60;
  return m && h < 4 ? `Il reste ${h} h ${String(m).padStart(2, '0')}` : `Il reste ${h} h`;
}

export const fmtDay = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
export const fmtTime = (iso: string) => new Date(iso).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' });
export const fmtElapsed = (s: number) => (s < 60 ? `${s} s` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`);

export const CANCELLED_MSG = "Annulé par l'élève";
const norm = (s?: string) => (s ?? '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
/** Libelle de fin selon `Job.state` et le message (un job annule est `rejete` avec « Annule par l'eleve »). */
export function failKind(state: string, message?: string): { label: string; title: string } {
  if (state === 'rejete' && norm(message).startsWith("annule par l'eleve")) return { label: 'Annulé', title: 'Scan annulé' };
  if (state === 'rejete') return { label: 'Document refusé', title: 'Ce document ne peut pas devenir une fiche' };
  if (state === 'expire') return { label: 'Délai dépassé', title: 'Le délai est dépassé' };
  return { label: 'Pas réussi', title: "Ton cours n'a pas pu être traité" };
}

export const countWords = (t: string) => t.trim().split(/\s+/).filter(Boolean).length;

export const pagesLeftText = (n: number) => `${n} page${n > 1 ? 's' : ''}`;
