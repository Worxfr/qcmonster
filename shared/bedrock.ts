// SEUL point d'appel a Bedrock (design-v2 4.6; test: scripts/guards.test.ts interdit l'import du SDK ailleurs).
// Chaque appel: (1) garde de cout AVANT l'appel, (2) Converse sur le profil d'APPLICATION, (3) conversion usage -> euros,
// (4) ajout au compteur IMMEDIATEMENT apres la reponse (un Retry Step Functions ne perd jamais un cout).
// Mode `mock` par defaut (QCM_BEDROCK absent ou 'mock'): aucun appel reseau, aucun cout. L'appel reel exige QCM_BEDROCK=real.
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { addCost, costGateFor, readCost } from './cost.js';
import { JOB_COST_CAP_EUR, REGION, type Env } from './names.js';
import { costEur, type ModelKey, type Usage } from './pricing.js';
import { log } from './log/index.js';

export interface ModelRequest {
  /** ARN du profil d'application (arn:aws:bedrock:eu-west-3:...), jamais un profil systeme. */
  modelArn: string;
  system?: string;
  prompt: string;
  maxTokens: number;
  /** Images (octets) pour la transcription; jamais journalisees. */
  images?: { format: 'jpeg' | 'png'; bytes: Uint8Array }[];
}
export interface ModelResponse {
  text: string;
  usage: Usage;
}
/** Port injectable: le vrai client Bedrock, ou un faux dans les tests. */
export interface ModelPort {
  converse(req: ModelRequest): Promise<ModelResponse>;
}

/** Compteur de cout du mois (COST#<env>). */
export interface CostStore {
  read(): Promise<number>;
  add(eur: number): Promise<number>;
}

export const costStoreFromDynamo = (client: DynamoDBDocumentClient, table: string, env: Env, month: string): CostStore => ({
  read: () => readCost(client, table, env, month),
  add: (eur) => addCost(client, table, env, month, eur),
});

export class CostBlockedError extends Error {
  constructor(readonly gate: 'block_new' | 'stop_all', readonly totalEur: number) {
    super(`appel Bedrock bloque par la garde de cout (${gate})`);
  }
}
export class JobBudgetExceededError extends Error {
  constructor() {
    super('plafond de cout du job atteint');
  }
}

export interface InvokeOptions {
  env: Env;
  model: ModelKey;
  jobId: string;
  step: string;
  request: ModelRequest;
  store: CostStore;
  port: ModelPort;
  /** Deja depense sur ce job, en euros (le plafond par job est JOB_COST_CAP_EUR par defaut). */
  jobSpentEur?: number;
  jobCapEur?: number;
}
export interface InvokeResult {
  text: string;
  costEur: number;
  monthTotalEur: number;
}

/** L'ARN passe a Bedrock doit etre un profil d'application de la region (test CI du design 4.6). */
export function assertApplicationProfileArn(arn: string): void {
  if (!arn.startsWith(`arn:aws:bedrock:${REGION}:`) || !arn.includes(':application-inference-profile/')) {
    throw new Error('modelArn doit etre un profil d\'inference d\'application (jamais un profil systeme)');
  }
}

export async function invokeModel(o: InvokeOptions): Promise<InvokeResult> {
  assertApplicationProfileArn(o.request.modelArn);
  // Garde 1: plafond du job. Garde 2: compteur du mois (15/18 EUR, ou 12 EUR en dev).
  if ((o.jobSpentEur ?? 0) >= (o.jobCapEur ?? JOB_COST_CAP_EUR)) throw new JobBudgetExceededError();
  const before = await o.store.read();
  const gate = costGateFor(o.env, before);
  if (gate !== 'ok') {
    log({ jobId: o.jobId, step: o.step, status: 'rejected', costEur: before });
    throw new CostBlockedError(gate, before);
  }
  const t0 = Date.now();
  const res = await o.port.converse(o.request);
  const eur = costEur(o.model, res.usage);
  const total = await o.store.add(eur); // immediatement apres la reponse
  log({ jobId: o.jobId, step: o.step, status: 'ok', durationMs: Date.now() - t0, tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens, costEur: eur });
  return { text: res.text, costEur: eur, monthTotalEur: total };
}

/** Faux modele deterministe: aucun reseau, aucun cout (mode par defaut des tests). */
export function mockModelPort(reply = '{}'): ModelPort {
  return {
    async converse(req) {
      return { text: reply, usage: { inputTokens: Math.ceil(req.prompt.length / 4), outputTokens: Math.ceil(reply.length / 4) } };
    },
  };
}

/** Port reel (Converse). Le SDK est charge a la demande, donc jamais dans les tests ni en mode mock. */
export async function realModelPort(): Promise<ModelPort> {
  const { BedrockRuntimeClient, ConverseCommand } = await import('@aws-sdk/client-bedrock-runtime');
  const client = new BedrockRuntimeClient({ region: REGION });
  return {
    async converse(req) {
      const content: Record<string, unknown>[] = (req.images ?? []).map((i) => ({ image: { format: i.format, source: { bytes: i.bytes } } }));
      content.push({ text: req.prompt });
      const r = await client.send(
        new ConverseCommand({
          modelId: req.modelArn,
          system: req.system ? [{ text: req.system }] : undefined,
          messages: [{ role: 'user', content: content as never }],
          inferenceConfig: { maxTokens: req.maxTokens, temperature: 0 },
        }),
      );
      const text = (r.output?.message?.content ?? []).map((c) => c.text ?? '').join('');
      return {
        text,
        usage: { inputTokens: r.usage?.inputTokens ?? 0, outputTokens: r.usage?.outputTokens ?? 0, cacheReadTokens: r.usage?.cacheReadInputTokens, cacheWriteTokens: r.usage?.cacheWriteInputTokens },
      };
    },
  };
}

/** Choix du port selon QCM_BEDROCK: 'real' = appel reel; sinon mock. */
export async function modelPortFromEnv(): Promise<ModelPort> {
  return process.env.QCM_BEDROCK === 'real' ? realModelPort() : mockModelPort();
}
