import { describe, expect, it } from 'vitest';
import { CostBlockedError, JobBudgetExceededError, invokeModel, type CostStore, type ModelPort } from './bedrock.js';
import { costGateFor } from './cost.js';

const ARN = 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/abc';
const memStore = (start = 0): CostStore & { total: () => number } => {
  let t = start;
  return { read: async () => t, add: async (e) => (t += e), total: () => t };
};
const counting = (): ModelPort & { calls: number } => {
  const p = { calls: 0, converse: async () => (p.calls++, { text: 'ok', usage: { inputTokens: 1_000_000, outputTokens: 0 } }) };
  return p;
};
const base = { env: 'dev' as const, model: 'haiku-5.5' as const, jobId: 'j1', step: 'extract', request: { modelArn: ARN, prompt: 'x', maxTokens: 10 } };

describe('client Bedrock unique', () => {
  it('ajoute le cout du mois immediatement apres la reponse', async () => {
    const store = memStore();
    const r = await invokeModel({ ...base, store, port: counting() });
    expect(r.costEur).toBeGreaterThan(0.09); // 1 M tokens d'entree Haiku, ~0,10 EUR
    expect(store.total()).toBeCloseTo(r.costEur, 6);
  });
  it('GARDE DEV 12 EUR: aucun appel au-dela du plafond, le port n\'est pas appele', async () => {
    const port = counting();
    const store = memStore(12);
    await expect(invokeModel({ ...base, store, port })).rejects.toBeInstanceOf(CostBlockedError);
    expect(port.calls).toBe(0);
    expect(store.total()).toBe(12);
  });
  it('juste sous le plafond dev (11,99): l\'appel passe; en prod le plafond est 15/18', async () => {
    const port = counting();
    await invokeModel({ ...base, store: memStore(11.99), port });
    expect(port.calls).toBe(1);
    expect(costGateFor('dev', 12)).toBe('stop_all');
    expect(costGateFor('prod', 12)).toBe('ok');
    expect(costGateFor('prod', 15)).toBe('block_new');
    expect(costGateFor('prod', 18)).toBe('stop_all');
  });
  it('plafond par job (0,25 EUR): refus avant l\'appel', async () => {
    const port = counting();
    await expect(invokeModel({ ...base, store: memStore(), port, jobSpentEur: 0.25 })).rejects.toBeInstanceOf(JobBudgetExceededError);
    expect(port.calls).toBe(0);
  });
  it('refuse un profil systeme ou une autre region', async () => {
    for (const modelArn of ['eu.anthropic.claude-haiku-5-5', 'arn:aws:bedrock:eu-west-3:123456789012:inference-profile/eu.anthropic.x', 'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a']) {
      await expect(invokeModel({ ...base, request: { ...base.request, modelArn }, store: memStore(), port: counting() })).rejects.toThrow(/profil/);
    }
  });
});
