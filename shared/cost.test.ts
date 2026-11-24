import { describe, expect, it } from 'vitest';
import { TransactWriteCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { addCost, costGate, readCost, toMicros } from './cost.js';
import { costEur } from './pricing.js';

describe('compteur de cout', () => {
  it('seuils 15 EUR (bloque les nouveaux scans) et 18 EUR (arrete tout)', () => {
    expect(costGate(14.99)).toBe('ok');
    expect(costGate(15)).toBe('block_new');
    expect(costGate(17.99)).toBe('block_new');
    expect(costGate(18)).toBe('stop_all');
  });
  it('conversion tokens vers euros (scenario D, jugement Sonnet 10000/1500)', () => {
    // S(10 000 ; 1 500) = 0,0385 $ ; / 1,0963 = 0,03512 EUR
    expect(costEur('sonnet-5.5', { inputTokens: 10000, outputTokens: 1500 })).toBeCloseTo(0.0351, 4);
  });
});

// Faux client DynamoDB (documents): compte en memoire, comme le vrai ADD.
function fakeDb(corrupt?: Record<string, unknown>) {
  const items = new Map<string, Record<string, unknown>>();
  const id = (k: { PK: string; SK: string }) => `${k.PK}|${k.SK}`;
  const client = {
    async send(cmd: { input: Record<string, unknown>; constructor: { name: string } }) {
      if (cmd instanceof TransactWriteCommand) {
        for (const t of (cmd.input.TransactItems ?? []) as unknown as { Update: { Key: { PK: string; SK: string }; ExpressionAttributeValues: Record<string, number> } }[]) {
          const it = items.get(id(t.Update.Key)) ?? {};
          it.micros = ((it.micros as number | undefined) ?? 0) + t.Update.ExpressionAttributeValues[':c'];
          items.set(id(t.Update.Key), it);
        }
        return {};
      }
      const key = (cmd.input as { Key: { PK: string; SK: string } }).Key;
      return { Item: corrupt ?? items.get(id(key)) };
    },
  };
  return client as unknown as DynamoDBDocumentClient;
}

describe('compteur en micro-euros entiers', () => {
  it('1000 appels de 0,0015 EUR = 1,50 EUR exactement (pas 0)', async () => {
    const db = fakeDb();
    let last = { monthEur: 0, totalEur: 0 };
    for (let i = 0; i < 1000; i++) last = await addCost(db, 't', 'dev', '2026-12', 0.0015);
    expect(last.monthEur).toBe(1.5);
    expect(last.totalEur).toBe(1.5);
    expect(await readCost(db, 't', 'dev', '2026-12')).toEqual({ monthEur: 1.5, totalEur: 1.5 });
  });
  it('le cumul survit au changement de mois, le mois repart de zero', async () => {
    const db = fakeDb();
    await addCost(db, 't', 'dev', '2026-12', 5);
    await addCost(db, 't', 'dev', '2027-01', 1);
    expect(await readCost(db, 't', 'dev', '2027-01')).toEqual({ monthEur: 1, totalEur: 6 });
  });
  it('compteur corrompu: erreur (fail-closed); compteur absent: 0', async () => {
    await expect(readCost(fakeDb({ micros: 'abc' }), 't', 'dev', '2026-12')).rejects.toThrow(/illisible/);
    await expect(readCost(fakeDb({ micros: Number.NaN }), 't', 'dev', '2026-12')).rejects.toThrow(/illisible/);
    expect(await readCost(fakeDb(), 't', 'dev', '2026-12')).toEqual({ monthEur: 0, totalEur: 0 });
  });
  it('toMicros refuse NaN, Infinity et les negatifs', () => {
    for (const bad of [Number.NaN, Infinity, -0.1]) expect(() => toMicros(bad)).toThrow(RangeError);
    expect(toMicros(0.00055)).toBe(550);
  });
});
