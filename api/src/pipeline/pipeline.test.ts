import { describe, expect, it } from 'vitest';
import { DocSchema, JobSchema, ScanCreateResponseSchema, TranscriptionSchema } from '../../../shared/contract/generated/schemas.js';
import { keys } from '../../../shared/ddb/keys.js';
import { DEV_TRIAL_CAP_EUR } from '../../../shared/names.js';
import { deleteDocTree } from '../../../shared/delete-tree.js';
import { parseQuestionId, QcmItemSchema, VerifyInputSchema } from '../../../shared/items.js';
import * as docs from '../docs/docs.js';
import * as api from './api.js';
import { guarded } from './http.js';
import { jobKey } from './ctx.js';
import { scansPrefix } from './job.js';
import { treeDbFrom } from './ports.js';
import { awaitConfirm, awaitUpload, expire, failJob, scanCheck, scanStart, transcribe } from './steps.js';
import { budgetLeftCents, extract, quotaConsume } from './steps-doc.js';
import { classifyJson, readJson, event, genFin, goodScript, JPEG, makeCtx, parent, PNG } from './testkit.js';

const { docsDelete, docsRead, docsReport } = { docsDelete: guarded(docs.docsDelete), docsRead: guarded(docs.docsRead), docsReport: guarded(docs.docsReport) };
const { jobsCancel, jobsConfirm, jobsGet, jobsTranscription, scansCreate } = {
  jobsCancel: guarded(api.jobsCancel), jobsConfirm: guarded(api.jobsConfirm), jobsGet: guarded(api.jobsGet),
  jobsTranscription: guarded(api.jobsTranscription), scansCreate: guarded(api.scansCreate),
};
type K = Awaited<ReturnType<typeof makeCtx>>;
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}');
const qState = async (k: K) => (await k.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>;

/** Cree un job et depose `n` images valides, comme le ferait l'eleve; envoie les evenements S3. */
async function upload(k: K, pages = 1, bytes: Uint8Array = JPEG) {
  const r = await scansCreate(k.ctx, event({ body: { pages, contentType: 'image/jpeg' } }));
  expect(r.statusCode).toBe(201);
  const created = body(r);
  const jobId: string = created.jobId;
  for (let n = 0; n < pages; n++) {
    const key = `${scansPrefix('s1', jobId)}${n}`;
    k.s3.objects.set(key, bytes);
    await scanStart(k.ctx, { detail: { object: { key } } });
  }
  return { jobId, created, i: { jobId, sid: 's1' } };
}
const job = async (k: K, jobId: string) => (await k.db.get(jobKey('s1', jobId)))!;

/** Faux verify-run (L2b): ecrit un verdict `verifiee` pour chaque affirmation. */
async function fakeVerify(k: K, docId: string) {
  for (const c of await k.db.query(`DOC#${docId}`, 'CLAIM#')) {
    const nn = c.SK.slice(6);
    await k.db.put({ ...keys.verdict(docId, Number(nn)), statut: 'verifiee', niveau: 2, secondeLecture: false, sources: [] });
  }
  return { coutCentimes: 3, nbVerifiees: 4, nbErreurs: 0, nbNonVerifiables: 0 };
}

async function toConfirm(k: K, pages = 1) {
  const u = await upload(k, pages);
  await awaitUpload(k.ctx, { ...u.i, token: 'tok-up' });
  expect(k.sfn.success).toContain('tok-up'); // tous les fichiers sont la: l'attente est levee
  expect((await scanCheck(k.ctx, u.i)).ok).toBe(true);
  expect((await transcribe(k.ctx, u.i)).ok).toBe(true);
  await awaitConfirm(k.ctx, { ...u.i, token: 'tok-conf' });
  return u;
}

describe('parcours complet', () => {
  it('scan -> transcription -> confirmation -> fiche, QCM et trous', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    expect(ScanCreateResponseSchema.safeParse(u.created).success).toBe(true);
    expect((await job(k, u.jobId)).state).toBe('a_confirmer');

    // transcription lue par l'eleve (photo encore presente) puis corrigee
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(TranscriptionSchema.safeParse(t).success).toBe(true);
    expect(t.photoUrls).toHaveLength(1);
    const conf = await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [{ id: 'p1-s1', text: 'La photosynthese est un processus vital.' }] } }));
    expect(conf.statusCode).toBe(200);
    expect(k.s3.objects.size).toBe(0); // image supprimee a la confirmation
    expect(k.sfn.success).toContain('tok-conf');
    expect((await k.db.get({ PK: `JOB#${u.jobId}`, SK: 'TEXT#1' }))!.sentences).toContainEqual({ id: 'p1-s1', text: 'La photosynthese est un processus vital.' });

    const ex = await extract(k.ctx, u.i);
    expect(ex.ok).toBe(true);
    const claims = await k.db.query(`DOC#${ex.docId}`, 'CLAIM#');
    expect(claims).toHaveLength(4); // 6 proposees, 2 non ancrees supprimees
    expect(VerifyInputSchema.safeParse({ jobId: u.jobId, docId: ex.docId, budgetRestantCentimes: ex.budgetRestantCentimes }).success).toBe(true);
    expect((await k.db.query(`DOC#${ex.docId}`, 'VERDICT#')).length).toBe(0); // L2a n'ecrit jamais VERDICT

    const verify = await fakeVerify(k, ex.docId!);
    const before = await qState(k);
    expect(before).toMatchObject({ reserve: 1, utilise: 0 });
    await quotaConsume(k.ctx, { ...u.i, verify });
    await quotaConsume(k.ctx, { ...u.i, verify }); // relance: sans effet
    expect(await qState(k)).toMatchObject({ reserve: 0, utilise: 1 });

    const gen = await genFin(k.ctx, u.i);
    expect(gen).toMatchObject({ qcm: 2, gaps: 1, doublon: false }); // QCM 2 rejete a l'aveugle, QCM 99 inconnu, trou 2 faux
    const qcms = (await k.db.query(`DOC#${ex.docId}`, 'QCM#')).map((q) => QcmItemSchema.parse(q));
    expect(qcms.map((q) => parseQuestionId(q.questionId).nn)).toEqual([1, 2]);
    expect(qcms[0].questionId).toBe(`${ex.docId}:qcm:01`);
    // la cle pointe toujours sur la bonne reponse apres melange
    expect(qcms[0].choix[qcms[0].cle]).toBe('Dans les chloroplastes');
    expect(qcms[1].choix[qcms[1].cle]).toBe('Le dioxygene');
    expect((await k.db.query(`DOC#${ex.docId}`, 'GAP#'))[0].questionId).toBe(`${ex.docId}:gap:01`);

    const j = await job(k, u.jobId);
    expect(j.state).toBe('termine');
    expect(j.docId).toBe(ex.docId);
    // cout mesure: 3 appels Haiku (transcription, extraction, generation) + controle + 3 centimes de L2b, en centimes arrondis au-dessus
    expect(j.coutMicros as number).toBeGreaterThan(30_000);
    const view = body(await jobsGet(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(JobSchema.safeParse(view).success).toBe(true);
    expect(view.costCents).toBe(j.coutCentimes);
    expect(view.costCents).toBeGreaterThanOrEqual(4);
    expect(view.state).toBe('termine');

    // lecture: CLAIM + VERDICT assembles, aucune cle ni mot attendu
    const doc = await docsRead(k.ctx, event({ params: { docId: ex.docId! } }));
    const d = body(doc);
    expect(DocSchema.safeParse(d).success).toBe(true);
    expect(d.claims).toHaveLength(4);
    expect(d.claims[0].status).toBe('verifiee');
    expect(d.summary).toContain('plantes');
    expect(doc.body).not.toMatch(/"cle"|attendu|choix/);
    const list = body(await docsRead(k.ctx, event()));
    expect(list.items).toHaveLength(1);
    expect(body(await docsRead(k.ctx, parent())).items).toHaveLength(1); // le parent voit la famille
    expect((await docsRead(k.ctx, parent({ params: { docId: ex.docId! } }))).statusCode).toBe(200);

    // un seul nombre de photos dans S3 apres la fin
    expect(k.s3.objects.size).toBe(0);
  });

  it('F8: extraction coupee par la limite de jetons: les affirmations entieres sont gardees', async () => {
    const full = JSON.stringify(JSON.parse(goodScript().extraction as string));
    const cut = full.slice(0, full.indexOf('"phraseId":"p1-s5"') - 2); // coupe en plein tableau, 2 affirmations entieres + la 3e commencee
    const k = await makeCtx(goodScript({ extraction: cut + '{"phraseId":"p1-s5","extrait":"rej' }));
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    const ex = await extract(k.ctx, u.i);
    expect(ex.ok).toBe(true);
    expect(await k.db.query(`DOC#${ex.docId}`, 'CLAIM#')).toHaveLength(2);
  });

  it('F8: extraction sans aucune affirmation entiere: toujours une erreur', async () => {
    const k = await makeCtx(goodScript({ extraction: '{"titre":"x","matiere":"svt","affirmations":[{"phraseId":"p1-s2","extr' }));
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    await expect(extract(k.ctx, u.i)).rejects.toThrow('sortie du modele');
  });

  it('F8: une sortie de modele inutilisable donne un message precis a l eleve', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await failJob(k.ctx, { ...u.i, error: { Error: 'ModelOutputError' } });
    expect((await job(k, u.jobId)).message).toContain('trop dense');
  });

  it('un second scan du meme cours est un doublon', async () => {
    const k = await makeCtx(goodScript());
    const ids: string[] = [];
    for (let n = 0; n < 2; n++) {
      const u = await toConfirm(k);
      await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
      const ex = await extract(k.ctx, u.i);
      await quotaConsume(k.ctx, { ...u.i, verify: await fakeVerify(k, ex.docId!) });
      ids.push((await genFin(k.ctx, u.i)).doublon ? 'dup' : 'new');
    }
    expect(ids).toEqual(['new', 'dup']);
  });

  it('une relance de generate apres publication ne double rien', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    const ex = await extract(k.ctx, u.i);
    await quotaConsume(k.ctx, { ...u.i, verify: await fakeVerify(k, ex.docId!) });
    await genFin(k.ctx, u.i);
    const calls = k.calls.length;
    expect((await genFin(k.ctx, u.i)).docId).toBe(ex.docId);
    expect(k.calls.length).toBe(calls);
  });
});

