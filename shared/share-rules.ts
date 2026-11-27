// Regles pures du partage de QCM (S1 #34, docs/S1-design.md sections 2 et 9). Aucune horloge, aucun acces a la base, aucun module Node: importable par l'API et par le site.
// Un SEUL filtre de donnees personnelles pour le titre et pour chaque champ de texte de la copie (`prompt`, chaque choix, `expected`, `subject`, `title`).
import { hasBlockedWord } from './pseudo-rules.js';

export const SHARE_MIN_QUESTIONS = 5;
export const SHARE_MAX_QUESTIONS = 20;
export const SHARE_TITLE_MIN = 3;
export const SHARE_TITLE_MAX = 60;
export const SHARE_TTL_DAYS = [1, 7, 30] as const;
export const SHARE_DEFAULT_TTL_DAYS = 7;
export const SHARE_PER_STUDENT = 5;
export const SHARE_PER_FAMILY = 10;
export const SHARE_CREATES_PER_DAY = 10;
export const SHARE_READS_PER_DAY = 1000;
export const SHARE_REPORTS_TO_SUSPEND = 3;
export const SHARE_REPORT_REASONS = ['inapproprie', 'donnees_perso', 'autre'] as const;
/** `ttl` DynamoDB = echeance + 2 jours: DynamoDB peut supprimer jusqu'a 48 h apres; `expiresAt` est controle par le code (design 4). */
export const SHARE_TTL_GRACE_S = 2 * 86_400;
export const SHARE_REPORT_TTL_S = 30 * 86_400;

/** Jeton de 128 bits en base64url (22 caracteres). Verifie AVANT tout hachage et tout acces a la table. */
export const SHARE_TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;

const CF = /\p{Cf}/gu;
const CC = /[\p{Cc}\u2028\u2029]/gu;
/** Texte normalise pour les controles: signes invisibles retires, NFKC (pleine largeur, ligatures), sans accents, minuscules, controles en espace simple. */
export function normalizeForFilter(raw: string): string {
  const noCf = raw.replace(CF, '').normalize('NFKC').replace(CF, '');
  return noCf.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase().replace(CC, ' ').replace(/\s+/g, ' ');
}

const wordsOf = (norm: string): string[] => norm.split(/[^\p{L}\p{Nd}]+/u).filter(Boolean);

export interface FilterContext {
  /** Pseudo, identifiant de connexion et surnom de TOUS les eleves de la famille. Comparaison en MOT ENTIER apres normalisation; moins de 3 lettres: pas compare. */
  names: string[];
}
export type FilterReason = 'email' | 'web' | 'telephone' | 'nom' | 'adresse';

const EMAIL = /@|\(\s*at\s*\)|\[\s*at\s*\]|\{\s*at\s*\}|\barobase\b|\b(at|arobase)\b.{0,30}\b(dot|point)\b/;
const WEB = /https?|www\.|:\/\/|\.(fr|com|net|org)\b|\b(dot|point)\s+(fr|com|net|org)\b/;
/** Groupes de chiffres separes par UN seul caractere (espace, point, tiret, parenthese): « 06 12 34 56 78 », « 06.12.34.56.78 ». */
const DIGIT_RUN = /\+?[(]?\p{Nd}+[)]?(?:[ .-][(]?\p{Nd}+[)]?)*/gu;
const POSTAL = /\b\d{1,4}\s*(?:bis|ter)?\s*,?\s*(?:rue|avenue|av|boulevard|bd|chemin|allee|impasse|place)\b|\b\d{5}\s+\p{L}{2,}/u;

const digitsOf = (run: string): number => (run.match(/\p{Nd}/gu) ?? []).length;

