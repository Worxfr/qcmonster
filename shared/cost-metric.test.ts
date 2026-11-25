import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { costStoreFromDynamo } from './bedrock.js';
import { METRIC_COST_MONTH, METRIC_NAMESPACE } from './names.js';

/** Faux DynamoDB: deux compteurs (mois, cumul) en micro-euros; `failWrite` fait echouer l'ecriture. */
function fakeDynamo() {
  const micros: Record<string, number> = {};
  const state = { failWrite: false, writes: 0 };
  const client = {
    send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
      if (c.constructor.name === 'TransactWriteCommand') {
        if (state.failWrite) throw new Error('indisponible');
        state.writes++;
        for (const t of (c.input.TransactItems as { Update: { Key: { SK: string }; ExpressionAttributeValues: { ':c': number } } }[])) {
          micros[t.Update.Key.SK] = (micros[t.Update.Key.SK] ?? 0) + t.Update.ExpressionAttributeValues[':c'];
        }
        return {};
      }
      return { Item: { micros: micros[(c.input.Key as { SK: string }).SK] ?? 0 } };
    },
  } as unknown as DynamoDBDocumentClient;
  return { client, state };
}
const fakeCw = (fail = false) => {
  const sent: { Namespace: string; MetricData: { MetricName: string; Value: number; Dimensions: { Name: string; Value: string }[] }[] }[] = [];
  return { sent, send: async (c: { input: (typeof sent)[number] }) => { if (fail) throw Object.assign(new Error('refus'), { name: 'AccessDenied' }); sent.push(c.input); return {}; } };
};

describe('alarme de cout: la metrique recoit enfin une mesure (B1 bis)', () => {
  const saved = process.env.QCM_ENV;
  beforeEach(() => { process.env.QCM_ENV = 'dev'; });
  afterEach(() => { process.env.QCM_ENV = saved; });
  const now = () => new Date('2026-12-01T10:00:00Z');

  it('une metrique par ecriture du compteur, valeur = total du mois', async () => {
    const { client } = fakeDynamo();
    const cw = fakeCw();
    const store = costStoreFromDynamo(client, 't', now, cw as never);
    await store.add(1.5);
    await store.add(2);
    expect(cw.sent).toHaveLength(2);
    expect(cw.sent[1].Namespace).toBe(METRIC_NAMESPACE);
    expect(cw.sent[1].MetricData[0]).toMatchObject({ MetricName: METRIC_COST_MONTH, Value: 3.5, Dimensions: [{ Name: 'Env', Value: 'dev' }] });
  });
  it('une erreur CloudWatch ne fait pas echouer l appel et ne double pas le cout', async () => {
    const { client, state } = fakeDynamo();
    const store = costStoreFromDynamo(client, 't', now, fakeCw(true) as never);
    await expect(store.add(1)).resolves.toMatchObject({ monthEur: 1 });
    expect(state.writes).toBe(1);
    expect((await store.read()).monthEur).toBe(1);
  });
  it('aucune metrique si l ecriture du compteur echoue', async () => {
    const { client, state } = fakeDynamo();
    state.failWrite = true;
    const cw = fakeCw();
    await expect(costStoreFromDynamo(client, 't', now, cw as never).add(1)).rejects.toThrow();
    expect(cw.sent).toHaveLength(0);
  });
});
