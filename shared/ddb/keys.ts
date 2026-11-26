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
  quota: (fid: string, month: string, sid: string): Key => ({ PK: `FAMILY#${fid}`, SK: `QUOTA#${month}#${sid}` }),
  quotaFamily: (fid: string, month: string): Key => ({ PK: `FAMILY#${fid}`, SK: `QUOTA#${month}#FAMILY` }),
  job: (sid: string, jobId: string): Key => ({ PK: `STUDENT#${sid}`, SK: `JOB#${jobId}` }),
  text: (jobId: string, page: number): Key => ({ PK: `JOB#${jobId}`, SK: `TEXT#${page}` }),
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
  week: (fid: string, week: string, sid: string): Key => ({ PK: `FAMILY#${fid}`, SK: `WEEK#${week}#${sid}` }),
  cost: (env: Env, month: string): Key => ({ PK: `COST#${env}`, SK: `MONTH#${month}` }),
  /** Cumul depuis le debut de la phase dev (plafond d'essais de 100 EUR, jamais remis a zero). */
  costTotal: (env: Env): Key => ({ PK: `COST#${env}`, SK: 'TOTAL' }),
  /** code = code d'invitation en clair; seul son hache est stocke. */
  invite: (code: string): Key => ({ PK: `INVITE#${sha256(code)}`, SK: 'META' }),
  /** Compteur et audit des codes crees par un administrateur: un element par code et par jour (n = 1..limite). actor = hache du `sub`, jamais le code. */
  inviteAudit: (actor: string, date: string, n: number): Key => ({ PK: `INVITE#AUDIT#${actor}#${date}`, SK: `N#${String(n).padStart(2, '0')}` }),
  /** token = jeton d'activation en clair; seul son hache est stocke. */
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
