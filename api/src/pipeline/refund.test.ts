// Rendu des pages apres un echec serveur survenu APRES la consommation du quota (decision du proprietaire): une seule fois, rejouable,
// jamais en double avec le rendu d'annulation, de rejet ou d'expiration.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import * as api from './api.js';
import { jobKey } from './ctx.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { applyQuotaOnce, returnQuotaOnce } from './quota-ops.js';
import { awaitConfirm, awaitUpload, expire, failJob, scanCheck, scanStart, transcribe } from './steps.js';
import { extract, generate, quotaConsume } from './steps-doc.js';
import { event, goodScript, JPEG, makeCtx } from './testkit.js';

type K = Awaited<ReturnType<typeof makeCtx>>;
const scansCreate = guarded(api.scansCreate);
const jobsConfirm = guarded(api.jobsConfirm);
const jobsCancel = guarded(api.jobsCancel);
const quota = async (k: K) => (await k.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>;
const family = async (k: K) => (await k.quota.get(keys.quotaFamily('f1', '2026-12'))) as Record<string, number>;
const job = async (k: K, id: string) => (await k.db.get(jobKey('s1', id)))!;

/** Job arrive a l'etape de verification (pages reservees, pas encore consommees). */
async function verified(k: K) {
  const created = JSON.parse((await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }))).body ?? '{}');
  const i = { jobId: created.jobId as string, sid: 's1' };
  const key = `${scansPrefix('s1', i.jobId)}0`;
  k.s3.objects.set(key, JPEG);
  await scanStart(k.ctx, { detail: { object: { key } } });
  await awaitUpload(k.ctx, { ...i, token: 'tok-up' });
  await scanCheck(k.ctx, i);
  await transcribe(k.ctx, i);
  await awaitConfirm(k.ctx, { ...i, token: 'tok-conf' });
  await jobsConfirm(k.ctx, event({ params: { jobId: i.jobId }, body: { corrections: [] } }));
  const ex = await extract(k.ctx, i);
  for (const c of await k.db.query(`DOC#${ex.docId}`, 'CLAIM#')) await k.db.put({ ...keys.verdict(ex.docId!, Number(c.SK.slice(6))), statut: 'verifiee', secondeLecture: false, sources: [] });
  return { jobId: i.jobId, i };
}
const settled = { reserve: 0, utilise: 0, restant: 200 };

