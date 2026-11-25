// Suppression des photos de cours encore presentes (job en cours) a la suppression d'un eleve ou d'une famille (plan C8).
// Les photos sont sous `scans/<jobId>/` (SCAN_EVENT_PREFIX); le cycle de vie du bucket les expire de toute facon en 1 a 2 jours.
import { DeleteObjectsCommand, ListObjectsV2Command, S3Client } from '@aws-sdk/client-s3';
import { SCAN_EVENT_PREFIX } from '../../../shared/names.js';

export interface Photos {
  deleteForJobs(jobIds: string[]): Promise<void>;
}

export function s3Photos(bucket: string, client: S3Client = new S3Client({})): Photos {
  return {
    async deleteForJobs(jobIds) {
      for (const jobId of jobIds) {
        if (!/^[A-Za-z0-9_-]{1,64}$/.test(jobId)) continue; // jamais de prefixe construit a partir d'une valeur inattendue
        let token: string | undefined;
        do {
          const l = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: `${SCAN_EVENT_PREFIX}${jobId}/`, ContinuationToken: token }));
          const objs = (l.Contents ?? []).flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
          if (objs.length) {
            const d = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } }));
            if (d.Errors?.length) throw new Error('suppression de photos incomplete');
          }
          token = l.NextContinuationToken;
        } while (token);
      }
    },
  };
}

export function memoryPhotos(): Photos & { deleted: string[] } {
  const deleted: string[] = [];
  return {
    deleted,
    async deleteForJobs(jobIds) {
      await Promise.resolve();
      deleted.push(...jobIds);
    },
  };
}
