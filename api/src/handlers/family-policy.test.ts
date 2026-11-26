// H1-W (M4): le dispatch `POST /family/policy` du handler family-create. Sans lui, la route creerait une famille (ou repondrait 409).
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { POLICY_VERSION } from '../../../shared/policy.js';
import { FID, seed, testDeps } from '../lib/testkit.js';

const t = vi.hoisted(() => ({ env: undefined as unknown }));
vi.mock('./runtime.js', () => ({ familyDeps: () => (t.env as { deps: unknown }).deps }));

type R = { statusCode: number; body?: string };
const call = async (groups: string, routeKey: string, body: unknown): Promise<R> => {
  const { handler } = (await import('./family-create.js')) as { handler: (e: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<R> };
  return handler({
    routeKey,
    body: JSON.stringify(body),
    requestContext: { authorizer: { jwt: { claims: { sub: 'sub-par1', 'cognito:username': 'par1', 'cognito:groups': groups, 'custom:famille_id': FID } } } },
  } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer);
};

describe('family-create: POST /family/policy', () => {
  it('enregistre la version en vigueur (204) au lieu de creer une famille', async () => {
    const env = testDeps();
    t.env = env;
    await seed(env);
    await env.store.commit([{ item: { ...keys.family(FID), ownerSub: 'sub-par1', consentementLe: '2026-11-25T09:00:00.000Z', versionPolitique: '2026-11-25' }, when: 'any' }]);
    const r = await call('[parent]', 'POST /family/policy', { consent: true, policyVersion: POLICY_VERSION });
    expect(r.statusCode).toBe(204);
    expect((await env.store.get(keys.family(FID)))?.versionPolitique).toBe(POLICY_VERSION);
  });
  it('un eleve est refuse (403) et un corps sans consentement donne 400', async () => {
    const env = testDeps();
    t.env = env;
    await seed(env);
    expect((await call('[eleve]', 'POST /family/policy', { consent: true, policyVersion: POLICY_VERSION })).statusCode).toBe(403);
    expect((await call('[parent]', 'POST /family/policy', { consent: false, policyVersion: POLICY_VERSION })).statusCode).toBe(400);
  });
});
