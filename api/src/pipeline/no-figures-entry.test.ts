// B1 (relecture de la PR #94): sans QCM_FIGURES_BUCKET ni FIGURES_ENABLED, `context()` de entry.ts se construit et les fonctions repondent.
import { describe, expect, it } from 'vitest';

describe('entry.ts sans bucket des figures', () => {
  it('context() ne leve pas: un handler repond 403 (jeton vide) au lieu de planter au demarrage', async () => {
    Object.assign(process.env, { QCM_ENV: 'dev', QCM_TABLE: 't', QCM_SCANS_BUCKET: 'b', QCM_STATE_MACHINE_ARN: 'machine-test', QCM_BEDROCK: 'mock', AWS_REGION: 'eu-west-3', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x' });
    delete process.env.QCM_FIGURES_BUCKET;
    delete process.env.FIGURES_ENABLED;
    const entry = await import('./entry.js');
    const r = await entry.jobsGetHandler({ pathParameters: { jobId: 'j1' }, requestContext: { authorizer: { jwt: { claims: {} } } } } as never);
    expect(r.statusCode).toBe(403);
  });
});
