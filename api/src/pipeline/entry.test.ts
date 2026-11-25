import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

/** Noms d'export de `entry.ts` que l'infra branche (API_FUNCTIONS et STEP_FUNCTIONS de infra/lib/pipeline-stack.ts). Un nom manquant = echec a l'invocation. */
const API = ['scansCreateHandler', 'jobsGetHandler', 'jobsTranscriptionHandler', 'jobsConfirmHandler', 'jobsCancelHandler', 'docsReadHandler', 'docsDeleteHandler', 'docsReportHandler', 'scansListHandler', 'docsPatchHandler', 'foldersHandler', 'coursHandler'];
const STEPS = ['scanStartHandler', 'awaitUploadHandler', 'scanCheckHandler', 'transcribeHandler', 'awaitConfirmHandler', 'expireHandler', 'sectionsPlanHandler', 'extractHandler', 'sectionCostHandler', 'quotaConsumeHandler', 'generateHandler', 'finalizeHandler', 'failHandler'];

describe('entry.ts: exports attendus par l\'infra', () => {
  const src = readFileSync(new URL('./entry.ts', import.meta.url), 'utf8');
  it.each([...API, ...STEPS])('exporte %s', (name) => {
    expect(src).toMatch(new RegExp(`export const ${name} = `));
  });
  it('les 12 handlers HTTP et les 13 etapes sont tous listes', () => {
    expect(API).toHaveLength(12);
    expect(STEPS).toHaveLength(13);
  });
});
