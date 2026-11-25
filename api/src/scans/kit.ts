// Outils de test du lot B2: deux familles, trois eleves, evenements avec route et parametres. Aucun reseau.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import { goodScript, makeCtx } from '../pipeline/testkit.js';

/** f1: parent `sub-p`, eleves s1 (`sub-s1`) et s3 (`sub-s3`). f2: parent `sub-p2`, eleve s9 (`sub-s9`). */
export async function world() {
  const t = await makeCtx(goodScript());
  await t.db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s3', cognitoSub: 'sub-s3', statut: 'actif' });
  await t.db.put({ PK: 'FAMILY#f2', SK: 'META' });
  await t.db.put({ PK: 'FAMILY#f2', SK: 'STUDENT#s9', cognitoSub: 'sub-s9', statut: 'actif' });
  return t;
}
export type World = Awaited<ReturnType<typeof world>>;

export const WHO = {
  s1: { sub: 'sub-s1', family: 'f1', groups: '[eleve]' },
  s3: { sub: 'sub-s3', family: 'f1', groups: '[eleve]' },
  s9: { sub: 'sub-s9', family: 'f2', groups: '[eleve]' },
  p1: { sub: 'sub-p', family: 'f1', groups: '[parent]' },
  p2: { sub: 'sub-p2', family: 'f2', groups: '[parent]' },
} as const;

export function ev(who: keyof typeof WHO, routeKey: string, o: { params?: Record<string, string>; query?: Record<string, string>; body?: unknown } = {}): APIGatewayProxyEventV2 {
  const w = WHO[who];
  return {
    routeKey,
    pathParameters: o.params,
    queryStringParameters: o.query,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: w.sub, 'custom:famille_id': w.family, 'cognito:groups': w.groups } } } },
  } as unknown as APIGatewayProxyEventV2;
}

export const body = (r: { body?: string }) => JSON.parse(r.body ?? 'null');

type Rec = Record<string, unknown>;
export const putDoc = (t: World, sid: string, id: string, f: Rec = {}) =>
  t.db.put({ PK: `STUDENT#${sid}`, SK: `DOC#${id}`, titre: `Fiche ${id}`, matiere: 'svt', createdAt: '2026-11-30T10:00:00.000Z', resume: 'RESUME-SECRET', empreinteMinHash: [1, 2, 3], ...f });
export const putJob = (t: World, sid: string, id: string, f: Rec = {}) => t.db.put({ PK: `STUDENT#${sid}`, SK: `JOB#${id}`, state: 'transcription', pages: 1, createdAt: '2026-12-01T09:00:00.000Z', ...f });
export const putFolder = (t: World, sid: string, id: string, nom: string) => t.db.put({ PK: `STUDENT#${sid}`, SK: `FOLDER#${id}`, nom, nomCle: nom.toLowerCase(), createdAt: '2026-11-01T00:00:00.000Z' });
