// R1-A: suppression des figures a la suppression d'un eleve ou d'une famille, et mode sans bucket (B1, C3 de la relecture de la PR #94).
import { afterEach, describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { deleteFamily } from '../family/family.js';
import { deleteStudent } from '../family/students.js';
import { memoryPhotos, s3Photos } from './photos.js';
import { FID, parentCtx, seed, SID, testDeps } from './testkit.js';

type Sent = { name: string; input: Record<string, unknown> };
const fakeS3 = (o: { fail?: 'list' | 'delete' } = {}) => {
  const calls: Sent[] = [];
  const client = {
    send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
      calls.push({ name: c.constructor.name, input: c.input });
      if (o.fail === 'list') throw new Error('S3 indisponible');
      if (c.constructor.name === 'ListObjectsV2Command') return { Contents: [{ Key: 'figures/stu1/c1/f1.jpg' }] };
      return { Errors: o.fail === 'delete' ? [{ Code: 'AccessDenied' }] : undefined };
    },
  };
  return { calls, client: client as never };
};

describe('deleteFiguresForStudent', () => {
  it('bucket configure: liste puis supprime figures/<eleve>/ (jamais un autre prefixe); une erreur S3 est levee', async () => {
    const ok = fakeS3();
    await s3Photos('scans', ok.client, 'figs').deleteFiguresForStudent('stu1');
    expect(ok.calls[0].input).toMatchObject({ Bucket: 'figs', Prefix: 'figures/stu1/' });
    expect(ok.calls.some((c) => c.name === 'DeleteObjectsCommand')).toBe(true);
    await expect(s3Photos('scans', fakeS3({ fail: 'list' }).client, 'figs').deleteFiguresForStudent('stu1')).rejects.toThrow('S3 indisponible');
    await expect(s3Photos('scans', fakeS3({ fail: 'delete' }).client, 'figs').deleteFiguresForStudent('stu1')).rejects.toThrow('incomplete');
    const bad = fakeS3();
    await s3Photos('scans', bad.client, 'figs').deleteFiguresForStudent('../x');
    expect(bad.calls).toEqual([]);
  });
  it('bucket absent (R1-A deploye avant R1-B): sans effet, sans appel S3, avec un avertissement', async () => {
    const s = fakeS3();
    const out: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((x: string) => (out.push(String(x)), true)) as never;
    try {
      await s3Photos('scans', s.client).deleteFiguresForStudent('stu1');
    } finally {
      process.stdout.write = write;
    }
    expect(s.calls).toEqual([]);
    expect(out.join('')).toContain('figures-bucket-absent');
  });
});

describe('runtime sans FIGURES_BUCKET', () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });
  it('familyDeps() se construit et sa suppression de figures est sans effet', async () => {
    Object.assign(process.env, { QCM_ENV: 'dev', TABLE_NAME: 't', USER_POOL_ID: 'p', SCANS_BUCKET: 'b', AWS_REGION: 'eu-west-3', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x' });
    delete process.env.FIGURES_BUCKET;
    const { familyDeps } = await import('../handlers/runtime.js');
    await expect(familyDeps().photos.deleteFiguresForStudent('stu1')).resolves.toBeUndefined();
  });
});

describe('suppression d\'un eleve et d\'une famille: figures et archives', () => {
  it('deleteStudent: figures/<eleve>/ et exports/<eleve>/ supprimes AVANT l\'arbre DynamoDB (retirer l\'appel fait echouer ce test)', async () => {
    const t = testDeps();
    await seed(t);
    await t.archives.put(`exports/${SID}/e1.zip`, Buffer.from('x'));
    const order: string[] = [];
    const photos = memoryPhotos();
    const orig = photos.deleteFiguresForStudent;
    photos.deleteFiguresForStudent = async (s) => {
      order.push(`figures:${(await t.store.get(keys.student(FID, SID))) ? 'ligne-eleve-presente' : 'ligne-eleve-absente'}`);
      return orig(s);
    };
    t.deps.photos = photos;
    await deleteStudent(t.deps, parentCtx, SID);
    expect(photos.deletedFigures).toEqual([SID]);
    expect(order).toEqual(['figures:ligne-eleve-presente']); // S3 d'abord: tant qu'une image existe, l'element qui la retrouve existe
    expect([...t.archives.objects.keys()].filter((k) => k.startsWith(`exports/${SID}/`))).toEqual([]);
    expect(await t.store.get(keys.student(FID, SID))).toBeUndefined();
  });
  it('deleteFamily: les figures de CHAQUE eleve sont supprimees', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { sid: 'stu2', docId: 'doc2' });
    await deleteFamily(t.deps, parentCtx);
    expect([...t.photos.deletedFigures].sort()).toEqual([SID, 'stu2']);
  });
  it('sans bucket des figures, la suppression d\'un eleve va jusqu\'au bout (compte et arbre supprimes)', async () => {
    const t = testDeps();
    await seed(t);
    t.deps.photos = s3Photos('scans', fakeS3().client); // pas de bucket des figures
    await t.identity.attachFamily(SID, FID);
    await deleteStudent(t.deps, parentCtx, SID);
    expect(t.identity.users.has(SID)).toBe(false);
    expect(await t.store.get(keys.student(FID, SID))).toBeUndefined();
  });
});
