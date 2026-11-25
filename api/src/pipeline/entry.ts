// Point d'entree des Lambda L2a (un seul paquet, une fonction par export). Les dependances AWS sont creees a la premiere
// invocation; les modules de logique (api.ts, steps*.ts, docs.ts) ne connaissent que les ports et se testent sans reseau.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { costStoreFromDynamo, modelPortFromEnv } from '../../../shared/bedrock.js';
import { dynamoQuotaDb } from '../../../shared/quota.js';
import { ENVS, type Env } from '../../../shared/names.js';
import { log } from '../../../shared/log/index.js';
import { docsDelete, docsRead, docsReport } from '../docs/docs.js';
import { jobsCancel, jobsConfirm, jobsGet, jobsTranscription, scansCreate } from './api.js';
import { ulid, type Ctx } from './ctx.js';
import { guarded, json } from './http.js';
import { dynamoDb, type PresignedPost, type ScanStore, type Sfn } from './ports.js';
import { awaitConfirm, awaitUpload, expire, failJob, scanCheck, scanStart, transcribe, type WfInput } from './steps.js';
import { extract, generate, quotaConsume } from './steps-doc.js';

const need = (name: string): string => process.env[name] ?? (() => { throw new Error(`variable ${name} absente`); })();

export async function s3Store(bucket: string): Promise<ScanStore> {
  const { S3Client, GetObjectCommand, ListObjectsV2Command, DeleteObjectsCommand } = await import('@aws-sdk/client-s3');
  const { createPresignedPost } = await import('@aws-sdk/s3-presigned-post');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({});
  const list = async (prefix: string): Promise<string[]> => {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 100 }));
    return (r.Contents ?? []).map((o) => o.Key!).filter(Boolean).sort();
  };
  return {
    async presignPost(o): Promise<PresignedPost> {
      // B4: cle EXACTE choisie par le serveur (`eq $key`): un seul objet possible, nom non choisi par le client, 1 octet a `maxBytes`, type fige.
      const p = await createPresignedPost(s3, {
        Bucket: bucket,
        Key: o.firstKey,
        Expires: o.expiresSec,
        Fields: { 'Content-Type': o.contentType },
        Conditions: [['content-length-range', 1, o.maxBytes], ['eq', '$Content-Type', o.contentType]],
      });
      return { url: p.url, fields: { ...p.fields, key: o.firstKey } };
    },
    presignGet: (key, expiresSec) => getSignedUrl(s3, new GetObjectCommand({ Bucket: bucket, Key: key }), { expiresIn: expiresSec }),
    async head(key, bytes) {
      try {
        const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key, Range: `bytes=0-${bytes - 1}` }));
        const total = Number(/\/(\d+)$/.exec(r.ContentRange ?? '')?.[1] ?? r.ContentLength ?? 0);
        return { bytes: await r.Body!.transformToByteArray(), size: total };
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
    async getBytes(key) {
      const r = await s3.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return r.Body!.transformToByteArray();
    },
    list,
    async deleteAll(prefix) {
      for (let keys = await list(prefix); keys.length; keys = await list(prefix)) {
        await s3.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: keys.map((Key) => ({ Key })), Quiet: true } }));
      }
    },
  };
}

async function sfnPort(arn: string): Promise<Sfn> {
  const { SFNClient, StartExecutionCommand, SendTaskSuccessCommand, SendTaskFailureCommand } = await import('@aws-sdk/client-sfn');
  const c = new SFNClient({});
  const benign = new Set(['ExecutionAlreadyExists', 'TaskDoesNotExist', 'InvalidToken', 'TaskTimedOut']);
  const quiet = async (p: Promise<unknown>) => {
    try {
      await p;
    } catch (e) {
      if (!benign.has((e as { name?: string }).name ?? '')) throw e;
    }
  };
  return {
    start: (name, input) => quiet(c.send(new StartExecutionCommand({ stateMachineArn: arn, name, input: JSON.stringify(input) }))),
    taskSuccess: (t) => quiet(c.send(new SendTaskSuccessCommand({ taskToken: t, output: '{}' }))),
    taskFailure: (t, error) => quiet(c.send(new SendTaskFailureCommand({ taskToken: t, error }))),
  };
}

let cached: Promise<Ctx> | undefined;
function context(): Promise<Ctx> {
  cached ??= (async () => {
    const env = need('QCM_ENV') as Env;
    if (!ENVS.includes(env)) throw new Error('QCM_ENV invalide');
    const client = DynamoDBDocumentClient.from(new DynamoDBClient({}), { marshallOptions: { removeUndefinedValues: true } });
    const table = need('QCM_TABLE');
    return {
      env,
      db: dynamoDb(client, table),
      quota: dynamoQuotaDb(client, table),
      s3: await s3Store(need('QCM_SCANS_BUCKET')),
      sfn: await sfnPort(need('QCM_STATE_MACHINE_ARN')),
      models: { haiku: process.env.QCM_MODEL_HAIKU ?? '', sonnet: process.env.QCM_MODEL_SONNET ?? '' },
      port: await modelPortFromEnv(),
      costStore: costStoreFromDynamo(client, table),
      now: () => new Date(),
      newId: () => ulid(),
    } satisfies Ctx;
  })();
  return cached;
}

type Http = (ctx: Ctx, e: APIGatewayProxyEventV2) => Promise<APIGatewayProxyStructuredResultV2>;
/** Enveloppe HTTP: erreurs metier = reponses du contrat; toute autre erreur = 500 generique (rien du contenu n'est renvoye). */
const http = (name: string, h: Http) => async (e: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  try {
    return await guarded(h)(await context(), e);
  } catch {
    log({ step: name, status: 'error' });
    return json(500, { message: 'Erreur interne' });
  }
};
/** Etape du workflow: l'erreur remonte a Step Functions (Catch -> fail). */
const step = <I, O>(f: (ctx: Ctx, i: I) => Promise<O>) => async (i: I): Promise<O> => f(await context(), i);

export const scansCreateHandler = http('scans-create', scansCreate);
export const jobsGetHandler = http('jobs-get', jobsGet);
export const jobsTranscriptionHandler = http('jobs-transcription', jobsTranscription);
export const jobsConfirmHandler = http('jobs-confirm', jobsConfirm);
export const jobsCancelHandler = http('jobs-cancel', jobsCancel);
export const docsReadHandler = http('docs-read', docsRead);
export const docsDeleteHandler = http('docs-delete', docsDelete);
export const docsReportHandler = http('docs-report', docsReport);

export const scanStartHandler = step(scanStart);
export const awaitUploadHandler = step((c, i: WfInput & { token: string }) => awaitUpload(c, i));
export const scanCheckHandler = step((c, i: WfInput) => scanCheck(c, i));
export const transcribeHandler = step((c, i: WfInput) => transcribe(c, i));
export const awaitConfirmHandler = step((c, i: WfInput & { token: string }) => awaitConfirm(c, i));
export const expireHandler = step((c, i: WfInput & { phase: 'upload' | 'confirm' }) => expire(c, i));
export const extractHandler = step((c, i: WfInput) => extract(c, i));
export const quotaConsumeHandler = step((c, i: WfInput & { verify?: { coutCentimes?: number } }) => quotaConsume(c, i));
export const generateHandler = step((c, i: WfInput) => generate(c, i));
export const failHandler = step((c, i: WfInput & { error?: { Error?: string } }) => failJob(c, i));
