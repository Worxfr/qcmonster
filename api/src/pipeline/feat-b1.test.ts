// FEAT-A, lot B1: scan de plusieurs photos lu comme un seul document, sections par sujet, echec = tout supprime, plafond de cout proportionnel.
// Modele simule uniquement (aucun appel reel, aucun cout).
import { describe, expect, it } from 'vitest';
import { JobBudgetExceededError } from '../../../shared/bedrock.js';
import { JobSchema, ScanCreateResponseSchema, TranscriptionSchema } from '../../../shared/contract/generated/schemas.js';
import { keys } from '../../../shared/ddb/keys.js';
import { deleteStudentTree } from '../../../shared/delete-tree.js';
import { jobCapEur } from '../../../shared/names.js';
import { CONFIRM_TIMEOUT_S } from '../../../shared/scans.js';
import { verifyRun } from '../verify/run.js';
import { claim, FAKE_ARN, heuristicModel, memoryCost as verifyCost, memoryStore } from '../verify/testkit.js';
import * as api from './api.js';
import { jobKey } from './ctx.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { treeDbFrom } from './ports.js';
import { awaitConfirm, awaitUpload, expire, failJob, MSG, readWindows, scanCheck, scanStart, transcribe } from './steps.js';
import { budgetLeftCents, extract, finalize, generate, quotaConsume, sectionCost, sectionsPlan } from './steps-doc.js';
import { assemblePages } from './text.js';
import { classifyJson, event, goodScript, JPEG, makeCtx, PNG, readJson, type Script } from './testkit.js';

