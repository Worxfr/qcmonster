// Lecture du bucket des figures pour l'archive de l'eleve (R1 3.6): liste avec tailles, lecture d'une image a la fois.
import { GetObjectCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import type { FigureReader } from '../family/student-export.js';

export function s3FigureReader(bucket: string, client: S3Client = new S3Client({})): FigureReader {
  return {
    async list(prefix) {
      const out: { key: string; size: number }[] = [];
      let token: string | undefined;
      do {
        const r = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
        for (const o of r.Contents ?? []) if (o.Key) out.push({ key: o.Key, size: o.Size ?? 0 });
        token = r.NextContinuationToken;
      } while (token);
      return out;
    },
    async get(key) {
      try {
        const r = await client.send(new GetObjectCommand({ Bucket: bucket, Key: key }));
        return Buffer.from(await (r.Body as { transformToByteArray(): Promise<Uint8Array> }).transformToByteArray());
      } catch (e) {
        if ((e as { name?: string }).name === 'NoSuchKey') return undefined;
        throw e;
      }
    },
  };
}