describe('refus et nettoyage', () => {
  it('document de type autre: refuse, quota rendu, photo supprimee', async () => {
    const k = await makeCtx(goodScript({ classify: classifyJson({ docType: 'autre' }) }));
    const u = await upload(k);
    await awaitUpload(k.ctx, { ...u.i, token: 't' });
    await scanCheck(k.ctx, u.i);
    expect((await transcribe(k.ctx, u.i)).ok).toBe(false);
    const j = await job(k, u.jobId);
    expect(j.state).toBe('rejete');
    expect(await qState(k)).toMatchObject({ reserve: 0, utilise: 0, restant: 200 });
    expect(k.s3.objects.size).toBe(0);
    expect((await k.db.query(`JOB#${u.jobId}`)).length).toBe(0); // aucun texte garde
  });

  it('moins de 40 mots: refuse et quota rendu', async () => {
    const k = await makeCtx(goodScript({ transcription: (pages) => readJson(pages.map((page) => ({ page, lines: ['Un cours bien trop court.'] }))) }));
    const u = await upload(k);
    await awaitUpload(k.ctx, { ...u.i, token: 't' });
    await scanCheck(k.ctx, u.i);
    expect((await transcribe(k.ctx, u.i)).ok).toBe(false);
    expect((await job(k, u.jobId)).message).toMatch(/trop court/);
    expect((await qState(k)).restant).toBe(200);
  });

  it('fichier dont le contenu n est pas une image: rejete (type controle sur les octets)', async () => {
    const k = await makeCtx(goodScript());
    const u = await upload(k, 1, new Uint8Array([0x25, 0x50, 0x44, 0x46, 1, 2, 3, 4])); // %PDF
    await awaitUpload(k.ctx, { ...u.i, token: 't' });
    expect((await scanCheck(k.ctx, u.i)).ok).toBe(false);
    expect((await job(k, u.jobId)).state).toBe('rejete');
    expect(k.calls).toEqual([]); // aucun appel de modele
    expect(k.s3.objects.size).toBe(0);
    const k2 = await makeCtx(goodScript());
    const u2 = await upload(k2, 1, PNG); // PNG annonce comme jpeg
    await awaitUpload(k2.ctx, { ...u2.i, token: 't' });
    expect((await scanCheck(k2.ctx, u2.i)).ok).toBe(false);
  });

  it('PDF refuse a la creation, sans reserver de page', async () => {
    const k = await makeCtx(goodScript());
    const r = await scansCreate(k.ctx, event({ body: { pages: 2, contentType: 'application/pdf' } }));
    expect(r.statusCode).toBe(400);
    expect(await k.quota.get(keys.quota('f1', '2026-12', 's1'))).toBeUndefined();
  });

  it('plafond de 10 transcriptions par jour', async () => {
    const k = await makeCtx(goodScript());
    for (let n = 0; n < 10; n++) {
      const u = await upload(k);
      await awaitUpload(k.ctx, { ...u.i, token: `t${n}` });
      await scanCheck(k.ctx, u.i);
      expect((await transcribe(k.ctx, u.i)).ok).toBe(true);
    }
    const u = await upload(k);
    await awaitUpload(k.ctx, { ...u.i, token: 'last' });
    await scanCheck(k.ctx, u.i);
    expect((await transcribe(k.ctx, u.i)).ok).toBe(false);
    expect((await job(k, u.jobId)).message).toMatch(/10 transcriptions/);
  });

  it('annulation: etat rejete, quota rendu, photo supprimee, attente levee', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    const r = await jobsCancel(k.ctx, event({ params: { jobId: u.jobId } }));
    expect(r.statusCode).toBe(200);
    expect(body(r).state).toBe('rejete');
    expect(k.sfn.failure.map((f) => f.token)).toContain('tok-conf');
    expect(k.s3.objects.size).toBe(0);
    expect((await qState(k)).restant).toBe(200);
    // plus de confirmation ni d'annulation possibles
    expect((await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }))).statusCode).toBe(409);
    expect((await jobsCancel(k.ctx, event({ params: { jobId: u.jobId } }))).statusCode).toBe(409);
    expect((await qState(k)).restant).toBe(200); // pas de double remboursement
  });

  it('30 minutes sans confirmation: expire, photo supprimee, quota rendu', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await expire(k.ctx, { ...u.i, phase: 'confirm' });
    expect((await job(k, u.jobId)).state).toBe('expire');
    expect(k.s3.objects.size).toBe(0);
    expect((await qState(k)).restant).toBe(200);
  });

  it('aucun envoi: expire et quota rendu', async () => {
    const k = await makeCtx(goodScript());
    const r = body(await scansCreate(k.ctx, event({ body: { pages: 3, contentType: 'image/jpeg' } })));
    expect((await qState(k)).reserve).toBe(3);
    await expire(k.ctx, { jobId: r.jobId, sid: 's1', phase: 'upload' });
    expect((await qState(k)).restant).toBe(200);
  });

  it('corrections: identifiant inconnu refuse, et l etat n a pas change', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    const r = await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [{ id: 'p5-s1', text: 'x' }] } }));
    expect(r.statusCode).toBe(400);
    expect((await job(k, u.jobId)).state).toBe('a_confirmer');
  });

  it('erreur d etape: echec, quota rendu, affirmations orphelines supprimees', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    const ex = await extract(k.ctx, u.i);
    await failJob(k.ctx, { ...u.i, error: { Error: 'Boom' } });
    expect((await job(k, u.jobId)).state).toBe('echec');
    expect((await qState(k)).restant).toBe(200);
    expect(await k.db.query(`DOC#${ex.docId}`)).toHaveLength(0);
    await failJob(k.ctx, u.i); // deja termine: sans effet
  });

  it('apres consommation du quota, un echec rend les pages (decision du proprietaire)', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    const ex = await extract(k.ctx, u.i);
    await quotaConsume(k.ctx, { ...u.i, verify: await fakeVerify(k, ex.docId!) });
    await failJob(k.ctx, u.i);
    expect(await qState(k)).toMatchObject({ utilise: 0, restant: 200 });
  });
});

