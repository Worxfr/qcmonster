// Elements DynamoDB partages entre lots (docs/data-model.md). UN ecrivain par type: voir le tableau du modele.
// Les schemas Zod valident ce qu'un lot lit d'un autre lot. Aucun contenu de cours dans les journaux (design 4.9).
import { z } from 'zod';
import { SUBJECTS } from './scans.js';

/** Identifiant de question: <docId>:<qcm|gap>:<nn>. Unique entre fiches (cle de tentative ATT#<questionId>#<date>). */
export const questionId = (docId: string, kind: 'qcm' | 'gap', nn: number): string => `${docId}:${kind}:${String(nn).padStart(2, '0')}`;
export const QuestionIdSchema = z.string().regex(/^[A-Za-z0-9_-]{1,64}:(qcm|gap):[0-9]{2}$/);
export function parseQuestionId(id: string): { docId: string; kind: 'qcm' | 'gap'; nn: number } {
  const m = /^([A-Za-z0-9_-]{1,64}):(qcm|gap):([0-9]{2})$/.exec(id);
  if (!m) throw new RangeError('questionId invalide');
  return { docId: m[1], kind: m[2] as 'qcm' | 'gap', nn: Number(m[3]) };
}

export const JobStateSchema = z.enum(['en_attente_envoi', 'verification_fichier', 'transcription', 'a_confirmer', 'verification', 'generation', 'termine', 'rejete', 'echec', 'expire']);

/** Job (ecrit par L2a). TTL 7 jours. `coutCentimes` = somme mesuree des appels Bedrock (L2a + L2b). */
export const JobItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  familyId: z.string(),
  state: JobStateSchema,
  pages: z.number().int().min(1).max(10),
  coutCentimes: z.number().int().min(0).default(0),
  createdAt: z.string(),
  docId: z.string().optional(),
  ttl: z.number().int(),
  // Contrat 1.3 (FEAT-A), tous facultatifs: un job cree avant 1.3 reste valide.
  stage: z.enum(['fiche', 'verification']).optional(),
  pagesRead: z.number().int().min(0).max(10).optional(),
  contentTypes: z.array(z.enum(['image/jpeg', 'image/png'])).min(1).max(10).optional(),
  folderId: z.string().optional(),
  suggestedSubject: z.enum(SUBJECTS).optional(),
  suggestedTopic: z.string().max(80).optional(),
  subjectChoice: z.enum(SUBJECTS).optional(),
  topicChoice: z.string().max(80).optional(),
});

/** Fiche (ecrit par L2a). `empreinteMinHash` = 64 entiers (Jaccard sur groupes de 5 mots, seuil 0,85, meme famille). */
export const FicheItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  titre: z.string(),
  matiere: z.enum(SUBJECTS),
  empreinteMinHash: z.array(z.number().int()).length(64),
  pagesConsommees: z.number().int().min(0),
  doublon: z.boolean().default(false),
  createdAt: z.string(),
  // Contrat 1.3 (FEAT-A), facultatifs: une fiche ancienne n'a ni sujet, ni dossier, ni nombre de pages.
  sujet: z.string().max(80).optional(),
  dossierId: z.string().optional(),
  pages: z.number().int().min(1).max(10).optional(),
});

/** Dossier de l'eleve (contrat 1.3). `nomCle` = `labelKey(nom)`: unicite sans casse ni accents. Pas de liste de fiches: l'appartenance est portee par la fiche (`dossierId`). */
export const FolderItemSchema = z.object({
  PK: z.string(),
  SK: z.string().startsWith('FOLDER#'),
  nom: z.string().min(1).max(60),
  nomCle: z.string().min(1),
  createdAt: z.string(),
});

/** QCM (ecrit par L2a). `cle` n'est JAMAIS renvoyee au client avant la reponse. */
export const QcmItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  questionId: QuestionIdSchema,
  enonce: z.string(),
  choix: z.array(z.string()).length(4),
  cle: z.number().int().min(0).max(3),
  claimId: z.string(),
});

/** Trou (ecrit par L2a). La comparaison normalise casse, accents et espaces. */
export const GapItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  questionId: QuestionIdSchema,
  phrase: z.string(),
  attendu: z.string(),
  claimId: z.string(),
});

/** Affirmation (ecrite par L2a aux etapes 5 et 6; jamais modifiee ensuite). */
export const ClaimItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  texte: z.string(),
  origine: z.object({ page: z.number().int().min(1), phraseId: z.string().regex(/^p[0-9]+-s[0-9]+$/), extrait: z.string() }),
  type: z.string(),
  aRisque: z.boolean(),
});

/** Verdict (ecrit par L2b seul). Assemble avec CLAIM# par docs-read (L2a). */
export const VerdictItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  statut: z.enum(['verifiee', 'erreur', 'non_verifiable', 'non_factuelle']),
  niveau: z.number().int().min(1).max(3).optional(),
  secondeLecture: z.boolean().default(false),
  sources: z.array(z.object({ passageId: z.string(), url: z.string(), site: z.string(), titre: z.string(), extrait: z.string(), niveau: z.number().int().min(1).max(3) })),
});

export const SignalementItemSchema = z.object({
  PK: z.string(),
  SK: z.string(),
  docId: z.string(),
  /** Eleve proprietaire de la fiche signalee: le signalement part avec lui (suppression). Absent sur les anciens signalements. */
  studentId: z.string().optional(),
  claimId: z.string().optional(),
  commentaire: z.string().max(500),
  statut: z.enum(['ouvert', 'valide', 'rejete']),
  createdAt: z.string(),
});

/** Interface L2a -> L2b (une seule Lambda `verify-run`). Aucun texte dans l'etat Step Functions. */
export const VerifyInputSchema = z.object({ jobId: z.string(), docId: z.string(), budgetRestantCentimes: z.number().int().min(0) });
export const VerifyOutputSchema = z.object({ coutCentimes: z.number().int().min(0), nbVerifiees: z.number().int().min(0), nbErreurs: z.number().int().min(0), nbNonVerifiables: z.number().int().min(0) });
export type VerifyInput = z.infer<typeof VerifyInputSchema>;
export type VerifyOutput = z.infer<typeof VerifyOutputSchema>;
