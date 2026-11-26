// Assemblage des dependances reelles des Lambda L3. Lu a la premiere invocation (pas a l'import) pour que les tests importent sans environnement.
import { CognitoIdentityProviderClient } from '@aws-sdk/client-cognito-identity-provider';
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, PutCommand } from '@aws-sdk/lib-dynamodb';
import type { InviteDeps } from '../admin/invitations.js';
import { dynamoTreeDb } from '../../../shared/delete-tree.js';
import { ENVS, type Env } from '../../../shared/names.js';
import { dynamoQuotaDb } from '../../../shared/quota.js';
import type { ArchiveDeps } from '../family/archive.js';
import type { FamilyDeps } from '../family/ports.js';
import { memoryArchives, s3Archives, type ArchiveStore } from '../lib/archive-store.js';
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

const archivesOf = (): ArchiveStore => (process.env.SCANS_BUCKET ? s3Archives(process.env.SCANS_BUCKET) : { ...memoryArchives(), deleteFamily: () => Promise.reject(new Error('SCANS_BUCKET manquant')) });

/** Archive d'export (H1-B): lecture de la famille, ecriture S3 sous exports/ seulement. */
export function archiveDeps(): ArchiveDeps {
  return { ...gameDeps(), archives: s3Archives(need('SCANS_BUCKET')) };
}

export function familyDeps(): FamilyDeps {
  const base = gameDeps();
  return {
    ...base,
    identity: cognitoIdentity(need('USER_POOL_ID'), new CognitoIdentityProviderClient({})),
    photos: process.env.SCANS_BUCKET ? s3Photos(process.env.SCANS_BUCKET, undefined, process.env.FIGURES_BUCKET) : { deleteForStudent: () => Promise.reject(new Error('SCANS_BUCKET manquant')), deleteFiguresForStudent: () => Promise.reject(new Error('SCANS_BUCKET manquant')) },
    archives: archivesOf(),
    tree: dynamoTreeDb(client(), need('TABLE_NAME')),
    webOrigin: process.env.WEB_ORIGIN ?? '',
  };
}

/** Invitations (administrateur): PutItem conditionnel seulement, le role IAM n'a pas d'autre droit. */
export function inviteDeps(): InviteDeps {
  const table = need('TABLE_NAME');
  return {
    now: () => new Date(),
    db: {
      async putNew(item) {
        try {
          await client().send(new PutCommand({ TableName: table, Item: item, ConditionExpression: 'attribute_not_exists(PK)' }));
          return true;
        } catch (e) {
          if ((e as { name?: string }).name === 'ConditionalCheckFailedException') return false;
          throw e;
        }
      },
    },
  };
}
