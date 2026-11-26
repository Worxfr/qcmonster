// Branchement des 13 Lambda: chaque handler repond sans appeler AWS quand le role est mauvais ou le corps invalide.
import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2, APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

process.env.QCM_ENV = 'dev';
process.env.TABLE_NAME = 'qcm-dev';
process.env.USER_POOL_ID = 'pool-test';
process.env.WEB_ORIGIN = 'https://front.example.invalid';
process.env.SCANS_BUCKET = 'bucket-test';
process.env.AWS_REGION = 'eu-west-3';
process.env.AWS_ACCESS_KEY_ID = 'x';
process.env.AWS_SECRET_ACCESS_KEY = 'x';

type H = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<{ statusCode: number; body?: string }>;
const load = async (name: string) => ((await import(`./${name}.js`)) as { handler: H }).handler;
const ev = (groups: string, routeKey: string, extra: Record<string, unknown> = {}) =>
  ({ routeKey, pathParameters: { docId: 'd1', sid: 's1', id: 'r1' }, requestContext: { authorizer: { jwt: { claims: { sub: 'sub1', 'cognito:username': 'u1', 'cognito:groups': groups, 'custom:famille_id': 'fam1' } } } }, ...extra }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('handlers: refus avant tout appel AWS', () => {
  const asParent = (k: string) => ev('[parent]', k, { body: '{}' });
  const asStudent = (k: string) => ev('[eleve]', k, { body: '{}' });
  it.each([
    ['session-get', 'GET /docs/{docId}/session'],
    ['answers-post', 'POST /answers'],
    ['docs-mark-read', 'POST /docs/{docId}/read'],
    ['me-get', 'GET /me/progress'],
  ])('%s: un parent est refuse (403)', async (name, route) => {
    expect((await (await load(name))(asParent(route))).statusCode).toBe(403);
  });
  it.each([
    ['reports-validate', 'POST /reports/{id}/validate'],
    ['students-create', 'POST /students'],
    ['students-link', 'POST /students/{sid}/activation-link'],
    ['students-update', 'PATCH /students/{sid}'],
    ['students-delete', 'DELETE /students/{sid}'],
    ['family-admin', 'GET /family/export'],
    ['family-admin', 'DELETE /family'],
    ['family-create', 'POST /family/policy'],
    ['family-read', 'GET /family/dashboard'],
    ['students-login-id-post', 'POST /students/{sid}/login-id'],
  ])('%s %s: un eleve est refuse (403)', async (name, route) => {
    expect((await (await load(name))(asStudent(route))).statusCode).toBe(403);
  });
  it('family-create: un eleve est refuse; family-read leaderboard sans role: 403', async () => {
    expect((await (await load('family-create'))(asStudent('POST /family'))).statusCode).toBe(403);
    expect((await (await load('family-read'))(ev('', 'GET /family/leaderboard'))).statusCode).toBe(403);
  });
  it('routes inconnues: 404', async () => {
    expect((await (await load('me-get'))(asParent('GET /autre'))).statusCode).toBe(404);
    expect((await (await load('family-read'))(asParent('GET /autre'))).statusCode).toBe(404);
    expect((await (await load('family-admin'))(asParent('GET /autre'))).statusCode).toBe(404);
    // GET /me d'un parent lit la famille (policyOutdated, H1-W): couvert sans AWS par getMe dans family.test.ts et h1-policy.test.ts.
  });
  it('jeton sans sub: 403; identifiant de chemin invalide: 400', async () => {
    const noSub = { requestContext: { authorizer: { jwt: { claims: {} } } } } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;
    expect((await (await load('me-get'))(noSub)).statusCode).toBe(403);
    const bad = ev('[eleve]', 'GET /docs/{docId}/session', { pathParameters: { docId: '../x' } });
    expect((await (await load('session-get'))(bad)).statusCode).toBe(400);
  });
  it('activation-post (publique): corps invalide = 400 sans appel AWS, et le corps n\'est jamais renvoye', async () => {
    const h = (await import('./activation-post.js')).handler as (e: APIGatewayProxyEventV2) => Promise<{ statusCode: number; body?: string }>;
    const r = await h({ body: JSON.stringify({ token: 'court', password: 'MotDePasse-Secret-1' }) } as APIGatewayProxyEventV2);
    expect(r.statusCode).toBe(400);
    expect(r.body).not.toContain('Secret');
    expect((await h({} as APIGatewayProxyEventV2)).statusCode).toBe(400);
  });
});
