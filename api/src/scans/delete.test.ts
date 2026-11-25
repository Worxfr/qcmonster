// F9: suppression d'un scan non confirme (DELETE /scans/{scanId}).
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { jobsConfirm, scansCreate } from '../pipeline/api.js';
import { jobKey } from '../pipeline/ctx.js';
import { guarded } from '../pipeline/http.js';
import { scansPrefix } from '../pipeline/job.js';
import { awaitConfirm, awaitUpload, scanCheck, scanStart, transcribe } from '../pipeline/steps.js';
import { event, JPEG } from '../pipeline/testkit.js';
import { scansDelete } from './delete.js';
import { body, ev, putJob, world, type World } from './kit.js';
import { scansList } from './list.js';

const del = (t: World, who: 's1' | 's3' | 's9' | 'p1', id: string) => guarded(scansDelete)(t.ctx, ev(who, 'DELETE /scans/{scanId}', { params: { scanId: id } }));
const quota = async (t: World) => (await t.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>;
const listed = async (t: World) => (body(await guarded(scansList)(t.ctx, ev('s1', 'GET /scans'))).items as { scanId: string }[]).map((i) => i.scanId);

/** Scan de 1 page, lu, en attente de confirmation (jeton de reprise pose). */
async function toReview(t: World) {
  const created = JSON.parse((await guarded(scansCreate)(t.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }))).body ?? '{}');
  const i = { jobId: created.jobId as string, sid: 's1' };
  const key = `${scansPrefix('s1', i.jobId)}0`;
  t.s3.objects.set(key, JPEG);
  await scanStart(t.ctx, { detail: { object: { key } } });
  await awaitUpload(t.ctx, { ...i, token: 'tok-up' });
  await scanCheck(t.ctx, i);
  await transcribe(t.ctx, i);
  await awaitConfirm(t.ctx, { ...i, token: 'tok-conf' });
  return { id: i.jobId, key };
}

describe('DELETE /scans/{scanId}', () => {
  it('scan a confirmer: photo, texte et pages effaces, machine liberee, plus rien dans la liste', async () => {
    const t = await world();
    const s = await toReview(t);
    const held = await quota(t);
    expect(held.reserve).toBe(1);
    expect(t.s3.objects.has(s.key)).toBe(true);
    expect((await t.db.query(`JOB#${s.id}`, 'TEXT#')).length).toBeGreaterThan(0);
    expect(await listed(t)).toContain(s.id);

    expect((await del(t, 's1', s.id)).statusCode).toBe(204);
    expect(await quota(t)).toMatchObject({ reserve: 0, restant: held.restant + 1 });
    expect(t.s3.objects.has(s.key)).toBe(false);
    expect(await t.db.query(`JOB#${s.id}`, 'TEXT#')).toHaveLength(0);
    expect(t.sfn.failure).toContainEqual({ token: 'tok-conf', error: 'Cancelled' });
    expect(await listed(t)).not.toContain(s.id);

    // confirmation tardive: refusee, aucune fiche ni cours cree
    const late = await guarded(jobsConfirm)(t.ctx, event({ params: { jobId: s.id }, body: { corrections: [] } }));
    expect(late.statusCode).toBe(409);
    expect(await t.db.query('STUDENT#s1', 'COURS#')).toHaveLength(0);
    expect(await t.db.query('STUDENT#s1', 'DOC#')).toHaveLength(0);
  });

  it('double suppression: la seconde est introuvable et ne rend rien de plus', async () => {
    const t = await world();
    const s = await toReview(t);
    const held = await quota(t);
    expect((await del(t, 's1', s.id)).statusCode).toBe(204);
    const after1 = await quota(t);
    expect((await del(t, 's1', s.id)).statusCode).toBe(404);
    expect((await del(t, 's1', s.id)).statusCode).toBe(404);
    expect(await quota(t)).toEqual(after1);
    expect(after1).toMatchObject({ reserve: 0, restant: held.restant + 1 });
  });

  it('un scan en cours de lecture se supprime aussi (pas d\'attente de 24 h)', async () => {
    const t = await world();
    const created = JSON.parse((await guarded(scansCreate)(t.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }))).body ?? '{}');
    const id = created.jobId as string;
    await t.db.update(jobKey('s1', id), { set: { state: 'transcription' } });
    expect((await quota(t)).reserve).toBe(1);
    expect((await del(t, 's1', id)).statusCode).toBe(204);
    expect((await t.db.get(jobKey('s1', id)))?.state).toBe('rejete');
    expect((await quota(t)).reserve).toBe(0);
    expect(await listed(t)).not.toContain(id);
  });

  it('un scan en echec ou expire se retire de la liste', async () => {
    const t = await world();
    await putJob(t, 's1', 'JE', { state: 'echec', message: 'Boum' });
    await putJob(t, 's1', 'JX', { state: 'expire', message: 'Delai depasse' });
    expect(await listed(t)).toEqual(expect.arrayContaining(['JE', 'JX']));
    expect((await del(t, 's1', 'JE')).statusCode).toBe(204);
    expect((await del(t, 's1', 'JX')).statusCode).toBe(204);
    expect(await listed(t)).not.toContain('JE');
    expect(await listed(t)).not.toContain('JX');
    expect((await del(t, 's1', 'JE')).statusCode).toBe(404);
  });

  it('un scan confirme (verification) ne se supprime pas', async () => {
    const t = await world();
    await putJob(t, 's1', 'JV', { state: 'verification' });
    const r = await del(t, 's1', 'JV');
    expect(r.statusCode).toBe(409);
    expect((await t.db.get(jobKey('s1', 'JV')))?.state).toBe('verification');
  });

  it('isolation: autre famille 404, autre eleve de la famille 404, parent 403; le scan reste intact', async () => {
    const t = await world();
    const s = await toReview(t);
    expect((await del(t, 's9', s.id)).statusCode).toBe(404);
    expect((await del(t, 's3', s.id)).statusCode).toBe(404);
    expect((await del(t, 'p1', s.id)).statusCode).toBe(403);
    expect((await t.db.get(jobKey('s1', s.id)))?.state).toBe('a_confirmer');
    expect(t.s3.objects.has(s.key)).toBe(true);
    expect(await t.db.query(`JOB#${s.id}`, 'TEXT#')).not.toHaveLength(0);
  });

  it('identifiant invalide: 400; inconnu: 404', async () => {
    const t = await world();
    expect((await del(t, 's1', 'nope')).statusCode).toBe(404);
    expect((await del(t, 's1', '../x')).statusCode).toBe(400);
  });
});
