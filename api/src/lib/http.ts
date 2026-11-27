// Utilitaires HTTP communs aux handlers L3: identite tiree du JETON (jamais du corps), erreurs du contrat, reponses JSON.
// Aucun corps de requete n'est journalise (activation: jeton et mot de passe).
import type { APIGatewayProxyEventV2WithJWTAuthorizer, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { ZodType } from 'zod';
import { log } from '../../../shared/log/index.js';
import { PSEUDO_REFUSED_MESSAGE, PSEUDO_TAKEN_MESSAGE } from '../../../shared/pseudo-rules.js';

export type ErrorCode = 'erreur_interne' | 'requete_invalide' | 'interdit' | 'introuvable' | 'etat_invalide' | 'quota_epuise' | 'budget_epuise' | 'aucune_question' | 'pseudo_refuse' | 'pseudo_pris' | 'matiere_non_prevue' | 'plafond_exercices' | 'fiche_trop_courte' | 'pas_encore' | 'trop_tot' | 'deja_en_cours' | 'quota_copies' | 'plafond_copies' | 'copie_deja_rendue' | 'solution_vue' | 'en_correction' | 'titre_refuse' | 'questions_non_partageables' | 'plafond_partages' | 'lien_indisponible';

/** Erreur attendue, convertie en reponse du contrat. Toute autre erreur est journalisee (code seul) puis devient un 500 generique: rien n'est relance, donc le runtime Lambda ne journalise ni message ni pile (A4). */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly resetDate?: string,
  ) {
    super(message);
  }
}
export const badRequest = (m = 'Requête invalide') => new HttpError(400, 'requete_invalide', m);
export const forbidden = (m = 'Accès refusé') => new HttpError(403, 'interdit', m);
export const notFound = () => new HttpError(404, 'introuvable', 'Introuvable');
export const pseudoRefuse = () => new HttpError(400, 'pseudo_refuse', PSEUDO_REFUSED_MESSAGE);
export const pseudoPris = () => new HttpError(409, 'pseudo_pris', PSEUDO_TAKEN_MESSAGE);
export const conflict = (m = 'État incompatible') => new HttpError(409, 'etat_invalide', m);

export type Role = 'parent' | 'eleve';
export interface Auth {
  /** `sub` Cognito. */
  sub: string;
  /** Nom d'utilisateur Cognito: pour un eleve c'est son `studentId` (choisi par le serveur a la creation). */
  username: string;
  role?: Role;
  /** Claim `email` du jeton d'identite (parent seulement: les eleves n'ont pas d'adresse reelle). */
  email?: string;
  /** Attribut `custom:famille_id`; absent tant que la famille n'est pas creee (jeton emis avant `POST /family`). */
  familyId?: string;
  /** Vrai si le jeton porte `eleve` ET `parent`: compte incoherent, refuse partout (y compris pour creer une famille). */
  conflicting?: true;
}

/** `cognito:groups` arrive en tableau ou en chaine (« [parent] ») selon l'API: les deux formes sont lues. */
export function parseGroups(raw: unknown): string[] {
  if (Array.isArray(raw)) return raw.map(String);
  if (typeof raw !== 'string') return [];
  return raw.replace(/^\[|\]$/g, '').split(/[\s,]+/).filter(Boolean);
}

export function authOf(event: APIGatewayProxyEventV2WithJWTAuthorizer): Auth {
  const c = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const sub = typeof c.sub === 'string' ? c.sub : '';
  if (!sub) throw forbidden();
  const groups = parseGroups(c['cognito:groups']);
  // Un compte dans les deux groupes n'a pas de role: refuse partout.
  const role: Role | undefined = groups.includes('parent') && !groups.includes('eleve') ? 'parent' : groups.includes('eleve') && !groups.includes('parent') ? 'eleve' : undefined;
  const fid = c['custom:famille_id'];
  const username = typeof c['cognito:username'] === 'string' ? c['cognito:username'] : typeof c.username === 'string' ? c.username : '';
  const email = typeof c.email === 'string' && role === 'parent' ? c.email : undefined;
  const conflicting = groups.includes('parent') && groups.includes('eleve');
  return { sub, username, role, ...(conflicting ? { conflicting: true as const } : {}), ...(email ? { email } : {}), familyId: typeof fid === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(fid) ? fid : undefined };
}

