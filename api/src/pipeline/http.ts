// Reponses HTTP et identification de l'appelant (jeton JWT valide par API Gateway; ici on lit seulement ses claims).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import type { Ctx } from './ctx.js';
import { ID_RE } from './ctx.js';

export type ErrorCode = 'requete_invalide' | 'interdit' | 'introuvable' | 'etat_invalide' | 'quota_epuise' | 'budget_epuise';
const STATUS: Record<ErrorCode, number> = { requete_invalide: 400, interdit: 403, introuvable: 404, etat_invalide: 409, quota_epuise: 429, budget_epuise: 429 };

export class HttpError extends Error {
  constructor(readonly code: ErrorCode, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}
export const fail = (code: ErrorCode, message: string, extra: Record<string, unknown> = {}): never => {
  throw new HttpError(code, message, extra);
};

export const json = (statusCode: number, body: unknown): APIGatewayProxyStructuredResultV2 => ({
  statusCode,
  headers: { 'content-type': 'application/json', 'cache-control': 'no-store' },
  body: JSON.stringify(body),
});
export const noContent = (): APIGatewayProxyStructuredResultV2 => ({ statusCode: 204 });

export const errorResponse = (e: HttpError): APIGatewayProxyStructuredResultV2 => json(STATUS[e.code], { code: e.code, message: e.message, ...e.extra });

type H = (ctx: Ctx, e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;
/** Les erreurs metier (HttpError) deviennent des reponses du contrat; les autres remontent. */
export const guarded = (h: H): H => async (ctx, e) => {
  try {
    return await h(ctx, e);
  } catch (err) {
    if (err instanceof HttpError) return errorResponse(err);
    throw err;
  }
};

export interface Caller {
  sub: string;
  familyId: string;
  role: 'parent' | 'eleve';
  /** Eleve seulement. */
  studentId?: string;
}

type Claims = Record<string, unknown>;
const claimsOf = (e: APIGatewayProxyEventV2): Claims => ((e.requestContext as { authorizer?: { jwt?: { claims?: Claims } } }).authorizer?.jwt?.claims ?? {}) as Claims;

/** Groupes Cognito: l'API Gateway les transmet sous la forme `[eleve]` ou `eleve`. */
const hasGroup = (raw: unknown, g: string): boolean => (Array.isArray(raw) ? raw.map(String) : String(raw ?? '').replace(/[[\]]/g, '').split(/[\s,]+/)).includes(g);

/** Identifie l'appelant. Un eleve est retrouve par son `cognitoSub` dans la famille; un eleve suspendu est refuse. */
export async function callerOf(ctx: Ctx, event: APIGatewayProxyEventV2): Promise<Caller> {
  const c = claimsOf(event);
  const sub = typeof c.sub === 'string' ? c.sub : '';
  const familyId = typeof c['custom:famille_id'] === 'string' ? (c['custom:famille_id'] as string) : '';
  // Un seul message pour tous les refus: il ne dit pas si le compte existe, s'il est suspendu ou quel groupe manque.
  const refuse = (): never => fail('interdit', 'Acces refuse');
  if (!sub || !ID_RE.test(familyId)) return refuse();
  const groups = c['cognito:groups'];
  const isParent = hasGroup(groups, 'parent');
  const isStudent = hasGroup(groups, 'eleve');
  if (isParent && isStudent) return refuse(); // deux groupes = aucun role (comme authOf)
  if (isParent) return { sub, familyId, role: 'parent' };
  if (!isStudent) return refuse();
  const students = await ctx.db.query(`FAMILY#${familyId}`, 'STUDENT#');
  const me = students.find((s) => s.cognitoSub === sub);
  if (!me || me.statut === 'suspendu') return refuse();
  return { sub, familyId, role: 'eleve', studentId: me.SK.slice('STUDENT#'.length) };
}

export const requireStudent = (c: Caller): string => c.studentId ?? fail('interdit', "Reserve a l'eleve");

export function pathId(event: APIGatewayProxyEventV2, name: string): string {
  const v = event.pathParameters?.[name];
  return v && ID_RE.test(v) ? v : fail('requete_invalide', 'Identifiant invalide');
}

export function bodyOf(event: APIGatewayProxyEventV2): unknown {
  if (!event.body) return fail('requete_invalide', 'Corps manquant');
  const raw = event.isBase64Encoded ? Buffer.from(event.body, 'base64').toString('utf8') : event.body;
  if (raw.length > 200_000) return fail('requete_invalide', 'Corps trop grand');
  try {
    return JSON.parse(raw);
  } catch {
    return fail('requete_invalide', 'JSON invalide');
  }
}

/** Premier jour du mois suivant (Europe/Paris), aaaa-mm-jj: remise a zero du quota. */
export function resetDate(now: Date): string {
  const p = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit' }).formatToParts(now);
  let y = Number(p.find((x) => x.type === 'year')!.value);
  let m = Number(p.find((x) => x.type === 'month')!.value) + 1;
  if (m === 13) {
    m = 1;
    y++;
  }
  return `${y}-${String(m).padStart(2, '0')}-01`;
}