describe('cout et garde', () => {
  it('compteur bloque (plafond cumule des essais dev): scans-create repond budget_epuise, aucune page reservee', async () => {
    const k = await makeCtx(goodScript(), { cost: { monthEur: 0, totalEur: DEV_TRIAL_CAP_EUR } });
    const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }));
    expect(r.statusCode).toBe(429);
    expect(body(r).code).toBe('budget_epuise');
    expect(await k.quota.get(keys.quota('f1', '2026-12', 's1'))).toBeUndefined();
  });

  it('compteur atteint pendant un job: le modele n est pas appele, le job echoue et rend le quota', async () => {
    const k = await makeCtx(goodScript());
    const u = await upload(k);
    await awaitUpload(k.ctx, { ...u.i, token: 't' });
    await scanCheck(k.ctx, u.i);
    k.costStore.totals.totalEur = DEV_TRIAL_CAP_EUR;
    await expect(transcribe(k.ctx, u.i)).rejects.toThrow(/garde de cout/);
    expect(k.calls).toEqual([]);
    await failJob(k.ctx, { ...u.i, error: { Error: 'CostBlockedError' } });
    expect((await job(k, u.jobId)).message).toMatch(/pause/);
    expect((await qState(k)).restant).toBe(200);
  });

  it('plafond du job: generation sans questions plutot qu un echec', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    const ex = await extract(k.ctx, u.i);
    await quotaConsume(k.ctx, { ...u.i, verify: { coutCentimes: 30 } }); // L2b a depense 0,30 EUR: plafond depasse
    await fakeVerify(k, ex.docId!);
    const g = await genFin(k.ctx, u.i);
    expect(g).toMatchObject({ qcm: 0, gaps: 0 });
    expect((await job(k, u.jobId)).state).toBe('termine');
  });

  it('budget transmis a L2b: plafond 25 centimes moins le deja depense et la reserve', () => {
    expect(budgetLeftCents(0)).toBe(19);
    expect(budgetLeftCents(100_000)).toBe(9); // 10 centimes depenses
    expect(budgetLeftCents(900_000)).toBe(0);
  });
});