const scansCreate = guarded(api.scansCreate);
const jobsConfirm = guarded(api.jobsConfirm);
const jobsGet = guarded(api.jobsGet);
const jobsTranscription = guarded(api.jobsTranscription);
type K = Awaited<ReturnType<typeof makeCtx>>;
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}');
const job = async (k: K, jobId: string) => (await k.db.get(jobKey('s1', jobId)))!;
const quota = async (k: K) => (await k.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>;

// ---- un cours de 3 pages: photosynthese (pages 1 et 2, phrase a cheval) puis histoire (page 3)
const P1 = ['La photosynthese est le processus par lequel les plantes vertes fabriquent leur matiere.', 'Elle se deroule dans les chloroplastes des cellules vegetales.', 'La plante absorbe du dioxyde de carbone par ses feuilles.', 'Le dioxygene est rejete dans'];
const P2 = ['l atmosphere pendant la photosynthese.', 'La chlorophylle donne sa couleur verte aux feuilles et capte la lumiere.', 'Les racines absorbent l eau et les sels mineraux du sol.'];
const P3 = ['La revolution francaise commence en 1789 avec la prise de la Bastille.', 'Louis XVI est juge puis condamne en 1793 par la Convention.', 'La Terreur marque la periode la plus violente de la revolution.', 'Napoleon Bonaparte prend le pouvoir en 1799 apres un coup d etat.'];
const THREE = [{ page: 1, lines: P1 }, { page: 2, lines: P2, suite: true }, { page: 3, lines: P3 }];

const claimOf = (phraseId: string, extrait: string, texte: string) => ({ phraseId, extrait, texte, type: 'factuelle', aRisque: false });
/** Extraction simulee: l'affirmation depend du texte vu dans l'invite (une section ne voit que son texte). */
const extraction = (prompt: string) =>
  JSON.stringify(
    prompt.includes('revolution francaise')
      ? { titre: 'La Revolution', matiere: 'histoire_geo', affirmations: [claimOf('p3-s1', 'prise de la Bastille', 'La Bastille est prise en 1789.')] }
      : { titre: 'La photosynthese', matiere: 'svt', affirmations: [claimOf('p1-s2', 'dans les chloroplastes', 'La photosynthese se deroule dans les chloroplastes.')] },
  );
const threePages = (over: Partial<Script> = {}) => goodScript({ transcription: (pages) => readJson(THREE.filter((p) => pages.includes(p.page))), extraction, ...over });

async function create(k: K, pages: number, o: { contentTypes?: string[]; folderId?: string; bytes?: Uint8Array[] } = {}) {
  const r = await scansCreate(k.ctx, event({ body: { pages, contentType: 'image/jpeg', ...(o.contentTypes ? { contentTypes: o.contentTypes } : {}), ...(o.folderId ? { folderId: o.folderId } : {}) } }));
  return { r, created: body(r), jobId: body(r).jobId as string };
}
async function upload(k: K, pages: number, o: Parameters<typeof create>[2] = {}) {
  const { created, jobId } = await create(k, pages, o);
  for (let n = 0; n < pages; n++) {
    const key = `${scansPrefix('s1', jobId)}${n}`;
    k.s3.objects.set(key, o.bytes?.[n] ?? JPEG);
    await scanStart(k.ctx, { detail: { object: { key } } });
  }
  return { jobId, created, i: { jobId, sid: 's1' } };
}
async function toConfirm(k: K, pages = 3) {
  const u = await upload(k, pages);
  await awaitUpload(k.ctx, { ...u.i, token: 'tok-up' });
  expect((await scanCheck(k.ctx, u.i)).ok).toBe(true);
  expect((await transcribe(k.ctx, u.i)).ok).toBe(true);
  await awaitConfirm(k.ctx, { ...u.i, token: 'tok-conf' });
  return u;
}
const confirm = (k: K, jobId: string, b: Record<string, unknown> = {}) => jobsConfirm(k.ctx, event({ params: { jobId }, body: { corrections: [], ...b } }));

/** Faux verify-run (L2b): un verdict `verifiee` par affirmation; le premier porte le cout. */
async function fakeVerify(k: K, docId: string, micros = 20_000) {
  for (const c of await k.db.query(`DOC#${docId}`, 'CLAIM#')) {
    const nn = Number(c.SK.slice(6));
    await k.db.put({ ...keys.verdict(docId, nn), statut: 'verifiee', niveau: 2, secondeLecture: false, sources: [], ...(nn === 1 ? { coutMicros: micros } : {}) });
  }
}
/** Ce que fait la machine apres la confirmation: sectionsPlan, Map(extract, verify, sectionCost), consume, Map(generate), finalize. */
async function runMachine(k: K, i: { jobId: string; sid: string }) {
  const { indices } = await sectionsPlan(k.ctx, i);
  const budgets: number[] = [];
  for (const index of indices) {
    const ex = await extract(k.ctx, { ...i, index });
    expect(ex.ok).toBe(true);
    if (!ex.ok) return { budgets };
    budgets.push(ex.budgetRestantCentimes ?? 0);
    if (ex.claims) {
      await fakeVerify(k, ex.docId!);
      await sectionCost(k.ctx, { ...i, docId: ex.docId! });
    }
  }
  await quotaConsume(k.ctx, i);
  for (const index of indices) await generate(k.ctx, { ...i, index });
  await finalize(k.ctx, i);
  return { budgets };
}

describe('scans-create: une URL par page', () => {
  it('1 page: comme avant (upload = uploads[0])', async () => {
    const k = await makeCtx(goodScript());
    const { created } = await create(k, 1);
    expect(ScanCreateResponseSchema.safeParse(created).success).toBe(true);
    expect(created.uploads).toHaveLength(1);
    expect(created.upload.fields.key).toBe(created.uploads[0].fields.key);
  });
  it('3 pages: 3 URLs dans l ordre, cle exacte par page, types mixtes jpeg et png', async () => {
    const k = await makeCtx(goodScript());
    const { created, jobId } = await create(k, 3, { contentTypes: ['image/jpeg', 'image/png', 'image/jpeg'] });
    expect(created.uploads.map((u: { page: number }) => u.page)).toEqual([1, 2, 3]);
    expect(created.uploads.map((u: { fields: { key: string } }) => u.fields.key)).toEqual([0, 1, 2].map((n) => `${scansPrefix('s1', jobId)}${n}`));
    expect(created.uploads.map((u: { fields: Record<string, string> }) => u.fields['Content-Type'])).toEqual(['image/jpeg', 'image/png', 'image/jpeg']);
    expect(await quota(k)).toMatchObject({ reserve: 3 });
  });
  it('contentTypes de mauvaise longueur: 400 avant toute reservation; dossier inconnu: 404 sans reservation', async () => {
    const k = await makeCtx(goodScript());
    expect((await create(k, 3, { contentTypes: ['image/jpeg'] })).r.statusCode).toBe(400);
    expect((await create(k, 1, { folderId: 'inconnu' })).r.statusCode).toBe(404);
    expect(await k.quota.get(keys.quota('f1', '2026-12', 's1'))).toBeUndefined(); // rien reserve
    expect(k.sfn.started).toHaveLength(0);
  });
  it('scanCheck compare chaque page a SON type (jpeg + png accepte, png annonce pour un jpeg refuse)', async () => {
    const k = await makeCtx(goodScript());
    const ok = await upload(k, 2, { contentTypes: ['image/jpeg', 'image/png'], bytes: [JPEG, PNG] });
    await awaitUpload(k.ctx, { ...ok.i, token: 't1' });
    expect((await scanCheck(k.ctx, ok.i)).ok).toBe(true);
    const bad = await upload(k, 2, { contentTypes: ['image/jpeg', 'image/png'], bytes: [JPEG, JPEG] });
    await awaitUpload(k.ctx, { ...bad.i, token: 't2' });
    expect((await scanCheck(k.ctx, bad.i)).ok).toBe(false);
  });
  it('echec en cours: les pages sont rendues', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k, 3);
    await confirm(k, u.jobId);
    await failJob(k.ctx, { ...u.i, error: { Error: 'Boom' } });
    expect(await quota(k)).toMatchObject({ reserve: 0, utilise: 0, restant: 200 });
  });
});

