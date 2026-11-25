// Lambda `verify-run` (design-v2 4.1 etapes 7 a 10). Configuration par variables posees par CDK: TABLE_NAME, QCM_ENV, QCM_MODEL_SONNET_ARN.
// QCM_BEDROCK absent ou mock = faux modele (aucun appel reel); la stack Verify le pose selon -c bedrock=real.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { costStoreFromDynamo, modelPortFromEnv } from '../../../shared/bedrock.js';
import { VerifyInputSchema, type VerifyOutput } from '../../../shared/items.js';
import { createSearchTool } from './search.js';
import { sharedLimiter } from './limits.js';
import { verifyRun } from './run.js';
import { dynamoVerifyStore } from './store.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;
const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`variable ${name} absente`);
  return v;
};

export async function handler(event: unknown): Promise<VerifyOutput> {
  const input = VerifyInputSchema.parse(event);
  if (!ID.test(input.jobId) || !ID.test(input.docId)) throw new RangeError('identifiant invalide');
  if (process.env.QCM_ENV === 'prod') need('QCM_UA_CONTACT'); // Wikimedia exige un contact: pas de repli en production
  const table = need('TABLE_NAME');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  return verifyRun(
    {
      store: dynamoVerifyStore(client, table),
      search: createSearchTool({ beforeRequest: sharedLimiter }),
      model: { port: await modelPortFromEnv(), costStore: costStoreFromDynamo(client, table), arn: need('QCM_MODEL_SONNET_ARN') },
    },
    input,
  );
}
