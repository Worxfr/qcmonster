// Suppression des photos de cours encore presentes a la suppression d'un eleve ou d'une famille (plan C8).
// Les photos sont sous `scans/<eleveId>/<jobId>/<n>` (SCAN_EVENT_PREFIX); le cycle de vie du bucket les expire de toute facon en 1 a 2 jours.
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SCAN_EVENT_PREFIX } from '../../../shared/names.js';

export interface Photos {
  deleteForStudent(studentId: string): Promise<void>;
  /** Figures conservees (R1): tout `figures/<eleve>/` du bucket des figures. Appelee AVANT la suppression DynamoDB. */
  deleteFiguresForStudent(studentId: string): Promise<void>;
}

async function deletePrefix(client: S3Client, bucket: string, prefix: string): Promise<void> {
  let token: string | undefined;
  do {
    const l = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefix, ContinuationToken: token }));
    const objs = (l.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
    if (objs.length) {
      const d = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } }));
      if (d.Errors?.length) throw new Error('suppression incomplete');
    }
    token = l.NextContinuationToken;
  } while (token);
}

export function s3Photos(bucket: string, client: S3Client = new S3Client({}), figuresBucket?: string): Photos {
  return {
    async deleteFiguresForStudent(studentId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(studentId)) return;
      if (!figuresBucket) return; // R1-A deploye avant le bucket (R1-B): aucune figure n'existe encore
      await deletePrefix(client, figuresBucket, `figures/${studentId}/`);
    },
    async deleteForStudent(studentId) {
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(studentId)) return; // jamais de prefixe construit a partir d'une valeur inattendue
      let token: string | undefined;
      do {
        const l = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${SCAN_EVENT_PREFIX}${studentId}/`, ContinuationToken: token }));
        const objs = (l.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (objs.length) {
          const d = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } }));
          if (d.Errors?.length) throw new Error('suppression de photos incomplete');
        }
        token = l.NextContinuationToken;
      } while (token);
    },
  };
}

export function memoryPhotos(): Photos & { deleted: string[]; deletedFigures: string[] } {
  const deleted: string[] = [];
  const deletedFigures: string[] = [];
  return {
    deleted,
    deletedFigures,
    async deleteFiguresForStudent(studentId) {
      await Promise.resolve();
      deletedFigures.push(studentId);
    },
    async deleteForStudent(studentId) {
      await Promise.resolve();
      deleted.push(studentId);
    },
  };
}
