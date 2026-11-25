// Assemblage des dependances reelles des Lambda L3. Lu a la premiere invocation (pas a l'import) pour que les tests importent sans environnement.
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { dynamoTreeDb } from '../../../shared/delete-tree.js';
import { ENVS, type Env } from '../../../shared/names.js';
import { dynamoQuotaDb } from '../../../shared/quota.js';
import type { FamilyDeps } from '../family/ports.js';
import { realRandom, type Deps } from '../lib/deps.js';
import { cognitoIdentity } from '../lib/identity.js';
import { s3Photos } from '../lib/photos.js';
import { dynamoStore } from '../lib/store.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} manquant`);
  return v;
};

let doc: DynamoDBDocumentClient | undefined;
const client = () => (doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));

export function gameDeps(): Deps {
  const env = need('QCM_ENV') as Env;
  if (!ENVS.includes(env)) throw new Error('QCM_ENV invalide');
  const table = need('TABLE_NAME');
  return { store: dynamoStore(client(), table), quota: dynamoQuotaDb(client(), table), env, now: () => new Date(), ...realRandom };
}

export function familyDeps(): FamilyDeps {
  const base = gameDeps();
  return {
    ...base,
    identity: cognitoIdentity(need('USER_POOL_ID'), new CognitoIdentityProviderClient({})),
    photos: process.env.SCANS_BUCKET ? s3Photos(process.env.SCANS_BUCKET) : { deleteForJobs: () => Promise.reject(new Error('SCANS_BUCKET manquant')) },
    tree: dynamoTreeDb(client(), need('TABLE_NAME')),
    webOrigin: process.env.WEB_ORIGIN ?? '',
  };
}