describe('rendu des pages apres consommation', () => {
  it('echec de la generation apres la consommation: les pages sont rendues, eleve et famille', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    expect(await quota(k)).toMatchObject({ utilise: 1, restant: 199 });
    k.ctx.port = { converse: async () => { throw new Error('Bedrock indisponible'); } };
    await expect(generate(k.ctx, u.i)).rejects.toThrow();
    await failJob(k.ctx, { ...u.i, error: { Error: 'Error' } }); // le Catch de la machine
    expect((await job(k, u.jobId)).state).toBe('echec');
    expect((await job(k, u.jobId)).quotaState).toBe('refunded');
    expect(await quota(k)).toMatchObject(settled);
    expect(await family(k)).toMatchObject({ reserve: 0, utilise: 0, restant: 500 });
  });
  it('rejeu de failJob et du rendu: un seul rendu', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    await failJob(k.ctx, u.i);
    await failJob(k.ctx, u.i);
    await failJob(k.ctx, u.i);
    await returnQuotaOnce(k.ctx, 's1', u.jobId);
    expect(await quota(k)).toMatchObject(settled);
    expect(await family(k)).toMatchObject({ reserve: 0, utilise: 0, restant: 500 });
  });
  it('arret entre l ecriture de la consommation et le drapeau: l echec rend quand meme les pages', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'consume'); // quotaState reste `reserved`
    await failJob(k.ctx, u.i);
    expect(await quota(k)).toMatchObject(settled);
    expect((await job(k, u.jobId)).quotaState).toBe('refunded');
  });
  it('arret entre l ecriture du rendu et le drapeau: la relance ne rend pas deux fois', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'refund'); // rendu ecrit, drapeau `consumed`
    await returnQuotaOnce(k.ctx, 's1', u.jobId);
    await failJob(k.ctx, u.i);
    expect(await quota(k)).toMatchObject(settled);
    expect(await family(k)).toMatchObject({ reserve: 0, utilise: 0, restant: 500 });
  });
  it('rendu applique directement deux fois: la seconde est refusee', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    expect(await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'refund')).toBe(true);
    expect(await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'refund')).toBe(false);
    expect(await quota(k)).toMatchObject(settled);
  });
  it('rendu refuse sans consommation; apres un rendu de reservation, ni rendu ni consommation', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    expect(await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'refund')).toBe(false);
    expect(await quota(k)).toMatchObject({ reserve: 1, utilise: 0 });
    await failJob(k.ctx, u.i); // echec avant consommation: rendu de la reservation
    expect(await quota(k)).toMatchObject(settled);
    expect(await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'refund')).toBe(false);
    expect(await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'consume')).toBe(false);
    expect((await job(k, u.jobId)).quotaState).toBe('released');
    expect(await quota(k)).toMatchObject(settled);
  });
  it('annulation et expiration apres un echec rendu: aucun second rendu', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    await failJob(k.ctx, u.i);
    expect((await jobsCancel(k.ctx, event({ params: { jobId: u.jobId } }))).statusCode).toBe(409);
    await expire(k.ctx, { ...u.i, phase: 'confirm' });
    expect(await quota(k)).toMatchObject(settled);
    expect(await family(k)).toMatchObject({ reserve: 0, utilise: 0, restant: 500 });
  });
  it('job termine: les pages restent consommees, un failJob tardif n y change rien', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    await k.db.update(jobKey('s1', u.jobId), { set: { state: 'termine' } });
    await failJob(k.ctx, u.i);
    expect(await quota(k)).toMatchObject({ utilise: 1, restant: 199 });
  });
  it('transaction du rendu en echec: le cours est quand meme supprime, puis la relance rend les pages une fois', async () => {
    for (const relance of [false, true]) {
      const k = await makeCtx(goodScript());
      const u = await verified(k);
      await quotaConsume(k.ctx, u.i);
      expect((await k.db.query('STUDENT#s1', `COURS#${u.jobId}#T`)).length).toBeGreaterThan(0);
      const transact = k.ctx.db.transact.bind(k.ctx.db);
      k.ctx.db.transact = async () => { throw new Error('DynamoDB indisponible'); };
      if (relance) await k.db.update(jobKey('s1', u.jobId), { set: { state: 'echec' } });
      await expect(failJob(k.ctx, u.i)).rejects.toThrow('DynamoDB indisponible');
      expect(await k.db.query('STUDENT#s1', `COURS#${u.jobId}#T`)).toHaveLength(0);
      expect(await k.db.query('STUDENT#s1', 'DOC#')).toHaveLength(0);
      expect(k.s3.objects.size).toBe(0);
      k.ctx.db.transact = transact;
      await failJob(k.ctx, u.i);
      await failJob(k.ctx, u.i);
      expect(await quota(k)).toMatchObject(settled);
    }
  });
  it('le drapeau refunded suit le rendu, et un release refuse ne change pas le drapeau', async () => {
    const k = await makeCtx(goodScript());
    const u = await verified(k);
    await quotaConsume(k.ctx, u.i);
    await returnQuotaOnce(k.ctx, 's1', u.jobId);
    expect((await job(k, u.jobId)).quotaState).toBe('refunded');
    await k.db.update(jobKey('s1', u.jobId), { set: { quotaState: 'consumed' } });
    await k.db.remove([{ PK: 'FAMILY#f1', SK: `QUOTAOP#${u.jobId}#refund` }]);
    await applyQuotaOnce(k.ctx, await job(k, u.jobId), 'release'); // refus: marqueur consume
    expect((await job(k, u.jobId)).quotaState).toBe('consumed');
  });
});
