// Prix Bedrock, profil Geo UE, Paris (design-v2 2.1, fichier d'offre du 2026-11-23). USD par million de tokens.
export const USD_PER_EUR = 1.0963; // BCE 2026-11-24, a relire au lancement
export type ModelKey = 'haiku-5.5' | 'sonnet-5.5';

export const PRICES_USD_PER_M: Record<ModelKey, { input: number; output: number; cacheRead: number; cacheWrite5m: number }> = {
  'haiku-5.5': { input: 0.11, output: 0.55, cacheRead: 0.011, cacheWrite5m: 0.1375 },
  'sonnet-5.5': { input: 2.2, output: 11.0, cacheRead: 0.11, cacheWrite5m: 2.75 },
};

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
}

export function costUsd(model: ModelKey, u: Usage): number {
  const p = PRICES_USD_PER_M[model];
  return (u.inputTokens * p.input + u.outputTokens * p.output + (u.cacheReadTokens ?? 0) * p.cacheRead + (u.cacheWriteTokens ?? 0) * p.cacheWrite5m) / 1_000_000;
}

export const costEur = (model: ModelKey, u: Usage): number => costUsd(model, u) / USD_PER_EUR;