describe('lecture du scan comme UN document', () => {
  it('cours de 3 pages dont une phrase a cheval: une seule phrase [1,2] sous la page 1, un seul appel de lecture, un seul docType', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    expect(k.calls.filter((c) => c === 'transcription')).toHaveLength(1);
    expect(k.calls.filter((c) => c === 'classement')).toHaveLength(1);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(TranscriptionSchema.safeParse(t).success).toBe(true);
    expect(t.pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3]);
    const p1 = t.pages[0].sentences;
    expect(p1[3]).toEqual({ id: 'p1-s4', text: 'Le dioxygene est rejete dans l atmosphere pendant la photosynthese.', pages: [1, 2] });
    expect(t.pages[1].sentences.map((s: { id: string }) => s.id)).toEqual(['p2-s1', 'p2-s2']); // numeros sans trou
    expect(JSON.stringify(t.pages[1])).not.toContain('pendant la photosynthese'); // pas repetee sous la page 2
    expect(t.suggestedSubject).toBe('svt');
    expect(t.suggestedTopic).toBe('La photosynthese');
    expect(t.photoUrls).toHaveLength(3);
    expect((await job(k, u.jobId)).readPages).toEqual([1, 2, 3]);
  });
  it('suite: true mais la phrase precedente finit par un point: pas de recollage', () => {
    const out = assemblePages([{ page: 1, lines: ['Premiere phrase complete.'], suite: false }, { page: 2, lines: ['Autre phrase.'], suite: true }]);
    expect(out[0].sentences).toEqual([{ id: 'p1-s1', text: 'Premiere phrase complete.' }]);
    expect(out[1].sentences).toEqual([{ id: 'p2-s1', text: 'Autre phrase.' }]);
  });
  it('phrase a cheval sur 3 pages: [1,2,3]; page vide au milieu: pas de recollage a travers; trait d union sans espace', () => {
    const three = assemblePages([{ page: 1, lines: ['Debut de'], suite: false }, { page: 2, lines: ['la phrase qui'], suite: true }, { page: 3, lines: ['continue ici.', 'Fin.'], suite: true }]);
    expect(three[0].sentences).toEqual([{ id: 'p1-s1', text: 'Debut de la phrase qui continue ici.', pages: [1, 2, 3] }]);
    expect(three[1].sentences).toEqual([]);
    expect(three[2].sentences).toEqual([{ id: 'p3-s1', text: 'Fin.' }]);
    const gap = assemblePages([{ page: 1, lines: ['Debut de'], suite: false }, { page: 2, lines: [], suite: false }, { page: 3, lines: ['suite.'], suite: true }]);
    expect(gap[2].sentences).toEqual([{ id: 'p3-s1', text: 'suite.' }]);
    expect(assemblePages([{ page: 1, lines: ['photo-'], suite: false }, { page: 2, lines: ['synthese.'], suite: true }])[0].sentences[0].text).toBe('photo-synthese.');
  });
  it('1 page seule: comportement inchange (pas de `pages` sur les phrases)', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k, 1);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(JSON.stringify(t.pages)).not.toContain('"pages"');
    expect(k.calls.filter((c) => c === 'transcription')).toHaveLength(1);
  });
  it('7 pages: 2 fenetres, page de contexte non retranscrite, recollage a la frontiere', async () => {
    expect(readWindows(7)).toEqual([{ pages: [1, 2, 3, 4] }, { pages: [5, 6, 7], context: 4 }]);
    expect(readWindows(10)).toHaveLength(3);
    const seen: { pages: number[]; images: number }[] = [];
    const lines = (p: number) => (p === 4 ? ['Une phrase qui commence en bas de la page 4 et'] : p === 5 ? ['continue en haut de la page 5.', ...COURSE5] : COURSE5);
    const k = await makeCtx(goodScript({ transcription: (pages, images) => { seen.push({ pages, images }); return readJson(pages.map((page) => ({ page, lines: lines(page), suite: page === 5 }))); } }));
    const u = await toConfirm(k, 7);
    expect(seen).toEqual([{ pages: [1, 2, 3, 4], images: 4 }, { pages: [5, 6, 7], images: 4 }]);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(t.pages[3].sentences.at(-1)).toMatchObject({ id: 'p4-s1', pages: [4, 5] });
    expect(t.pages).toHaveLength(7);
  });
  it('sortie tronquee: repli page par page, un seul essai', async () => {
    let n = 0;
    const k = await makeCtx(goodScript({ transcription: (pages) => (++n === 1 ? '{"pages":[{"page":1,"lines":["coupe' : readJson(pages.map((page) => ({ page, lines: COURSE5 })))) }));
    await toConfirm(k, 3);
    expect(k.calls.filter((c) => c === 'transcription')).toHaveLength(1 + 3); // la fenetre, puis une image par appel
  });
  it('pages 2 et 10: tri numerique des textes et des photos', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k, 10);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(t.pages.map((p: { page: number }) => p.page)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    expect(t.photoUrls.map((x: string) => Number(/\/(\d+)\?/.exec(x)![1]))).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });
  it('un type « autre » ne vient que de l appel de texte sur l ensemble (une page hors sujet ne fait pas rejeter un cours)', async () => {
    const k = await makeCtx(threePages());
    await toConfirm(k, 3);
    expect(k.calls.filter((c) => c === 'classement')).toHaveLength(1);
  });
});
const COURSE5 = ['La photosynthese est le processus par lequel les plantes vertes fabriquent leur matiere.', 'Elle se deroule dans les chloroplastes des cellules vegetales.', 'La plante absorbe du dioxyde de carbone par ses feuilles.', 'Elle utilise l energie lumineuse pour produire du glucose.'];

