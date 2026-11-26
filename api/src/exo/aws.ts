// Adaptateurs AWS reels de E1 (S3, Step Functions, Lambda, sharp), charges A LA DEMANDE: les tests ne les importent jamais.
// Chaque handler n'appelle que les ports dont son role a le droit (voir shared/exo-access.ts).
import type { CopieFiles, CopieStarter, GenInvoker, Reencoder } from './ports.js';

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`${name} manquant`);
  return v;
};

export function s3Files(bucket: string = need('SCANS_BUCKET')): CopieFiles {
  return {
    async presign(key, contentType, maxBytes, expiresSec) {
      const { S3Client } = await import('@aws-sdk/client-s3');
      const { createPresignedPost } = await import('@aws-sdk/s3-presigned-post');
      // Cle EXACTE (jamais un prefixe), type fige, 1 octet a 3,75 Mo: un seul objet possible, nom non choisi par le client.
      const p = await createPresignedPost(new S3Client({}), { Bucket: bucket, Key: key, Expires: expiresSec, Fields: { 'Content-Type': contentType }, Conditions: [['content-length-range', 1, maxBytes], ['eq', '$Content-Type', contentType]] });
      return { url: p.url, fields: { ...p.fields, key } };
    },
    async list(prefix) {
      const { S3Client, ListObjectsV2Command } = await import('@aws-sdk/client-s3');
      const r = await new S3Client({}).send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, MaxKeys: 10 }));
      return (r.Contents ?? []).map((o) => o.Key!).filter(Boolean);
    },
    async getBytes(key) {
      const { S3Client, GetObjectCommand } = await import('@aws-sdk/client-s3');
      const r = await new S3Client({}).send(new GetObjectCommand({ Bucket: bucket, Key: key }));
      return r.Body!.transformToByteArray();
    },
    async deleteKeys(keys) {
      const { S3Client, DeleteObjectCommand } = await import('@aws-sdk/client-s3');
      const s3 = new S3Client({});
      for (const k of keys) await s3.send(new DeleteObjectCommand({ Bucket: bucket, Key: k })); // cle exacte; absente: S3 repond 204
    },
  };
}

export function sfnStarter(arn: string = need('COPIE_STATE_MACHINE_ARN')): CopieStarter {
  return {
    async start(name, input) {
      const { SFNClient, StartExecutionCommand } = await import('@aws-sdk/client-sfn');
      try {
        await new SFNClient({}).send(new StartExecutionCommand({ stateMachineArn: arn, name, input: JSON.stringify(input) }));
      } catch (e) {
        if ((e as { name?: string }).name !== 'ExecutionAlreadyExists') throw e; // double clic: la meme execution
      }
    },
  };
}

export function lambdaInvoker(fnName: string = need('EXO_GEN_FUNCTION')): GenInvoker {
  return {
    async invoke(input) {
      const { LambdaClient, InvokeCommand } = await import('@aws-sdk/client-lambda');
      await new LambdaClient({}).send(new InvokeCommand({ FunctionName: fnName, InvocationType: 'Event', Payload: Buffer.from(JSON.stringify(input)) }));
    },
  };
}

/** `sharp` vient d'une couche Lambda arm64 (R1-B): import par nom pour que le paquet ne l'embarque pas. */
export function sharpReencoder(): Reencoder {
  return {
    async reencode(image) {
      const name = 'sharp';
      const sharp = (await import(name)).default as (input: Uint8Array, o?: { limitInputPixels?: number }) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
      // shortcut: limite de 50 Mpixels a mesurer sur de vraies photos (design 5.4). `rotate()` applique l'orientation, la sortie n'a ni EXIF ni GPS.
      return new Uint8Array(await sharp(image, { limitInputPixels: 50_000_000 }).rotate().resize({ width: 1600, height: 1600, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 82 }).toBuffer());
    },
  };
}
