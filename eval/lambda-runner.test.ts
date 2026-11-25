import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lambdaRunner } from './runners.js';

/** Fausse CLI `aws`: écrit la réponse de la Lambda dans le dernier argument, affiche les métadonnées, garde les arguments et l'environnement. */
function fakeAws(response: object, meta: object = { StatusCode: 200 }): string {
  const dir = mkdtempSync(join(tmpdir(), 'fakeaws-'));
  const bin = join(dir, 'aws');
  writeFileSync(join(dir, 'resp.json'), JSON.stringify(response));
  writeFileSync(bin, `#!/bin/bash\necho "$@" > "${dir}/args"\necho "$AWS_MAX_ATTEMPTS" > "${dir}/attempts"\ncp "${dir}/resp.json" "\${@: -1}"\necho '${JSON.stringify(meta)}'\n`);
  chmodSync(bin, 0o755);
  return dir;
}
const result = (costEur: number, total: number) => ({
  refused: false, state: 'termine', transcript: 't', claims: [], outputText: '{}', steps: [], costEur, durationSec: 3, uncounted: 0,
  costBefore: { monthEur: total - costEur, totalEur: total - costEur }, costAfter: { monthEur: total, totalEur: total },
});
const ann = { id: 'x', transcription: '', sentences: [] };
const IMG = Buffer.from([0xff, 0xd8, 0xff, 1]);

afterEach(() => vi.unstubAllEnvs());

describe('voie lambda', () => {
  it('invoque la CLI sans nouvel essai ni délai de lecture, et rend coût et compteurs', async () => {
    const dir = fakeAws(result(0.05, 1.5));
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = lambdaRunner('qcm-dev-eval-run', { maxEur: 1, stopAtTotalEur: 40 });
    const out = await r.run({ id: 'synth-fr-01', image: IMG, ann });
    expect(out.costEur).toBe(0.05);
    expect(out.costAfter?.totalEur).toBe(1.5);
    expect(r.spent?.()).toBe(0.05);
    const { readFileSync } = await import('node:fs');
    expect(readFileSync(join(dir, 'attempts'), 'utf8').trim()).toBe('1');
    expect(readFileSync(join(dir, 'args'), 'utf8')).toMatch(/--cli-read-timeout 0/);
  });
  it('s\'arrête quand la dépense du lancement atteint le plafond', async () => {
    const dir = fakeAws(result(0.6, 2));
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = lambdaRunner('f', { maxEur: 1, stopAtTotalEur: 40 });
    await r.run({ id: 'synth-fr-01', image: IMG, ann });
    await r.run({ id: 'synth-fr-02', image: IMG, ann });
    await expect(r.run({ id: 'synth-fr-03', image: IMG, ann })).rejects.toThrow(/plafond/);
  });
  it('s\'arrête quand le cumul dev atteint le seuil, sans afficher de message de la fonction', async () => {
    const dir = fakeAws(result(0.01, 40.5));
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    vi.spyOn(console, 'log').mockImplementation(() => undefined);
    const r = lambdaRunner('f', { maxEur: 5, stopAtTotalEur: 40 });
    await r.run({ id: 'synth-fr-01', image: IMG, ann });
    await expect(r.run({ id: 'synth-fr-02', image: IMG, ann })).rejects.toThrow(/cumul dev/);
  });
  it('erreur de fonction: seule la classe d\'erreur remonte', async () => {
    const dir = fakeAws({ errorType: 'ZodError', errorMessage: 'texte du cours' }, { StatusCode: 200, FunctionError: 'Unhandled' });
    vi.stubEnv('PATH', `${dir}:${process.env.PATH}`);
    const r = lambdaRunner('f', { maxEur: 1, stopAtTotalEur: 40 });
    const e = await r.run({ id: 'synth-fr-01', image: IMG, ann }).catch((x: Error) => x);
    expect((e as Error).message).toBe('eval-run: ZodError');
  });
});
