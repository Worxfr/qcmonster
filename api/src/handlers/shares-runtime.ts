// Assemblage reel des Lambda du partage (S1 #34). Lu a la premiere invocation, jamais a l'import. Un seul port DynamoDB, aucun S3, aucun modele.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { ENVS, type Env } from '../../../shared/names.js';
import { dynamoDb } from '../pipeline/ports.js';
import { realShareRandom, type ShareCtx } from '../shares/ctx.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} manquant`);
  return v;
};

let doc: DynamoDBDocumentClient | undefined;
const client = () => (doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));

/** `SHARE_PUBLIC_ENABLED` vaut `true` pour ouvrir; toute autre valeur (ou absente) = ferme. */
export function shareCtx(): ShareCtx {
  const env = need('QCM_ENV') as Env;
  if (!ENVS.includes(env)) throw new Error('QCM_ENV invalide');
  return { db: dynamoDb(client(), need('TABLE_NAME')), env, now: () => new Date(), ...realShareRandom, publicEnabled: process.env.SHARE_PUBLIC_ENABLED === 'true' };
}