describe('securite des routes', () => {
  it('eleve suspendu et parent refuses sur les routes d eleve', async () => {
    const k = await makeCtx(goodScript());
    const body1 = { pages: 1, contentType: 'image/jpeg' };
    expect((await scansCreate(k.ctx, event({ sub: 'sub-s2', body: body1 }))).statusCode).toBe(403);
    expect((await scansCreate(k.ctx, parent({ body: body1 }))).statusCode).toBe(403);
    expect((await scansCreate(k.ctx, event({ sub: 'inconnu', body: body1 }))).statusCode).toBe(403);
  });

  it('403 uniforme (I-1) et jeton parent + eleve refuse (I-2)', async () => {
    const k = await makeCtx(goodScript());
    const body1 = { pages: 1, contentType: 'image/jpeg' };
    const msgs = new Set<string>();
    for (const e of [event({ sub: 'sub-s2', body: body1 }), event({ sub: 'inconnu', body: body1 }), event({ groups: '[]', body: body1 }), event({ family: '', body: body1 })]) {
      const r = await scansCreate(k.ctx, e);
      expect(r.statusCode).toBe(403);
      msgs.add(JSON.parse(r.body as string).message);
    }
    expect(msgs.size).toBe(1);
    expect((await scansCreate(k.ctx, event({ sub: 'sub-p', groups: '[parent eleve]', body: body1 }))).statusCode).toBe(403);
  });

  it('le job d un autre eleve est introuvable', async () => {
    const k = await makeCtx(goodScript());
    const u = await upload(k);
    await k.db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s3', cognitoSub: 'sub-s3', statut: 'actif' });
    expect((await jobsGet(k.ctx, event({ sub: 'sub-s3', params: { jobId: u.jobId } }))).statusCode).toBe(404);
    expect((await jobsGet(k.ctx, event({ params: { jobId: '../x' } }))).statusCode).toBe(400);
  });

  it('quota epuise: 429 avec date de remise a zero', async () => {
    const k = await makeCtx(goodScript());
    const r = await scansCreate(k.ctx, event({ body: { pages: 10, contentType: 'image/jpeg' } }));
    expect(r.statusCode).toBe(201);
    for (let n = 0; n < 19; n++) await scansCreate(k.ctx, event({ body: { pages: 10, contentType: 'image/jpeg' } }));
    const over = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }));
    expect(over.statusCode).toBe(429);
    expect(body(over)).toMatchObject({ code: 'quota_epuise', resetDate: '2027-01-01' });
  });
});

