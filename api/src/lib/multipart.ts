// Ecriture S3 en parties (archive de l'eleve, R1 3.6): jamais plus d'une partie de 8 Mo (et le dernier morceau recu) en memoire.
import { AbortMultipartUploadCommand, CompleteMultipartUploadCommand, CreateMultipartUploadCommand, S3Client, UploadPartCommand } from '@aws-sdk/client-s3';

export const PART_SIZE = 8 * 1024 * 1024;

/** Destination d'un flux: `write` accepte des morceaux de taille quelconque, `finish` renvoie la taille totale, `abort` jette tout. */
export interface Sink {
  write(chunk: Buffer): Promise<void>;
  finish(): Promise<number>;
  abort(): Promise<void>;
}
/** Envoi d'une partie numerotee (a partir de 1). */
export interface PartUploader {
  start(): Promise<void>;
  part(n: number, body: Buffer): Promise<void>;
  complete(): Promise<void>;
  abort(): Promise<void>;
}

/** Regroupe les morceaux en parties de `partSize` octets exactement (sauf la derniere). */
export function partSink(up: PartUploader, partSize = PART_SIZE): Sink & { maxHeld: () => number } {
  let held: Buffer[] = [];
  let heldBytes = 0;
  let maxHeld = 0;
  let n = 0;
  let total = 0;
  let started = false;
  const flush = async (size: number) => {
    const all = Buffer.concat(held);
    await up.part(++n, all.subarray(0, size));
    const rest = all.subarray(size);
    held = rest.length ? [rest] : [];
    heldBytes = rest.length;
  };
  return {
    maxHeld: () => maxHeld,
    async write(chunk) {
      if (!started) {
        started = true;
        await up.start();
      }
      held.push(chunk);
      heldBytes += chunk.length;
      total += chunk.length;
      maxHeld = Math.max(maxHeld, heldBytes);
      while (heldBytes >= partSize) await flush(partSize);
    },
    async finish() {
      if (!started) throw new Error('archive vide');
      if (heldBytes > 0) await flush(heldBytes);
      await up.complete();
      return total;
    },
    async abort() {
      if (started) await up.abort();
    },
  };
}

export function s3Uploader(bucket: string, key: string, client: S3Client = new S3Client({})): PartUploader {
  let uploadId = '';
  const parts: { ETag: string; PartNumber: number }[] = [];
  return {
    async start() {
      const r = await client.send(new CreateMultipartUploadCommand({ Bucket: bucket, Key: key, ContentType: 'application/zip' }));
      uploadId = r.UploadId as string;
    },
    async part(n, body) {
      const r = await client.send(new UploadPartCommand({ Bucket: bucket, Key: key, UploadId: uploadId, PartNumber: n, Body: body }));
      parts.push({ ETag: r.ETag as string, PartNumber: n });
    },
    async complete() {
      await client.send(new CompleteMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId, MultipartUpload: { Parts: parts } }));
    },
    async abort() {
      await client.send(new AbortMultipartUploadCommand({ Bucket: bucket, Key: key, UploadId: uploadId }));
    },
  };
}
