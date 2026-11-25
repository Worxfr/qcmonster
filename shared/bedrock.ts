// SEUL point d'appel a Bedrock (design-v2 4.6; test: scripts/guards.test.ts interdit l'import du SDK ailleurs).
// Chaque appel: (1) garde de cout AVANT l'appel, (2) Converse sur le profil d'APPLICATION, (3) conversion usage -> euros,
// (4) ajout au compteur IMMEDIATEMENT apres la reponse (un Retry Step Functions ne perd jamais un cout).
// Mode `mock` par defaut (QCM_BEDROCK absent ou 'mock'): aucun appel reseau, aucun cout. L'appel reel exige QCM_BEDROCK=real.
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { addCost, costGateFor, readCost, type CostTotals } from './cost.js';
import { monthParis } from './ddb/keys.js';
import { ENVS, JOB_COST_CAP_EUR, REGION, type Env } from './names.js';
import { costEur, type ModelKey, type Usage } from './pricing.js';
import { log } from './log/index.js';

/** Bornes d'une requete: un seul appel ne peut pas depasser le plafond d'un job (0,25 EUR) par construction. */
export const LIMITS = { maxTokens: 8192, maxImages: 10, maxImageBytes: 5 * 1024 * 1024, maxPromptChars: 400_000 } as const;

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

/** Compteurs de cout (mois et cumul). L'environnement et le mois NE sont PAS des parametres de l'appelant. */
export interface CostStore {
  read(): Promise<CostTotals>;
  add(eur: number): Promise<CostTotals>;
}

/** Environnement du deploiement, pose par CDK dans la configuration de la fonction (QCM_ENV). Jamais un parametre d'appel. */
export function currentEnv(): Env {
  const v = process.env.QCM_ENV;
  if (!ENVS.includes(v as Env)) throw new Error('QCM_ENV absent ou invalide (dev|prod)');
  return v as Env;
}

export const costStoreFromDynamo = (client: DynamoDBDocumentClient, table: string, now: () => Date = () => new Date()): CostStore => ({
  read: () => readCost(client, table, currentEnv(), monthParis(now())),
  add: (eur) => addCost(client, table, currentEnv(), monthParis(now()), eur),
});

export class CostBlockedError extends Error {
  constructor(readonly gate: 'block_new' | 'stop_all', readonly totals: CostTotals) {
    super(`appel Bedrock bloque par la garde de cout (${gate})`);
  }
}
export class JobBudgetExceededError extends Error {
  constructor() {
    super('plafond de cout du job atteint');
  }
}

export interface InvokeOptions {
  model: ModelKey;
  jobId: string;
  step: string;
  request: ModelRequest;
  store: CostStore;
  port: ModelPort;
  /** OBLIGATOIRE: deja depense sur ce job, en euros (somme des `costEur` des appels precedents, tenue par l'appelant dans l'element Job). */
  jobSpentEur: number;
  jobCapEur?: number;
  /** Pauses entre les essais d'ecriture du compteur (ms); `[0, 0, 0]` dans les tests. */
  retryDelaysMs?: number[];
}
export interface InvokeResult {
  text: string;
  costEur: number;
  /** false si le compteur n'a pas pu etre ecrit apres 3 essais (le cout est alors dans le journal, a rattraper). */
  counted: boolean;
}

const APP_PROFILE = new RegExp(`^arn:aws:bedrock:${REGION}:\\d{12}:application-inference-profile/[A-Za-z0-9._-]+$`);

/** L'ARN passe a Bedrock doit etre un profil d'application de la region (test CI du design 4.6). */
export function assertApplicationProfileArn(arn: string): void {
  if (!APP_PROFILE.test(arn)) throw new Error("modelArn doit etre un profil d'inference d'application (jamais un profil systeme)");
}

function assertRequestBounds(r: ModelRequest): void {
  if (!Number.isInteger(r.maxTokens) || r.maxTokens < 1 || r.maxTokens > LIMITS.maxTokens) throw new RangeError('maxTokens hors bornes');
  if (r.prompt.length + (r.system?.length ?? 0) > LIMITS.maxPromptChars) throw new RangeError('prompt trop long');
  const imgs = r.images ?? [];
  if (imgs.length > LIMITS.maxImages || imgs.some((i) => i.bytes.byteLength > LIMITS.maxImageBytes)) throw new RangeError('images hors bornes');
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export async function invokeModel(o: InvokeOptions): Promise<InvokeResult> {
  assertApplicationProfileArn(o.request.modelArn);
  assertRequestBounds(o.request);
  if (!Number.isFinite(o.jobSpentEur) || o.jobSpentEur < 0) throw new RangeError('jobSpentEur obligatoire (nombre >= 0)');
  const env = currentEnv();
  // Garde 1: plafond du job. Garde 2: compteurs (cumul dev 50 EUR; mois 15/18 EUR). Compteur illisible: l'appel est refuse.
  if (o.jobSpentEur >= (o.jobCapEur ?? JOB_COST_CAP_EUR)) throw new JobBudgetExceededError();
  const before = await o.store.read();
  const gate = costGateFor(env, before);
  if (gate !== 'ok') {
    log({ jobId: o.jobId, step: o.step, status: 'rejected', costEur: before.monthEur });
    throw new CostBlockedError(gate, before);
  }
  const t0 = Date.now();
  const res = await o.port.converse(o.request);
  let eur = costEur(o.model, res.usage);
  if (!Number.isFinite(eur) || eur < 0) {
    // usage illisible: on compte le pire cas (entree estimee a 1 token pour 2 caracteres, sortie = maxTokens), jamais 0.
    eur = costEur(o.model, { inputTokens: Math.ceil((o.request.prompt.length + (o.request.system?.length ?? 0)) / 2), outputTokens: o.request.maxTokens });
    log({ jobId: o.jobId, step: o.step, status: 'error', costEur: eur });
  }
  // Ajout IMMEDIATEMENT apres la reponse, avec 3 essais. Si tout echoue: journal d'erreur avec le cout (rattrapage), pas d'exception
  // (un Retry Step Functions rappellerait le modele et doublerait la facture).
  const delays = o.retryDelaysMs ?? [100, 400, 1600];
  let counted = false;
  for (let attempt = 0; attempt < 3 && !counted; attempt++) {
    try {
      await o.store.add(eur);
      counted = true;
    } catch {
      if (attempt < 2) await sleep(delays[attempt] ?? 0);
    }
  }
  log({ jobId: o.jobId, step: o.step, status: counted ? 'ok' : 'error', durationMs: Date.now() - t0, tokensIn: res.usage.inputTokens, tokensOut: res.usage.outputTokens, costEur: eur });
  return { text: res.text, costEur: eur, counted };
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
          inferenceConfig: { maxTokens: req.maxTokens }, // pas de temperature: le modele la refuse (ValidationException)
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