describe('fiches: lecture, suppression, signalement', () => {
  async function published() {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k);
    await jobsConfirm(k.ctx, event({ params: { jobId: u.jobId }, body: { corrections: [] } }));
    const ex = await extract(k.ctx, u.i);
    await quotaConsume(k.ctx, { ...u.i, verify: await fakeVerify(k, ex.docId!) });
    await genFin(k.ctx, u.i);
    return { k, docId: ex.docId!, u };
  }

  it('signalement: cree sous la famille, affirmation controlee', async () => {
    const { k, docId } = await published();
    const ok = await docsReport(k.ctx, event({ params: { docId }, body: { claimId: '02', comment: 'La date est fausse.' } }));
    expect(ok.statusCode).toBe(201);
    const id = body(ok).reportId;
    expect(await k.db.get(keys.report('f1', id))).toMatchObject({ docId, claimId: '02', statut: 'ouvert' });
    expect((await docsReport(k.ctx, event({ params: { docId }, body: { claimId: '77', comment: 'x' } }))).statusCode).toBe(400);
    expect((await docsReport(k.ctx, event({ params: { docId }, body: { comment: '' } }))).statusCode).toBe(400);
  });

  it('suppression: tous les elements disparaissent, un autre eleve ne peut pas supprimer', async () => {
    const { k, docId } = await published();
    await k.db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s3', cognitoSub: 'sub-s3', statut: 'actif' });
    expect((await docsDelete(k.ctx, event({ sub: 'sub-s3', params: { docId } }))).statusCode).toBe(404);
    expect((await k.db.query(`DOC#${docId}`)).length).toBeGreaterThan(8);
    expect((await docsDelete(k.ctx, event({ params: { docId } }))).statusCode).toBe(204);
    expect(await k.db.query(`DOC#${docId}`)).toHaveLength(0);
    expect(await k.db.get(keys.doc('s1', docId))).toBeUndefined();
    expect((await docsRead(k.ctx, event({ params: { docId } }))).statusCode).toBe(404);
    expect(await deleteDocTree(treeDbFrom(k.db), 's1', docId)).toBe(0);
  });

  it('suppression: les signalements de la fiche partent, ceux d une autre fiche restent', async () => {
    const { k, docId } = await published();
    const mine = body(await docsReport(k.ctx, event({ params: { docId }, body: { comment: 'Une erreur.' } }))).reportId;
    await k.db.put({ ...keys.report('f1', 'r-autre'), docId: 'autre-fiche', studentId: 's1', commentaire: 'x', statut: 'ouvert' });
    expect((await docsDelete(k.ctx, event({ params: { docId } }))).statusCode).toBe(204);
    expect(await k.db.get(keys.report('f1', mine))).toBeUndefined();
    expect(await k.db.get(keys.report('f1', 'r-autre'))).toBeDefined();
  });

  it('le parent peut supprimer une fiche de sa famille, pas d une autre', async () => {
    const { k, docId } = await published();
    const other = parent({ params: { docId } });
    (other.requestContext as unknown as { authorizer: { jwt: { claims: Record<string, string> } } }).authorizer.jwt.claims['custom:famille_id'] = 'f2';
    expect((await docsDelete(k.ctx, other)).statusCode).toBe(404);
    expect((await docsDelete(k.ctx, parent({ params: { docId } }))).statusCode).toBe(204);
  });

  it('verdict illisible: l affirmation reste non verifiable, sans source', async () => {
    const { k, docId } = await published();
    await k.db.put({ ...keys.verdict(docId, 1), statut: 'verifiee', sources: [{ url: 'x' }] });
    const d = body(await docsRead(k.ctx, event({ params: { docId } })));
    expect(d.claims[0]).toMatchObject({ status: 'non_verifiable', sources: [] });
  });
});
