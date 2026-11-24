import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { CostBlockedError, JobBudgetExceededError, LIMITS, invokeModel, type CostStore, type ModelPort } from './bedrock.js';
import type { CostTotals } from './cost.js';

const ARN = 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/abc';
// Compteur en memoire en micro-euros (comme le vrai): mois et cumul.
const memStore = (startMonth = 0, startTotal = startMonth): CostStore & { totals: () => CostTotals; failAdds: number } => {
  const s = { m: Math.round(startMonth * 1e6), t: Math.round(startTotal * 1e6), failAdds: 0 };
  const totals = (): CostTotals => ({ monthEur: s.m / 1e6, totalEur: s.t / 1e6 });
  return {
    totals,
    get failAdds() {
      return s.failAdds;
    },
    set failAdds(v: number) {
      s.failAdds = v;
    },
    read: async () => totals(),
    add: async (e) => {
      if (s.failAdds > 0) {
        s.failAdds--;
        throw new Error('throttling');
      }
      s.m += Math.round(e * 1e6);
      s.t += Math.round(e * 1e6);
      return totals();
    },
  };
};
const counting = (usage = { inputTokens: 1_000_000, outputTokens: 0 }): ModelPort & { calls: number } => {
  const p = { calls: 0, converse: async () => (p.calls++, { text: 'ok', usage }) };
  return p;
};
const base = { model: 'haiku-5.5' as const, jobId: 'j1', step: 'extract', request: { modelArn: ARN, prompt: 'x', maxTokens: 10 }, jobSpentEur: 0, retryDelaysMs: [0, 0, 0] };

let savedEnv: string | undefined;
beforeEach(() => {
  savedEnv = process.env.QCM_ENV;
  process.env.QCM_ENV = 'dev';
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.QCM_ENV;
  else process.env.QCM_ENV = savedEnv;
});

