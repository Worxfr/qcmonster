// Cles DynamoDB (docs/data-model.md). Seul le lot 1 modifie ce fichier.
import { createHash } from 'node:crypto';
import type { Env } from '../names.js';

export interface Key {
  PK: string;
  SK: string;
}

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

export const keys = {
  family: (fid: string): Key => ({ PK: `FAMILY#${fid}`, SK: 'META' }),
  student: (fid: string, sid: string): Key => ({ PK: `FAMILY#${fid}`, SK: `STUDENT#${sid}` }),
  /** Reservation du surnom dans la famille (ID1): `nom` = `nameKey()` de shared/pseudo-rules. Ecrite avec `absent` dans la meme ecriture que l'eleve; porte `studentId`. */
  name: (fid: string, nom: string): Key => ({ PK: `FAMILY#${fid}`, SK: `NAME#${nom}` }),
  quota: (fid: string, month: string, sid: string): Key => ({ PK: `FAMILY#${fid}`, SK: `QUOTA#${month}#${sid}` }),
  quotaFamily: (fid: string, month: string): Key => ({ PK: `FAMILY#${fid}`, SK: `QUOTA#${month}#FAMILY` }),
  job: (sid: string, jobId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `JOB#${jobId}` }),
  text: (jobId: string, page: number): Key => ({ PK: `JOB#${jobId}`, SK: `TEXT#${page}` }),
  /** Blocs et metadonnees de figures d'un job (R1), TTL 7 jours comme `TEXT#`. Ecrit par `transcribe` seul. */
  jobBlocks: (jobId: string): Key => ({ PK: `JOB#${jobId}`, SK: 'BLOCKS' }),
  /** Blocs et figures conserves du cours (R1), dans la partition de l'eleve; ecrit par `jobs-confirm` seul, vit autant que le cours. */
  coursBlocks: (sid: string, coursId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `COURS#${coursId}#B` }),
  /** Demande d'export de l'eleve (R1, asynchrone): etat et lien, TTL 2 jours. Ecrit par `me-export` et par la fonction de construction. */
  exportJob: (sid: string, exportId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `EXPORT#${exportId}` }),
  doc: (sid: string, docId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `DOC#${docId}` }),
  /** Cours complet conserve (contrat 1.3): en-tete et texte par page, dans la partition de l'eleve (supprimes avec lui par deleteStudentTree). */
  cours: (sid: string, coursId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `COURS#${coursId}` }),
  coursText: (sid: string, coursId: string, page: number): Key => ({ PK: `STUDENT#${sid}`, SK: `COURS#${coursId}#T${String(page).padStart(2, '0')}` }),
  /** Dossier de l'eleve (contrat 1.3). Ecrit par le lot back FEAT-A (folders-api) seul. */
  folder: (sid: string, folderId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `FOLDER#${folderId}` }),
  claim: (docId: string, nn: number): Key => ({ PK: `DOC#${docId}`, SK: `CLAIM#${String(nn).padStart(2, '0')}` }),
  qcm: (docId: string, nn: number): Key => ({ PK: `DOC#${docId}`, SK: `QCM#${String(nn).padStart(2, '0')}` }),
  gap: (docId: string, nn: number): Key => ({ PK: `DOC#${docId}`, SK: `GAP#${String(nn).padStart(2, '0')}` }),
  /** Verdict de verification d'une affirmation (ecrit par L2b seul; CLAIM# est ecrit par L2a seul). */
  verdict: (docId: string, nn: number): Key => ({ PK: `DOC#${docId}`, SK: `VERDICT#${String(nn).padStart(2, '0')}` }),
  /** Signalement d'une erreur de fiche (ecrit par L2a via docs-report, traite par L3). */
  report: (familyId: string, reportId: string): Key => ({ PK: `FAMILY#${familyId}`, SK: `REPORT#${reportId}` }),
  /** Compteur de transcriptions du jour (plafond 10), ecrit par L2a. */
  transcriptions: (sid: string, date: string): Key => ({ PK: `STUDENT#${sid}`, SK: `TRANSCR#${date}` }),
  passage: (hash: string): Key => ({ PK: `PASSAGE#${hash}`, SK: 'META' }),
  claimCache: (fingerprint: string): Key => ({ PK: `CLAIMCACHE#${fingerprint}`, SK: 'META' }),
  profile: (sid: string): Key => ({ PK: `STUDENT#${sid}`, SK: 'PROFILE' }),
  day: (sid: string, date: string): Key => ({ PK: `STUDENT#${sid}`, SK: `DAY#${date}` }),
  attempt: (sid: string, questionId: string, date: string): Key => ({ PK: `STUDENT#${sid}`, SK: `ATT#${questionId}#${date}` }),
  /** Passage de test (H1): `startedAt` = aaaa-mm-jjThh:mm:ssZ (UTC), `testId` = ULID. Ecrit par answers-post seul; sans ttl (conserve jusqu'a suppression). */
  test: (sid: string, startedAt: string, testId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `TEST#${startedAt}#${testId}` }),
  week: (fid: string, week: string, sid: string): Key => ({ PK: `FAMILY#${fid}`, SK: `WEEK#${week}#${sid}` }),
  cost: (env: Env, month: string): Key => ({ PK: `COST#${env}`, SK: `MONTH#${month}` }),
  /** Cumul depuis le debut de la phase dev (plafond d'essais de 100 EUR, jamais remis a zero). */
  costTotal: (env: Env): Key => ({ PK: `COST#${env}`, SK: 'TOTAL' }),
  /** code = code d'invitation en clair; seul son hache est stocke. */
  invite: (code: string): Key => ({ PK: `INVITE#${sha256(code)}`, SK: 'META' }),
  /** Compteur et audit des codes crees par un administrateur: un element par code et par jour (n = 1..limite). actor = hache du `sub`, jamais le code. */
  inviteAudit: (actor: string, date: string, n: number): Key => ({ PK: `INVITE#AUDIT#${actor}#${date}`, SK: `N#${String(n).padStart(2, '0')}` }),
  // --- E1 (exercices de raisonnement et correction de copie, docs/E1-design.md section 2). Aucune table ni index nouveau.
  /** Exercice pret et valide, ecrit par `exo-gen` seul (attribute_not_exists). `nn` sur 2 chiffres, jamais reutilise. */
  exo: (docId: string, nn: number): Key => ({ PK: `DOC#${docId}`, SK: `EXO#${String(nn).padStart(2, '0')}` }),
  /** Progression de l'eleve sur un exercice, creee par `exo-post` des la demande de generation. */
  exop: (sid: string, docId: string, nn: number): Key => ({ PK: `STUDENT#${sid}`, SK: `EXOP#${docId}:${String(nn).padStart(2, '0')}` }),
  copie: (sid: string, copieId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `COPIE#${copieId}` }),
  /** Pages de copie du mois, par partition (eleve ou famille). `ttl` 40 jours. Quota SEPARE de celui des scans. */
  copieQ: (pk: string, month: string): Key => ({ PK: pk, SK: `COPIEQ#${month}` }),
  /** Compteurs du jour (corrections, generations), `ttl` 2 jours. */
  copieJ: (sid: string, day: string): Key => ({ PK: `STUDENT#${sid}`, SK: `COPIEJ#${day}` }),
  /** Verrou: la copie `a_envoyer` de l'eleve (une seule). */
  copieOuv: (sid: string): Key => ({ PK: `STUDENT#${sid}`, SK: 'COPIEOUV' }),
  /** Verrou: la correction en cours de l'eleve (une seule). */
  copieActive: (sid: string): Key => ({ PK: `STUDENT#${sid}`, SK: 'COPIEACTIVE' }),
  // --- M1 #90 (docs/M1-design.md 4 et 6): modification d'un cours confirme. Aucune table ni index nouveau.
  /** Compteurs du jour de l'eleve: `n` (modifications) et `c_<coursId>` (par cours). `ttl` 2 jours. Ecrit par `revise-create` seul. */
  revDay: (sid: string, day: string): Key => ({ PK: `STUDENT#${sid}`, SK: `REVJ#${day}` }),
  /** Cout du mois (micro-euros, reserve puis cout reel), par eleve. `ttl` 40 jours. */
  revMonth: (sid: string, month: string): Key => ({ PK: `STUDENT#${sid}`, SK: `REVM#${month}` }),
  /** Cout du mois (micro-euros), par famille. `ttl` 40 jours. */
  revFamily: (fid: string, month: string): Key => ({ PK: `FAMILY#${fid}`, SK: `REVQ#${month}` }),
  /** Requete d'une modification, sous le job (`JOB#<revisionId>`): `ttl` 7 jours, supprimee a la fin. */
  revChanges: (revisionId: string): Key => ({ PK: `JOB#${revisionId}`, SK: 'CHANGES' }),
  // --- S1 #34 (docs/S1-design.md 6): partage de QCM par lien. Aucune table ni index nouveau. `hash` = SHA-256 du jeton (hexadecimal), jamais le jeton.
  /** Copie figee publique (`META`), lue par `shares-open`. Partition a part: le role public ne lit que `SHARE#*`. */
  share: (hash: string): Key => ({ PK: `SHARE#${hash}`, SK: 'META' }),
  /** Compteur de lectures du jour d'un lien (`n`), `ttl` = echeance du lien + 2 jours. Ecrit par `shares-open` seul. */
  shareDay: (hash: string, day: string): Key => ({ PK: `SHARE#${hash}`, SK: `DAY#${day}` }),
  /** Signalement d'un destinataire (motif seulement), `ttl` 30 jours. */
  shareReport: (hash: string, reportId: string): Key => ({ PK: `SHARE#${hash}`, SK: `REPORT#${reportId}` }),
  /** Reference du lien chez l'eleve, emplacement `k` de 1 a 5. Pas de jeton. */
  shareRef: (sid: string, k: number): Key => ({ PK: `STUDENT#${sid}`, SK: `SHAREREF#${k}` }),
  /** Emplacement famille `k` de 1 a 10 (plafond de liens actifs par famille). */
  shareSlot: (fid: string, k: number): Key => ({ PK: `FAMILY#${fid}`, SK: `SHARESLOT#${k}` }),
  /** Compteur de creations du jour de l'eleve (`n`, plafond 10), `ttl` 2 jours. */
  shareCreateDay: (sid: string, day: string): Key => ({ PK: `STUDENT#${sid}`, SK: `SHAREJ#${day}` }),
  /** Jeton d'activation en clair; seul son hache est stocke. */
  activation: (token: string): Key => ({ PK: `ACTIVATION#${sha256(token)}`, SK: 'META' }),
};

/** GSI1: lister les fiches de la famille cote parent, sans le texte du cours. */
export const gsi1 = {
  name: 'GSI1',
  doc: (fid: string, date: string) => ({ GSI1PK: `FAMILY#${fid}`, GSI1SK: `DOC#${date}` }),
};

/** Mois au format aaaa-mm, fuseau Europe/Paris (remise a zero des quotas le 1er). */
export const monthParis = (d: Date = new Date()): string => {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)!.value;
  return `${get('year')}-${get('month')}`;
};