describe('delai de confirmation et statut', () => {
  it('confirmExpiresAt = attente + 12 h, une relance garde la premiere echeance', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k, 1);
    const j1 = await job(k, u.jobId);
    expect(j1.confirmExpiresAt).toBe(new Date(Date.parse(j1.awaitingSince as string) + CONFIRM_TIMEOUT_S * 1000).toISOString());
    await awaitConfirm(k.ctx, { ...u.i, token: 'tok-conf' });
    expect((await job(k, u.jobId)).confirmExpiresAt).toBe(j1.confirmExpiresAt);
  });
  it('expiration: quota rendu, photo supprimee, message en 12 heures', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k, 1);
    await expire(k.ctx, { ...u.i, phase: 'confirm' });
    expect((await job(k, u.jobId)).message).toBe(MSG.expiredConfirm);
    expect(MSG.expiredConfirm).toContain('12 heures');
    expect(await quota(k)).toMatchObject({ reserve: 0, restant: 200 });
    expect(k.s3.objects.size).toBe(0);
  });
  it('statut a chaque etat, et job d avant 1.3 (sans champs 1.3) lisible', async () => {
    const k = await makeCtx(threePages());
    const u = await upload(k, 3);
    const st = async () => body(await jobsGet(k.ctx, event({ params: { jobId: u.jobId } }))).status;
    expect(await st()).toMatchObject({ stage: 'envoi', pagesDone: 3, pagesTotal: 3 });
    await awaitUpload(k.ctx, { ...u.i, token: 'tok-up' });
    await scanCheck(k.ctx, u.i);
    await transcribe(k.ctx, u.i);
    expect(await st()).toMatchObject({ stage: 'lecture', pagesDone: 3 });
    await awaitConfirm(k.ctx, { ...u.i, token: 'tok-conf' });
    expect(await st()).toMatchObject({ stage: 'a_confirmer', expiresSoon: false });
    await confirm(k, u.jobId);
    await extract(k.ctx, { ...u.i, index: 0 });
    expect((await st()).stage).toBe('verification');
    expect((await job(k, u.jobId)).stage).toBe('verification');
    await k.db.put({ ...jobKey('s1', 'OLD'), state: 'termine', pages: 1, createdAt: '2026-11-01T10:00:00.000Z', docId: 'D1', ttl: 1 });
    const old = body(await jobsGet(k.ctx, event({ params: { jobId: 'OLD' } })));
    expect(JobSchema.safeParse(old).success).toBe(true);
    expect(old.status.stage).toBe('termine');
  });
});