describe('client Bedrock unique', () => {
  it('ajoute le cout immediatement apres la reponse', async () => {
    const store = memStore();
    const r = await invokeModel({ ...base, store, port: counting() });
    expect(r.costEur).toBeGreaterThan(0.09); // 1 M tokens d'entree Haiku, ~0,10 EUR
    expect(r.counted).toBe(true);
    expect(store.totals().monthEur).toBeCloseTo(r.costEur, 6);
  });
  it('les petits appels comptent: 1000 appels de ~0,0015 EUR font ~1,5 EUR, pas 0', async () => {
    const store = memStore();
    const port = counting({ inputTokens: 10_000, outputTokens: 1_000 }); // ~0,0015 EUR en Haiku
    for (let i = 0; i < 1000; i++) await invokeModel({ ...base, store, port });
    expect(store.totals().monthEur).toBeGreaterThan(1.3);
    expect(store.totals().monthEur).toBeLessThan(1.7);
  });
  it('GARDE DEV 12 EUR CUMULE: bloque meme si le mois est a 0 (nouveau mois), le port n\'est pas appele', async () => {
    const port = counting();
    const store = memStore(0, 12);
    await expect(invokeModel({ ...base, store, port })).rejects.toBeInstanceOf(CostBlockedError);
    expect(port.calls).toBe(0);
    expect(store.totals().totalEur).toBe(12);
  });
  it('juste sous le plafond cumule (11,99): l\'appel passe', async () => {
    const port = counting();
    await invokeModel({ ...base, store: memStore(0, 11.99), port });
    expect(port.calls).toBe(1);
  });
  it('l\'environnement vient de la configuration, pas de l\'appelant: en prod le plafond de 12 EUR ne s\'applique pas', async () => {
    process.env.QCM_ENV = 'prod';
    const port = counting();
    await invokeModel({ ...base, store: memStore(0, 12), port });
    expect(port.calls).toBe(1);
    process.env.QCM_ENV = 'autre';
    await expect(invokeModel({ ...base, store: memStore(), port })).rejects.toThrow(/QCM_ENV/);
    delete process.env.QCM_ENV;
    await expect(invokeModel({ ...base, store: memStore(), port })).rejects.toThrow(/QCM_ENV/);
  });
  it('plafond par job (0,25 EUR): refus avant l\'appel; jobSpentEur est obligatoire et valide', async () => {
    const port = counting();
    await expect(invokeModel({ ...base, store: memStore(), port, jobSpentEur: 0.25 })).rejects.toBeInstanceOf(JobBudgetExceededError);
    for (const bad of [Number.NaN, -1, undefined as unknown as number]) {
      await expect(invokeModel({ ...base, store: memStore(), port, jobSpentEur: bad })).rejects.toThrow(RangeError);
    }
    expect(port.calls).toBe(0);
  });
  it('compteur illisible ou non fini: appel refuse (fail-closed)', async () => {
    const port = counting();
    const broken: CostStore = { read: async () => ({ monthEur: Number.NaN, totalEur: 0 }), add: async () => ({ monthEur: 0, totalEur: 0 }) };
    await expect(invokeModel({ ...base, store: broken, port })).rejects.toBeInstanceOf(CostBlockedError);
    const down: CostStore = { read: async () => Promise.reject(new Error('dynamodb')), add: broken.add };
    await expect(invokeModel({ ...base, store: down, port })).rejects.toThrow('dynamodb');
    expect(port.calls).toBe(0);
  });
  it('refuse un profil systeme, une autre region, un format approximatif', async () => {
    for (const modelArn of [
      'eu.anthropic.claude-haiku-5-5',
      'arn:aws:bedrock:eu-west-3:123456789012:inference-profile/eu.anthropic.x',
      'arn:aws:bedrock:us-east-1:123456789012:application-inference-profile/a',
      'x/arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/a',
      'arn:aws:bedrock:eu-west-3:123:application-inference-profile/a',
    ]) {
      await expect(invokeModel({ ...base, request: { ...base.request, modelArn }, store: memStore(), port: counting() })).rejects.toThrow(/profil/);
    }
  });
  it('bornes: maxTokens, prompt, nombre et taille des images', async () => {
    const port = counting();
    const run = (request: object) => invokeModel({ ...base, request: { ...base.request, ...request }, store: memStore(), port });
    await expect(run({ maxTokens: LIMITS.maxTokens + 1 })).rejects.toThrow(RangeError);
    await expect(run({ maxTokens: 0 })).rejects.toThrow(RangeError);
    await expect(run({ prompt: 'x'.repeat(LIMITS.maxPromptChars + 1) })).rejects.toThrow(RangeError);
    const img = { format: 'jpeg' as const, bytes: new Uint8Array(10) };
    await expect(run({ images: Array.from({ length: LIMITS.maxImages + 1 }, () => img) })).rejects.toThrow(RangeError);
    await expect(run({ images: [{ format: 'png', bytes: new Uint8Array(LIMITS.maxImageBytes + 1) }] })).rejects.toThrow(RangeError);
    expect(port.calls).toBe(0);
  });
  it('echec d\'ecriture du compteur: 3 essais, puis pas d\'exception (un Retry rappellerait le modele)', async () => {
    const store = memStore();
    store.failAdds = 2;
    expect((await invokeModel({ ...base, store, port: counting() })).counted).toBe(true);
    store.failAdds = 3;
    const r = await invokeModel({ ...base, store, port: counting() });
    expect(r.counted).toBe(false);
    expect(r.costEur).toBeGreaterThan(0);
  });
  it('usage illisible (NaN): le pire cas est compte, jamais 0', async () => {
    const store = memStore();
    const r = await invokeModel({ ...base, store, port: counting({ inputTokens: Number.NaN, outputTokens: 5 }) });
    expect(r.costEur).toBeGreaterThan(0);
    expect(store.totals().monthEur).toBeGreaterThan(0);
  });
});
