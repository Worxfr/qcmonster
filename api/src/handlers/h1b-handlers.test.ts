// H1-B: refus avant tout appel AWS. Parent seul; eleve, compte a deux roles, sans role ou sans famille: 403.
import { describe, expect, it } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';

process.env.QCM_ENV = 'dev';
process.env.TABLE_NAME = 'qcm-dev';
process.env.AWS_REGION = 'eu-west-3';
process.env.AWS_ACCESS_KEY_ID = 'x';
process.env.AWS_SECRET_ACCESS_KEY = 'x';

const progress = (await import('./family-progress.js')).handler;
const archive = (await import('./family-export-archive.js')).handler;
const ev = (groups: string, routeKey: string, extra: Record<string, unknown> = {}, fam = 'fam1') =>
  ({ routeKey, pathParameters: { sid: 's1', testId: 't1' }, requestContext: { authorizer: { jwt: { claims: { sub: 'sub1', 'cognito:username': 'u1', 'cognito:groups': groups, ...(fam !== 'none' ? { 'custom:famille_id': fam } : {}) } } } }, ...extra }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

const PROGRESS_ROUTES = ['GET /students/{sid}/progress', 'GET /students/{sid}/tests', 'GET /students/{sid}/tests/{testId}'];

describe('family-progress: parent seul', () => {
  it.each(PROGRESS_ROUTES)('%s: eleve, deux roles, sans role, parent sans famille: 403', async (route) => {
    for (const [g, fam] of [['[eleve]', 'fam1'], ['[parent eleve]', 'fam1'], ['', 'fam1'], ['[parent]', 'none']] as const) {
      expect((await progress(ev(g, route, {}, fam))).statusCode, `${g}/${fam}`).toBe(403);
    }
  });
  it('sid ou testId invalides: 400; route inconnue: 404', async () => {
    expect((await progress(ev('[parent]', 'GET /students/{sid}/progress', { pathParameters: { sid: '../x' } }))).statusCode).toBe(400);
    expect((await progress(ev('[parent]', 'GET /students/{sid}/tests/{testId}', { pathParameters: { sid: 's1', testId: 'a b' } }))).statusCode).toBe(400);
    expect((await progress(ev('[parent]', 'GET /autre'))).statusCode).toBe(404);
  });
});

describe('family-export-archive: parent seul', () => {
  it('eleve, deux roles, sans role, parent sans famille: 403; autre route: 404', async () => {
    for (const [g, fam] of [['[eleve]', 'fam1'], ['[parent eleve]', 'fam1'], ['', 'fam1'], ['[parent]', 'none']] as const) {
      expect((await archive(ev(g, 'POST /family/export/archive', {}, fam))).statusCode, `${g}/${fam}`).toBe(403);
    }
    expect((await archive(ev('[parent]', 'GET /autre'))).statusCode).toBe(404);
  });
});
