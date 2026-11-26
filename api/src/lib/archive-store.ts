// Stockage des archives d'export (H1-B): objets prives `exports/<familyId>/<id>.zip` du bucket existant, lien signe de 10 minutes.
// Le bucket expire tout objet apres 1 jour (regle `expire-1-day`, donc suppression effective sous 2 jours); la suppression de la famille efface aussi le prefixe.
import { DeleteObjectsCommand, GetObjectCommand, ListObjectsV2Command, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';

export const EXPORT_PREFIX = 'exports/';
export const LINK_TTL_S = 600;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
export const exportKey = (familyId: string, id: string): string => `${EXPORT_PREFIX}${familyId}/${id}.zip`;
/** Marqueur ecrit AVANT la construction: c'est lui que la limite horaire compte (l'archive finie porte la meme cle en `.zip`). */
export const lockKey = (familyId: string, id: string): string => `${EXPORT_PREFIX}${familyId}/${id}.lock`;

export interface ArchiveStore {
  put(key: string, body: Buffer): Promise<void>;
  /** Lien de telechargement signe, valable `LINK_TTL_S` secondes. Jamais journalise. */
  signedUrl(key: string): Promise<string>;
  /** Objets de la famille encore presents (cle et date en ms). */
  list(familyId: string): Promise<{ key: string; at: number }[]>;
  /** Supprime toutes les archives de la famille. */
  deleteFamily(familyId: string): Promise<void>;
}

export function s3Archives(bucket: string, client: S3Client = new S3Client({})): ArchiveStore {
  const prefixOf = (familyId: string): string => {
    if (!ID.test(familyId)) throw new RangeError('identifiant invalide'); // jamais de prefixe construit a partir d'une valeur inattendue
    return `${EXPORT_PREFIX}${familyId}/`;
  };
  async function* pages(familyId: string) {
    let token: string | undefined;
    do {
      const l = await client.send(new ListObjectsV2Command({ Bucket: bucket, Prefix: prefixOf(familyId), ContinuationToken: token }));
      yield l.Contents ?? [];
      token = l.NextContinuationToken;
    } while (token);
  }
  return {
    async put(key, body) {
      await client.send(new PutObjectCommand({ Bucket: bucket, Key: key, Body: body, ContentType: 'application/zip' }));
    },
    signedUrl: (key) =>
      getSignedUrl(client, new GetObjectCommand({ Bucket: bucket, Key: key, ResponseContentType: 'application/zip', ResponseContentDisposition: 'attachment; filename="qcmonster-export.zip"' }), { expiresIn: LINK_TTL_S }),
    async list(familyId) {
      const out: { key: string; at: number }[] = [];
      for await (const page of pages(familyId)) for (const o of page) if (o.Key && o.LastModified) out.push({ key: o.Key, at: o.LastModified.getTime() });
      return out;
    },
    async deleteFamily(familyId) {
      for await (const page of pages(familyId)) {
        const objs = page.flatMap((o) => (o.Key ? [{ Key: o.Key }] : []));
        if (!objs.length) continue;
        const d = await client.send(new DeleteObjectsCommand({ Bucket: bucket, Delete: { Objects: objs, Quiet: true } }));
        if (d.Errors?.length) throw new Error('suppression des archives incomplete');
      }
    },
  };
}

export function memoryArchives(now: () => Date = () => new Date()): ArchiveStore & { objects: Map<string, { body: Buffer; at: number }>; urls: string[] } {
  const objects = new Map<string, { body: Buffer; at: number }>();
  const urls: string[] = [];
  return {
    objects,
    urls,
    async put(key, body) {
      await Promise.resolve();
      objects.set(key, { body, at: now().getTime() });
    },
    async signedUrl(key) {
      await Promise.resolve();
      const u = `https://example.invalid/${key}?X-Amz-Expires=${LINK_TTL_S}`;
      urls.push(u);
      return u;
    },
    async list(familyId) {
      await Promise.resolve();
      return [...objects].filter(([k]) => k.startsWith(`${EXPORT_PREFIX}${familyId}/`)).map(([key, v]) => ({ key, at: v.at }));
    },
    async deleteFamily(familyId) {
      await Promise.resolve();
      for (const k of [...objects.keys()]) if (k.startsWith(`${EXPORT_PREFIX}${familyId}/`)) objects.delete(k);
    },
  };
}
