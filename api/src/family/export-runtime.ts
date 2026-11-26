// Dependances de l'archive de l'eleve (R1), dans la fonction du paquet pipeline: noms de variables du paquet (QCM_*), sans le client Cognito.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient, UpdateCommand } from '@aws-sdk/lib-dynamodb';
import { InvokeCommand, LambdaClient } from '@aws-sdk/client-lambda';
import { ENVS, type Env } from '../../../shared/names.js';
import { dynamoQuotaDb } from '../../../shared/quota.js';
import type { StudentExportDeps } from './student-export.js';
import { s3Archives } from '../lib/archive-store.js';
import { realRandom } from '../lib/deps.js';
import { s3FigureReader } from '../lib/figure-reader.js';
import { partSink, s3Uploader } from '../lib/multipart.js';
import { dynamoStore } from '../lib/store.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} manquant`);
  return v;
};

let doc: DynamoDBDocumentClient | undefined;
const client = () => (doc ??= DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } }));

/** Variables: QCM_ENV, QCM_TABLE, QCM_SCANS_BUCKET (bucket d'export, prefixe exports/), QCM_FIGURES_BUCKET, QCM_EXPORT_FUNCTION (route seulement). */
export function studentExportDeps(): StudentExportDeps {
  const env = need('QCM_ENV') as Env;
  if (!ENVS.includes(env)) throw new Error('QCM_ENV invalide');
  const table = need('QCM_TABLE');
  const bucket = need('QCM_SCANS_BUCKET');
  return {
    store: dynamoStore(client(), table),
    quota: dynamoQuotaDb(client(), table),
    env,
    now: () => new Date(),
    ...realRandom,
    archives: s3Archives(bucket),
    figures: process.env.QCM_FIGURES_BUCKET ? s3FigureReader(process.env.QCM_FIGURES_BUCKET) : { list: async () => [], get: async () => undefined }, // sans bucket: pas de figures dans l'archive
    openSink: (key) => partSink(s3Uploader(bucket, key)),
    async launch(payload) {
      await new LambdaClient({}).send(new InvokeCommand({ FunctionName: need('QCM_EXPORT_FUNCTION'), InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(payload)) }));
    },
    // La construction n'a que `UpdateItem` sur STUDENT#* (pas de PutItem): l'etat s'ecrit par une mise a jour ciblee.
    async update(key, attrs) {
      const names = Object.keys(attrs);
      await client().send(
        new UpdateCommand({
          TableName: table,
          Key: key,
          UpdateExpression: `SET ${names.map((_, k) => `#a${k} = :v${k}`).join(', ')}`,
          ConditionExpression: 'attribute_exists(PK)',
          ExpressionAttributeNames: Object.fromEntries(names.map((n, k) => [`#a${k}`, n])),
          ExpressionAttributeValues: Object.fromEntries(names.map((n, k) => [`:v${k}`, attrs[n]])),
        }),
      );
    },
  };
}