/**
 * Premiere donnee personnelle trouvee dans `raw`, ou `null`.
 * - e-mail: `@` ou « (at) »; adresse web: `http`, `www.`, `://`, `.fr/.com/.net/.org`;
 * - telephone: dans une suite de groupes de chiffres separes par UN espace, point ou tiret, 6 chiffres ou plus (une date, une annee ou un nombre de 5 chiffres ou moins reste permis);
 * - nom: un pseudo, un identifiant ou un surnom de la famille, en mot entier (« leo » ne refuse pas « leopard »);
 * - adresse postale (`postal: true`, le titre): un nombre suivi de rue, avenue…, ou un code postal de 5 chiffres suivi d'un mot.
 * shortcut: un nom propre ou d'ecole n'est pas detecte; un grand nombre ecrit avec des espaces (12 000 000) est refuse (cote prudent). A revoir avec de vraies questions.
 */
export function personalData(raw: string, ctx: FilterContext, opts: { postal?: boolean } = {}): FilterReason | null {
  const norm = normalizeForFilter(raw);
  if (EMAIL.test(norm)) return 'email';
  if (WEB.test(norm)) return 'web';
  for (const m of norm.matchAll(DIGIT_RUN)) if (digitsOf(m[0]) >= 6) return 'telephone';
  const words = ` ${wordsOf(norm).join(' ')} `;
  for (const n of ctx.names) {
    const w = wordsOf(normalizeForFilter(n));
    if (w.join('').replace(/[^\p{L}]/gu, '').length < 3) continue; // pseudo trop court: trop de faux positifs (limite dite)
    if (words.includes(` ${w.join(' ')} `)) return 'nom';
  }
  if (opts.postal && POSTAL.test(norm)) return 'adresse';
  return null;
}

/** Base d'un identifiant de connexion `lila-k7x2p` (sans le suffixe aleatoire): comparee elle aussi. */
export const loginBase = (loginId: string): string => /^(.+)-[a-z0-9]{4,5}$/i.exec(loginId)?.[1] ?? loginId;

const TITLE_FORM = /^\p{Script=Latin}[\p{Script=Latin}0-9 '’\-,.:;?!()%+=/&]*$/u;
export type TitleResult = { ok: true; value: string } | { ok: false };

/** Titre ecrit par l'eleve: forme, liste de mots du pseudo ET filtre de donnees personnelles (adresse postale comprise). Renvoie la valeur nettoyee. */
export function checkTitle(raw: string, ctx: FilterContext): TitleResult {
  const value = raw.normalize('NFKC').trim().replace(/\s+/g, ' ');
  const len = [...value].length;
  if (len < SHARE_TITLE_MIN || len > SHARE_TITLE_MAX) return { ok: false };
  if (!TITLE_FORM.test(value) || /[\p{Cf}\p{Cc}\p{M}]/u.test(value)) return { ok: false };
  if (hasBlockedWord(value)) return { ok: false };
  if (personalData(value, ctx, { postal: true })) return { ok: false };
  return { ok: true, value };
}

/** Une question est refusee des qu'UN de ses textes (enonce, chaque choix, mot attendu) contient une donnee personnelle. */
export function questionClean(q: { prompt: string; choices?: readonly string[]; expected?: string }, ctx: FilterContext): boolean {
  return [q.prompt, ...(q.choices ?? []), ...(q.expected !== undefined ? [q.expected] : [])].every((t) => personalData(t, ctx) === null);
}

export type ShareableReason = 'a_jouer' | 'retiree';
/**
 * Partageable: non retiree (M1) ET (ligne `ATT#<questionId>#` `rewarded`, OU fiche deja a 50 points payes). Evite de lire la cle avant d'avoir joue (S1-P5).
 * `donnee_personnelle` est decidee a part (`questionClean`).
 */
export function shareableReason(q: { retiree?: boolean }, rewarded: boolean, docFull: boolean): ShareableReason | null {
  if (q.retiree === true) return 'retiree';
  return rewarded || docFull ? null : 'a_jouer';
}

export const ttlDaysOk = (n: unknown): n is (typeof SHARE_TTL_DAYS)[number] => (SHARE_TTL_DAYS as readonly unknown[]).includes(n);
