// Assemblage reel des Lambda de traitement E1 (`exo-gen`, `copie-correct`, `copie-fail`). Lu a la premiere invocation, jamais a l'import.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { costStoreFromDynamo, modelPortFromEnv } from '../../../shared/bedrock.js';
import { ENVS, type Env } from '../../../shared/names.js';
import { dynamoQuotaDb } from '../../../shared/quota.js';
import { realRandom, type Deps } from '../lib/deps.js';
import { dynamoStore } from '../lib/store.js';
import type { ModelDeps } from './model.js';

const need = (...names: string[]): string => {
  for (const n of names) if (process.env[n]) return process.env[n]!;
  throw new Error(`${names[0]} manquant`);
};

export async function processingDeps(): Promise<Deps & ModelDeps> {
  const env = need('QCM_ENV') as Env;
  if (!ENVS.includes(env)) throw new Error('QCM_ENV invalide');
  const table = need('TABLE_NAME', 'QCM_TABLE');
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
  return {
    store: dynamoStore(client, table),
    quota: dynamoQuotaDb(client, table),
    env,
    now: () => new Date(),
    ...realRandom,
    port: await modelPortFromEnv(), // faux modele tant que QCM_BEDROCK n'est pas `real`
    costStore: costStoreFromDynamo(client, table),
    models: { haiku: need('QCM_MODEL_HAIKU'), sonnet: process.env.QCM_MODEL_SONNET ?? '' },
  };
}
