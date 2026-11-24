// Compteur de cout applicatif (design-v2 4.6): garde principale du budget.
import { DynamoDBDocumentClient, GetCommand, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { CloudWatchClient, PutMetricDataCommand } from '@aws-sdk/client-cloudwatch';
import { keys } from './ddb/keys.js';
import { COST_BLOCK_NEW_EUR, COST_STOP_ALL_EUR, METRIC_COST_MONTH, METRIC_NAMESPACE, type Env } from './names.js';

export type CostGate = 'ok' | 'block_new' | 'stop_all';

/** >= 15 EUR: POST /scans repond 429 budget_epuise. >= 18 EUR: tout traitement s'arrete a l'etape suivante. */
export function costGate(totalEur: number): CostGate {
  if (totalEur >= COST_STOP_ALL_EUR) return 'stop_all';
  if (totalEur >= COST_BLOCK_NEW_EUR) return 'block_new';
  return 'ok';
}

/** Ajout atomique (en centimes entiers) au compteur du mois. Renvoie le total du mois en euros. */
export async function addCost(client: DynamoDBDocumentClient, table: string, env: Env, month: string, eur: number, pages = 0): Promise<number> {
  const cents = Math.round(eur * 100);
  const r = await client.send(
    new UpdateCommand({
      TableName: table,
      Key: keys.cost(env, month),
      UpdateExpression: 'ADD cents :c, pages :p',
      ExpressionAttributeValues: { ':c': cents, ':p': pages },
      ReturnValues: 'UPDATED_NEW',
    }),
  );
  return ((r.Attributes?.cents as number | undefined) ?? cents) / 100;
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

export async function readCost(client: DynamoDBDocumentClient, table: string, env: Env, month: string): Promise<number> {
  const r = await client.send(new GetCommand({ TableName: table, Key: keys.cost(env, month) }));
  return ((r.Item?.cents as number | undefined) ?? 0) / 100;
}
