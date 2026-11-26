import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

process.env.QCM_ENV = 'dev';
process.env.TABLE_NAME = 'qcm-dev';
process.env.AWS_REGION = 'eu-west-3';
process.env.AWS_ACCESS_KEY_ID = 'x';
process.env.AWS_SECRET_ACCESS_KEY = 'x';

const { handler } = await import('./tests-read.js');
const ev = (groups: string, routeKey: string, extra: Record<string, unknown> = {}) =>
  ({ routeKey, pathParameters: { testId: 't1' }, requestContext: { authorizer: { jwt: { claims: { sub: 'sub1', 'cognito:username': 'u1', 'cognito:groups': groups, 'custom:famille_id': 'fam1' } } } }, ...extra }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('tests-read: refus avant tout appel AWS', () => {
  it.each(['GET /me/tests', 'GET /me/tests/{testId}'])('%s: un parent est refuse (403), jamais de lecture de l\'historique', async (route) => {
    expect((await handler(ev('[parent]', route))).statusCode).toBe(403);
  });
  it('sans role ou compte a deux roles: 403; route inconnue: 404; testId invalide: 400', async () => {
    expect((await handler(ev('', 'GET /me/tests'))).statusCode).toBe(403);
    expect((await handler(ev('[parent eleve]', 'GET /me/tests'))).statusCode).toBe(403);
    expect((await handler(ev('[eleve]', 'GET /autre'))).statusCode).toBe(404);
    expect((await handler(ev('[eleve]', 'GET /me/tests/{testId}', { pathParameters: { testId: '../x' } }))).statusCode).toBe(400);
  });
});