describe('sections: une fiche par sujet', () => {
  const SEC = (extra: Record<string, unknown>[] = []) => ({
    sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Photosynthese', title: 'Les plantes' }, { fromSentenceId: 'p3-s1', subject: 'histoire_geo', topic: 'La Revolution' }, ...extra],
  });

  it('(1) sans sections: une fiche, un cours conserve, sujet et matiere choisis copies sur la fiche (sujet, dossierId, pages)', async () => {
    const k = await makeCtx(threePages());
    await k.db.put({ ...keys.folder('s1', 'F1'), nom: 'Sciences', nomCle: 'sciences', createdAt: 'x' });
    const u = await toConfirm(k, 3);
    const r = await confirm(k, u.jobId, { subject: 'svt', topic: ' <Les plantes> ', folderId: 'F1' });
    expect(r.statusCode).toBe(200);
    await runMachine(k, u.i);
    const j = await job(k, u.jobId);
    expect(j.state).toBe('termine');
    expect(j.docIds).toHaveLength(1);
    const f = (await k.db.get(keys.doc('s1', j.docId as string)))!;
    expect(f).toMatchObject({ sujet: 'Les plantes', dossierId: 'F1', pages: 3, matiere: 'svt', pagesConsommees: 3, coursId: u.jobId, sectionIndex: 0, sectionCount: 1 });
    expect((await k.db.get(keys.cours('s1', u.jobId)))!.sections).toHaveLength(1);
    expect(body(await jobsGet(k.ctx, event({ params: { jobId: u.jobId } }))).docIds).toEqual(j.docIds);
  });
  it('dossier supprime avant generate: pas de dossierId fantome', async () => {
    const k = await makeCtx(threePages());
    await k.db.put({ ...keys.folder('s1', 'F1'), nom: 'Sciences', nomCle: 'sciences', createdAt: 'x' });
    const u = await toConfirm(k, 3);
    await confirm(k, u.jobId, { folderId: 'F1' });
    await k.db.remove([keys.folder('s1', 'F1')]);
    await runMachine(k, u.i);
    expect((await k.db.get(keys.doc('s1', (await job(k, u.jobId)).docId as string)))!.dossierId).toBeUndefined();
  });
  it('(2) 3 pages en 2 sections: 2 fiches, chacune sur son texte seul; quota consomme UNE fois (3 puis 0); cours complet conserve', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    expect((await confirm(k, u.jobId, SEC())).statusCode).toBe(200);
    expect(k.s3.objects.size).toBe(0); // photos supprimees a la confirmation
    const before = k.prompts.length;
    await runMachine(k, u.i);
    const ex = k.prompts.slice(before).filter((p) => p.includes('<cours>'));
    expect(ex).toHaveLength(2);
    expect(ex[0]).toContain('photosynthese');
    expect(ex[0]).not.toContain('Bastille');
    expect(ex[1]).toContain('Bastille');
    expect(ex[1]).not.toContain('chloroplastes');
    const j = await job(k, u.jobId);
    expect(j.state).toBe('termine');
    const docs = await Promise.all((j.docIds as string[]).map((d) => k.db.get(keys.doc('s1', d))));
    expect(docs.map((d) => [d!.titre, d!.sujet, d!.matiere, d!.pagesConsommees, d!.sectionIndex, d!.sectionCount])).toEqual([
      ['Les plantes', 'Photosynthese', 'svt', 3, 0, 2],
      ['La Revolution', 'La Revolution', 'histoire_geo', 0, 1, 2],
    ]);
    expect(await quota(k)).toMatchObject({ reserve: 0, utilise: 3 });
    const texts = await k.db.query('STUDENT#s1', `COURS#${u.jobId}#T`);
    expect(texts).toHaveLength(3);
    expect(JSON.stringify(texts)).toContain('Bastille');
  });
  it('(3) une section ignoree: pas de fiche, texte garde dans COURS#', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    await confirm(k, u.jobId, { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p3-s1', subject: 'autre', ignore: true }] });
    await runMachine(k, u.i);
    const j = await job(k, u.jobId);
    expect(j.docIds).toHaveLength(1);
    const head = (await k.db.get(keys.cours('s1', u.jobId)))!;
    expect((head.sections as { statut: string }[]).map((s) => s.statut)).toEqual(['fiche', 'ignoree']);
    expect(JSON.stringify(await k.db.query('STUDENT#s1', `COURS#${u.jobId}#T`))).toContain('Bastille');
  });
  it('(4) refus 400/404: rien n ecrit, job a_confirmer, aucun COURS#', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    const bad: Record<string, unknown>[] = [
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p9-s9', subject: 'svt' }] }, // inconnu
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p3-s1', subject: 'svt' }, { fromSentenceId: 'p2-s1', subject: 'svt' }] }, // ordre
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p1-s1', subject: 'svt' }] }, // doublon
      { sections: [{ fromSentenceId: 'p3-s1', subject: 'svt' }] }, // debut
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', ignore: true }] }, // tout ignore
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }], subject: 'svt' }, // sections + subject
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: '<>' }] }, // sujet vide apres nettoyage
      { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', title: '   ' }] },
      { topic: '<>' },
      { topic: '   ' },
    ];
    for (const b of bad) expect((await confirm(k, u.jobId, b)).statusCode, JSON.stringify(b)).toBe(400);
    expect((await confirm(k, u.jobId, { folderId: 'inconnu' })).statusCode).toBe(404);
    expect((await confirm(k, u.jobId, { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', folderId: 'inconnu' }] })).statusCode).toBe(404);
    expect((await job(k, u.jobId)).state).toBe('a_confirmer');
    expect(await k.db.query('STUDENT#s1', 'COURS#')).toHaveLength(0);
    expect(k.sfn.success).toEqual(['tok-up'].filter((x) => k.sfn.success.includes(x)));
  });
  it('trop de sections pour 1 page: 400 (2 par page au plus)', async () => {
    const k = await makeCtx(goodScript());
    const u = await toConfirm(k, 1);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    const ids = t.pages[0].sentences.map((s: { id: string }) => s.id);
    const r = await confirm(k, u.jobId, { sections: ids.slice(0, 3).map((id: string) => ({ fromSentenceId: id, subject: 'svt' })) });
    expect(r.statusCode).toBe(400);
  });
  it('(8 bis) Q6: 40 mots au total des parties gardees, pas par section', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    const small = t.pages[0].sentences[1].id; // p1-s2: une petite section de 9 mots
    const ok = await confirm(k, u.jobId, { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: small, subject: 'svt' }, { fromSentenceId: 'p1-s3', subject: 'svt' }] });
    expect(ok.statusCode).toBe(200);
    const k2 = await makeCtx(threePages());
    const u2 = await toConfirm(k2);
    const short = await confirm(k2, u2.jobId, { sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p1-s3', subject: 'svt', ignore: true }] });
    expect(short.statusCode).toBe(400);
    expect(body(short).message).toBe('Il faut au moins 40 mots dans les parties gardees');
  });
  it('(6) plafond: la somme des budgets des sections reste sous jobCapEur(3), la 2e ne manque pas de budget', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    await confirm(k, u.jobId, SEC());
    const { budgets } = await runMachine(k, u.i);
    expect(budgets).toHaveLength(2);
    // chaque budget est une part du RESTE (plafond - depense - reserve): la 2e section recoit ce que la 1re n'a pas depense, jamais plus que le reste du job
    const cap = jobCapEur(3) * 100;
    const spent = Math.ceil(((await job(k, u.jobId)).coutMicros as number) / 10_000);
    expect(budgets[0]).toBeLessThan(cap - 6);
    expect(budgets[1]).toBeLessThanOrEqual(cap - 6 - Math.max(0, spent - 3)); // `spent` final inclut la 2e section: au plus 3 centimes de plus que lors de son extraction
    expect(budgets[0] + budgets[1]).toBeGreaterThan(30);
    expect(budgets[1]).toBeGreaterThan(10);
  });
  it('(7) reprise apres echec de la section 2: pas de doublon de fiche, cout de verify-run compte une fois par tentative', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    await confirm(k, u.jobId, SEC());
    const a = await extract(k.ctx, { ...u.i, index: 0 });
    await fakeVerify(k, a.docId!, 30_000);
    await sectionCost(k.ctx, { ...u.i, docId: a.docId! });
    await sectionCost(k.ctx, { ...u.i, docId: a.docId! }); // relance: sans effet
    const after1 = (await job(k, u.jobId)).coutMicros as number;
    const b = await extract(k.ctx, { ...u.i, index: 1 });
    await fakeVerify(k, b.docId!, 40_000);
    await extract(k.ctx, { ...u.i, index: 1 }); // reprise: le cout de la tentative effacee est ajoute avant l'effacement
    await fakeVerify(k, b.docId!, 40_000);
    await sectionCost(k.ctx, { ...u.i, docId: b.docId! });
    const costs = await k.db.query(`JOB#${u.jobId}`, 'COSTADDED#');
    expect(costs).toHaveLength(3);
    const total = (await job(k, u.jobId)).coutMicros as number;
    expect(total - after1).toBeGreaterThanOrEqual(80_000);
    expect(total - after1).toBeLessThan(80_000 + 20_000); // deux tentatives de 40 000 + 2 appels d'extraction (quelques centaines)
    await quotaConsume(k.ctx, u.i);
    await generate(k.ctx, { ...u.i, index: 0 });
    await generate(k.ctx, { ...u.i, index: 1 });
    await generate(k.ctx, { ...u.i, index: 1 }); // reprise: pas de doublon
    await finalize(k.ctx, u.i);
    expect((await job(k, u.jobId)).docIds).toHaveLength(2);
    expect((await k.db.query('STUDENT#s1', 'DOC#')).length).toBe(2);
  });
  it('(8) une section sans affirmation: l autre fiche existe, job termine, cours en sans_fiche', async () => {
    const k = await makeCtx(threePages({ extraction: (p) => (p.includes('Bastille') ? JSON.stringify({ titre: 'x', matiere: 'autre', affirmations: [] }) : extraction(p)) }));
    const u = await toConfirm(k);
    await confirm(k, u.jobId, SEC());
    await runMachine(k, u.i);
    const j = await job(k, u.jobId);
    expect(j.state).toBe('termine');
    expect(j.docIds).toHaveLength(1);
    expect(((await k.db.get(keys.cours('s1', u.jobId)))!.sections as { statut: string }[]).map((s) => s.statut)).toEqual(['fiche', 'sans_fiche']);
  });
  it('(8) toutes les sections sans affirmation: rejete, quota rendu, cours supprime', async () => {
    const k = await makeCtx(threePages({ extraction: JSON.stringify({ titre: 'x', matiere: 'autre', affirmations: [] }) }));
    const u = await toConfirm(k);
    await confirm(k, u.jobId, SEC());
    expect((await extract(k.ctx, { ...u.i, index: 0 })).ok).toBe(true);
    expect((await extract(k.ctx, { ...u.i, index: 1 })).ok).toBe(false);
    expect((await job(k, u.jobId)).state).toBe('rejete');
    expect((await job(k, u.jobId)).message).toBe(MSG.noClaims);
    expect(await quota(k)).toMatchObject({ reserve: 0, restant: 200 });
    expect(await k.db.query('STUDENT#s1', 'COURS#')).toHaveLength(0);
  });
  it('(9) echec en cours: toutes les fiches et le cours sont supprimes, message constant, aucun texte de cours dans les journaux', async () => {
    const logs: string[] = [];
    const write = process.stdout.write.bind(process.stdout);
    process.stdout.write = ((c: string) => { logs.push(String(c)); return true; }) as typeof process.stdout.write;
    try {
      const k = await makeCtx(threePages());
      const u = await toConfirm(k);
      await confirm(k, u.jobId, SEC());
      const a = await extract(k.ctx, { ...u.i, index: 0 });
      await fakeVerify(k, a.docId!);
      await sectionCost(k.ctx, { ...u.i, docId: a.docId! });
      await extract(k.ctx, { ...u.i, index: 1 });
      await quotaConsume(k.ctx, u.i);
      await generate(k.ctx, { ...u.i, index: 0 }); // une fiche existe deja
      expect((await k.db.query('STUDENT#s1', 'DOC#')).length).toBe(1);
      await failJob(k.ctx, { ...u.i, error: { Error: 'States.TaskFailed' } });
      const j = await job(k, u.jobId);
      expect(j.state).toBe('echec');
      expect(j.message).toBe('Le traitement a échoué, rescanne ton cours');
      expect(await k.db.query('STUDENT#s1', 'DOC#')).toHaveLength(0);
      expect(await k.db.query('STUDENT#s1', 'COURS#')).toHaveLength(0);
      expect(await k.db.query(`JOB#${u.jobId}`, 'TEXT#')).toHaveLength(0);
      expect((await k.db.query('DOC#' + (j.docIds as string[])[0])).length).toBe(0);
      await failJob(k.ctx, { ...u.i }); // relance: sans effet ni erreur
    } finally {
      process.stdout.write = write;
    }
    expect(logs.join('')).not.toMatch(/Bastille|chloroplastes|photosynthese|revolution/i);
  });
  it('(12) deleteStudentTree supprime COURS# avec l eleve', async () => {
    const k = await makeCtx(threePages());
    const u = await toConfirm(k);
    await confirm(k, u.jobId, SEC());
    await runMachine(k, u.i);
    await deleteStudentTree(treeDbFrom(k.db), 'f1', 's1');
    expect(await k.db.query('STUDENT#s1')).toHaveLength(0);
  });
  it('suggestions: decoupage propose valide par planSections (une proposition invalide est ignoree)', async () => {
    const sections = [{ fromSentenceId: 'p1-s1', matiere: 'svt', sujet: 'Plantes', titre: 'Les plantes' }, { fromSentenceId: 'p3-s1', matiere: 'histoire_geo', sujet: 'Revolution', titre: 'La Revolution' }];
    const k = await makeCtx(threePages({ classify: classifyJson({ sections }) }));
    const u = await toConfirm(k);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(TranscriptionSchema.safeParse(t).success).toBe(true);
    expect(t.suggestedSections).toEqual([{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Plantes', title: 'Les plantes' }, { fromSentenceId: 'p3-s1', subject: 'histoire_geo', topic: 'Revolution', title: 'La Revolution' }]);
    const k2 = await makeCtx(threePages({ classify: classifyJson({ sections: [sections[1], sections[0]] }) }));
    const u2 = await toConfirm(k2);
    expect(body(await jobsTranscription(k2.ctx, event({ params: { jobId: u2.jobId } }))).suggestedSections).toBeUndefined();
  });
});

describe('plafond de cout proportionnel aux pages', () => {
  it('budget transmis a verify-run: 1 page = 0,25, 3 pages = 0,45, 10 pages = 1,50 (moins la reserve et le depense)', () => {
    expect(budgetLeftCents(0, 1)).toBe(25 - 6);
    expect(budgetLeftCents(0, 3)).toBe(45 - 6);
    expect(budgetLeftCents(0, 10)).toBe(150 - 6);
    expect(budgetLeftCents(100_000, 3)).toBe(45 - 6 - 10);
    expect(budgetLeftCents(0, 3, 0.5)).toBe(Math.floor((45 - 6) / 2));
  });
  it('extract transmet le budget du job a 1, 3 et 10 pages', async () => {
    const got: number[] = [];
    for (const pages of [1, 3, 10]) {
      const k = await makeCtx(goodScript());
      const u = await toConfirm(k, pages);
      await confirm(k, u.jobId);
      got.push((await extract(k.ctx, u.i)).budgetRestantCentimes!);
    }
    expect(got[0]).toBeLessThanOrEqual(19);
    expect(got[0]).toBeGreaterThan(12);
    expect(got[1]).toBeLessThanOrEqual(39);
    expect(got[1]).toBeGreaterThan(30);
    expect(got[2]).toBeLessThanOrEqual(144);
    expect(got[2]).toBeGreaterThan(130);
  });
  it('le refus a lieu avant l appel: 0,30 EUR depenses refusent 1 page mais pas 3 pages', async () => {
    for (const [pages, refused] of [[1, true], [3, false]] as const) {
      const k = await makeCtx(goodScript());
      const u = await toConfirm(k, pages);
      await confirm(k, u.jobId);
      await k.db.update(jobKey('s1', u.jobId), { set: { coutMicros: 300_000 } });
      const before = k.calls.length;
      if (refused) {
        await expect(extract(k.ctx, u.i)).rejects.toBeInstanceOf(JobBudgetExceededError);
        expect(k.calls.length).toBe(before); // aucun appel de modele
      } else {
        expect((await extract(k.ctx, u.i)).ok).toBe(true);
      }
    }
  });
  it('le plafond d essais de 50 EUR prime', async () => {
    const k2 = await makeCtx(goodScript());
    const u2 = await toConfirm(k2, 3);
    await confirm(k2, u2.jobId);
    k2.costStore.totals.totalEur = 50;
    await expect(extract(k2.ctx, u2.i)).rejects.toThrow(/garde de cout/);
  });
  it('verify-run: le budget transmis fait foi jusqu a jobCapEur(10); 0,25 ne bride plus un scan de 3 pages', async () => {
    const claims = Array.from({ length: 60 }, (_, i) => claim('doc1', i + 1, `Fait numero ${i + 1} du cours de maths.`));
    const calls = async (budget: number) => {
      const model = heuristicModel({ usageOut: 4000 });
      const base = model.converse.bind(model);
      model.converse = async (r) => ({ ...(await base(r)), usage: { inputTokens: 40_000, outputTokens: 3_000 } }); // de l'ordre de 0,15 EUR par appel
      process.env.QCM_ENV = 'dev';
      await verifyRun({ store: memoryStore(claims), search: { search: async () => [] }, model: { port: model, costStore: verifyCost(), arn: FAKE_ARN } }, { jobId: 'job1', docId: 'doc1', budgetRestantCentimes: budget });
      return model.calls.length;
    };
    const small = await calls(25);
    expect(await calls(45)).toBeGreaterThanOrEqual(small);
    expect(await calls(2000)).toBeLessThanOrEqual(Math.ceil((jobCapEur(10) * 100) / 15) + 1); // borne absolue 1,50 EUR
  });
});
