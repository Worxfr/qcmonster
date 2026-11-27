// Contexte et petits utilitaires du partage de QCM (S1 #34). Un seul port DynamoDB (`Db` du pipeline: GetItem, Query, PutItem, UpdateItem, transaction, BatchWriteItem);
// l'enregistreur d'acces (access.test.ts) l'enrobe pour verifier « droits declares = droits reels ».
import { createHash, randomBytes } from 'node:crypto';
import { keys } from '../../../shared/ddb/keys.js';
import type { Env } from '../../../shared/names.js';
import { loginBase } from '../../../shared/share-rules.js';
import { HttpError, forbidden, notFound, type StudentCtx } from '../lib/http.js';
import type { Db, Item } from '../pipeline/ports.js';

export interface ShareCtx {
  db: Db;
  env: Env;
  now: () => Date;
  /** Identifiant d'un partage ou d'un signalement (ULID). */
  newId: () => string;
  /** Jeton en clair de 128 bits (22 caracteres base64url). Jamais journalise, jamais stocke. */
  newToken: () => string;
  /** Interrupteur `SHARE_PUBLIC_ENABLED` (ferme par defaut). Ferme: creation refusee (403) et routes publiques `404 lien_indisponible` SANS lecture de table. */
  publicEnabled: boolean;
}

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
/** Identifiant de 26 caracteres trie par date (meme forme que `ulid` du pipeline, recopie pour ne pas charger le client de modele dans une fonction publique). */
export function ulid(now = Date.now()): string {
  let t = now;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = CROCKFORD[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + [...randomBytes(16)].map((b) => CROCKFORD[b % 32]).join('');
}
export const realShareRandom = { newId: () => ulid(), newToken: () => randomBytes(16).toString('base64url') };
export const hashToken = (token: string): string => createHash('sha256').update(token).digest('hex');

/** Reponse unique pour tout lien inutilisable (inconnu, mal forme, expire, revoque, suspendu, plafond du jour, interrupteur ferme). */
export const lienIndisponible = () => new HttpError(404, 'lien_indisponible', "Ce lien n'est plus disponible");
export const titreRefuse = () => new HttpError(400, 'titre_refuse', "Ce titre n'est pas possible, essaie-en un autre");
export const plafondPartages = () => new HttpError(429, 'plafond_partages', 'Trop de liens de partage actifs');
export const nonPartageables = () => new HttpError(409, 'questions_non_partageables', 'Certaines questions ne peuvent pas être partagées');

export const iso = (c: ShareCtx): string => c.now().toISOString();
export const epochS = (c: ShareCtx): number => Math.floor(c.now().getTime() / 1000);
export const dayOf = (c: ShareCtx): string => iso(c).slice(0, 10);
/** Un lien est actif tant que `expiresAt` n'est pas atteint: controle par le CODE (le `ttl` DynamoDB peut tarder 48 h). */
export const isExpired = (it: Record<string, unknown>, c: ShareCtx): boolean => typeof it.expiresAt !== 'string' || it.expiresAt <= iso(c);

/** Eleve actif du jeton (meme regle que `activeStudent`: actif, `sub` enregistre a la creation). */
export async function activeStudentOf(c: ShareCtx, s: StudentCtx): Promise<Item> {
  const it = await c.db.get(keys.student(s.familyId, s.studentId));
  if (!it || it.statut !== 'actif' || it.cognitoSub !== s.sub) throw forbidden();
  return it;
}

/** Eleve de la famille du JETON (parent): jamais celui d'une autre famille (404 indiscernable d'un inconnu). */
export async function studentOfFamily(c: ShareCtx, fid: string, sid: string): Promise<Item> {
  const it = await c.db.get(keys.student(fid, sid));
  if (!it) throw notFound();
  return it;
}

/** Noms de TOUS les eleves de la famille pour le filtre: pseudo, identifiant (et sa base sans suffixe), surnom. */
export async function familyNames(c: ShareCtx, fid: string): Promise<string[]> {
  const out = new Set<string>();
  for (const s of await c.db.query(`FAMILY#${fid}`, 'STUDENT#')) {
    for (const v of [s.pseudo, s.loginId, s.displayName]) if (typeof v === 'string' && v) out.add(v);
    if (typeof s.loginId === 'string') out.add(loginBase(s.loginId));
  }
  return [...out];
}

/** Reference `SHAREREF#k` de l'eleve (au plus 5). */
export const refsOf = async (c: ShareCtx, sid: string): Promise<Item[]> => (await c.db.query(`STUDENT#${sid}`, 'SHAREREF#')).filter((r) => /^SHAREREF#[1-5]$/.test(r.SK));
