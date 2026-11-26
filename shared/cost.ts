// Compteur de cout applicatif (design-v2 4.6): garde principale du budget.
import { DynamoDBDocumentClient, GetCommand, TransactWriteCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { keys, type Key } from './ddb/keys.js';
import { COST_BLOCK_NEW_EUR, COST_STOP_ALL_EUR, DEV_TRIAL_CAP_EUR, costThresholdsFor, METRIC_COST_MONTH, METRIC_NAMESPACE, type Env } from './names.js';

export type CostGate = 'ok' | 'block_new' | 'stop_all';

/** Prod: >= 15 EUR, POST /scans repond 429 budget_epuise; >= 18 EUR, tout traitement s'arrete a l'etape suivante. Dev: 95/100 EUR (costThresholdsFor). */
export function costGate(totalEur: number, t = { blockNewEur: COST_BLOCK_NEW_EUR, stopAllEur: COST_STOP_ALL_EUR }): CostGate {
  if (totalEur >= t.stopAllEur) return 'stop_all';
  if (totalEur >= t.blockNewEur) return 'block_new';
  return 'ok';
}

/**
 * Garde par environnement. En dev, le plafond d essais (DEV_TRIAL_CAP_EUR, 100 EUR) s applique au CUMUL depuis le debut de la phase dev
 * (decision du proprietaire), pas au mois. Les seuils mensuels (prod 15/18 EUR, dev 95/100 EUR) restent mensuels.
 */
export function costGateFor(env: Env, c: CostTotals | number): CostGate {
  const { monthEur, totalEur } = typeof c === 'number' ? { monthEur: c, totalEur: c } : c;
  if (!Number.isFinite(monthEur) || !Number.isFinite(totalEur)) return 'stop_all'; // fail-closed
  if (env === 'dev' && totalEur >= DEV_TRIAL_CAP_EUR) return 'stop_all';
  return costGate(monthEur, costThresholdsFor(env));
}

export const MICROS_PER_EUR = 1_000_000;
/** Euros -> micro-euros entiers. Un appel Haiku de 3 000 tokens (0,00055 EUR) compte 550, pas 0. */
export const toMicros = (eur: number): number => {
  if (!Number.isFinite(eur) || eur < 0) throw new RangeError('cout invalide');
  return Math.round(eur * MICROS_PER_EUR);
};

export interface CostTotals {
  /** Total du mois (COST#<env> / MONTH#<aaaa-mm>), en euros. */
  monthEur: number;
  /** Cumul depuis le debut (COST#<env> / TOTAL), en euros. */
  totalEur: number;
}

const microsOf = (attrs: Record<string, unknown> | undefined, what: string): number => {
  const v = attrs?.micros ?? 0; // compteur absent = 0 (debut de mois)
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) throw new Error(`compteur de cout illisible (${what})`); // fail-closed
  return v;
};

/**
 * Ajout ATOMIQUE (transaction) en micro-euros entiers au compteur du mois ET au cumul. Renvoie les deux totaux relus
 * (lecture coherente). Leve une erreur si un compteur est absent apres l'ecriture ou illisible: jamais de faux total.
 */
export async function addCost(client: DynamoDBDocumentClient, table: string, env: Env, month: string, eur: number, pages = 0): Promise<CostTotals> {
  const micros = toMicros(eur);
  const upd = (key: Key) => ({
    Update: { TableName: table, Key: key, UpdateExpression: 'ADD micros :c, pages :p', ExpressionAttributeValues: { ':c': micros, ':p': pages } },
  });
  await client.send(new TransactWriteCommand({ TransactItems: [upd(keys.cost(env, month)), upd(keys.costTotal(env))] }));
  return readCost(client, table, env, month);
}

/** Publie le total du mois: c'est la metrique de l'alarme a 10 EUR (stack Budget). */
export async function publishCostMetric(cw: CloudWatchClient, env: Env, totalEur: number): Promise<void> {
  await cw.send(
    new PutMetricDataCommand({
      Namespace: METRIC_NAMESPACE,
      MetricData: [{ MetricName: METRIC_COST_MONTH, Dimensions: [{ Name: 'Env', Value: env }], Value: totalEur, Unit: 'None' }],
    }),
  );
}

export async function readCost(client: DynamoDBDocumentClient, table: string, env: Env, month: string): Promise<CostTotals> {
  const get = async (key: Key, what: string) => {
    const r = await client.send(new GetCommand({ TableName: table, Key: key, ConsistentRead: true }));
    return microsOf(r.Item, what) / MICROS_PER_EUR;
  };
  const [monthEur, totalEur] = await Promise.all([get(keys.cost(env, month), 'mois'), get(keys.costTotal(env), 'cumul')]);
  return { monthEur, totalEur };
}
