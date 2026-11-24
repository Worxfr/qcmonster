import type { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { dynamoDb } from './ports.js';

/** Faux client DynamoDB: garde la derniere commande et renvoie une reponse fixee. */
function fake(response: unknown, error?: { name: string }) {
  const sent: { input: Record<string, unknown> }[] = [];
  const client = {
    send: async (c: { input: Record<string, unknown> }) => {
      sent.push(c);
      if (error) throw Object.assign(new Error('x'), error);
      return response;
    },
  } as unknown as DynamoDBDocumentClient;
  return { db: dynamoDb(client, 'qcm-test', async () => {}), sent };
}

describe('adaptateur DynamoDB', () => {
  it("construit l'expression de mise a jour avec conditions et ensembles, et renvoie des tableaux", async () => {
    const { db, sent } = fake({ Attributes: { PK: 'a', SK: 'b', uploadedKeys: new Set(['k1', 'k2']) } });
    const r = await db.update({ PK: 'a', SK: 'b' }, { set: { state: 'x' }, add: { n: 1 }, addSet: { uploadedKeys: ['k1'] }, remove: ['old'], cond: { exists: true, in: { state: ['p', 'q'] }, lt: { n: 10 } } });
    expect(r?.uploadedKeys).toEqual(['k1', 'k2']);
    const i = sent[0].input;
    expect(i.UpdateExpression).toMatch(/^SET #state = :v0 ADD #n :v1, #uploadedKeys :v2 REMOVE #old$/);
    expect(i.ConditionExpression).toBe('attribute_exists(PK) AND #state IN (:v3, :v4) AND (attribute_not_exists(#n) OR #n < :v5)');
    expect(i.ReturnValues).toBe('ALL_NEW');
  });
  it('condition non remplie: undefined, autre erreur: remontee', async () => {
    expect(await fake(undefined, { name: 'ConditionalCheckFailedException' }).db.update({ PK: 'a', SK: 'b' }, { set: { a: 1 } })).toBeUndefined();
    await expect(fake(undefined, { name: 'ProvisionedThroughputExceededException' }).db.update({ PK: 'a', SK: 'b' }, { set: { a: 1 } })).rejects.toThrow();
  });
  it('put conditionnel: false si existe deja', async () => {
    expect(await fake(undefined, { name: 'ConditionalCheckFailedException' }).db.put({ PK: 'a', SK: 'b' }, true)).toBe(false);
  });
});