export interface ParentCtx {
  sub: string;
  username: string;
  email?: string;
  familyId: string;
}
export interface StudentCtx {
  sub: string;
  studentId: string;
  familyId: string;
}

const ID = /^[A-Za-z0-9_-]{1,64}$/;
export function requireParent(a: Auth): ParentCtx {
  if (a.role !== 'parent' || !a.familyId) throw forbidden('Réservé au parent');
  return { sub: a.sub, username: a.username, ...(a.email ? { email: a.email } : {}), familyId: a.familyId };
}
export function requireStudent(a: Auth): StudentCtx {
  if (a.role !== 'eleve' || !a.familyId || !ID.test(a.username)) throw forbidden('Reserve a l\'eleve');
  return { sub: a.sub, studentId: a.username, familyId: a.familyId };
}

/**
 * Administrateur du site: le jeton porte le groupe `admin` (lu cote serveur, jamais depuis le corps). Un compte eleve ne l'est jamais.
 * Refus: 403 generique, identique pour parent, eleve et jeton sans groupe.
 */
export function requireAdmin(event: APIGatewayProxyEventV2WithJWTAuthorizer): { sub: string } {
  const c = (event.requestContext.authorizer?.jwt?.claims ?? {}) as Record<string, unknown>;
  const groups = parseGroups(c['cognito:groups']);
  if (typeof c.sub !== 'string' || !c.sub || !groups.includes('admin') || groups.includes('eleve')) throw forbidden();
  return { sub: c.sub };
}

/** Parametre de chemin valide (meme forme que les identifiants du contrat). */
export function pathId(event: APIGatewayProxyEventV2WithJWTAuthorizer | { pathParameters?: Record<string, string | undefined> }, name: string): string {
  const v = event.pathParameters?.[name];
  if (typeof v !== 'string' || !ID.test(v)) throw badRequest();
  return v;
}

/** Corps JSON valide par un schema Zod du contrat. Le contenu n'est jamais repris dans le message d'erreur. */
export function parseBody<T>(event: { body?: string; isBase64Encoded?: boolean }, schema: ZodType<T>): T {
  if (typeof event.body !== 'string' || event.body.length === 0 || event.body.length > 4096) throw badRequest();
  let data: unknown;
  try {
    data = JSON.parse(event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body);
  } catch {
    throw badRequest();
  }
  const r = schema.safeParse(data);
  if (!r.success) throw badRequest();
  return r.data;
}

export const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
export const noContent = (): APIGatewayProxyStructuredResultV2 => ({ statusCode: 204, headers: { 'cache-control': 'no-store' } });

/** Enveloppe d'un handler: HttpError -> reponse du contrat; le reste est journalise (champs techniques seulement) puis repond 500 generique. */
export function wrap(step: string, fn: (event: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<APIGatewayProxyStructuredResultV2>) {
  return async (event: APIGatewayProxyEventV2WithJWTAuthorizer): Promise<APIGatewayProxyStructuredResultV2> => {
    const t0 = Date.now();
    try {
      const r = await fn(event);
      log({ step, status: 'ok', durationMs: Date.now() - t0 });
      return r;
    } catch (e) {
      if (e instanceof HttpError) {
        log({ step, status: 'rejected', durationMs: Date.now() - t0 });
        return json(e.status, { code: e.code, message: e.message, ...(e.resetDate ? { resetDate: e.resetDate } : {}) });
      }
      const name = e instanceof Error ? e.name : '';
      log({ step, status: 'error', durationMs: Date.now() - t0, errorCode: /^[A-Za-z0-9]{1,64}$/.test(name) ? name : 'Unknown' });
      return json(500, { code: 'erreur_interne' satisfies ErrorCode, message: 'Erreur interne' });
    }
  };
}
