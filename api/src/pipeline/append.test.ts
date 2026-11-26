// F10: ajout de pages a un cours existant (docs/F10-design.md). Modele simule uniquement (aucun appel reel, aucun cout).
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { coursApi } from '../cours/cours.js';
import { docsRead } from '../docs/docs.js';
import { scansDelete } from '../scans/delete.js';
import * as api from './api.js';
import { jobKey } from './ctx.js';
import { cropFigures, figureKey } from './figures.js';
import { guarded } from './http.js';
import { endWithoutDoc, scansPrefix } from './job.js';
import { awaitConfirm, awaitUpload, expire, failJob, scanCheck, scanStart, transcribe } from './steps.js';
import { extract, finalize, generate, quotaConsume, sectionCost, sectionsPlan } from './steps-doc.js';
import { reclaimLock, restoreAfterFailedAppend } from './append.js';
import { classifyJson, event, goodScript, JPEG, makeCtx, parent, readJson, type Script } from './testkit.js';

type K = Awaited<ReturnType<typeof makeCtx>>;
const scansCreate = guarded(api.scansCreate);
const jobsConfirm = guarded(api.jobsConfirm);
const jobsCancel = guarded(api.jobsCancel);
const jobsTranscription = guarded(api.jobsTranscription);
const coursH = guarded(coursApi);
const cours = (ctx: Parameters<typeof coursH>[0], e: ReturnType<typeof event>) => coursH(ctx, { ...e, routeKey: 'GET /cours/{coursId}' });
const delScan = guarded(scansDelete);
const docs = guarded(docsRead);
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}');
const quota = async (k: K) => (await k.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>;
const job = async (k: K, id: string) => (await k.db.get(jobKey('s1', id)))!;

// ---- cours d'origine: 2 pages (photosynthese), une figure. Ajout: 1 page sur les volcans, deux sujets.
const ORIGIN = ['La photosynthese est le processus par lequel les plantes vertes fabriquent leur matiere.', 'Elle se deroule dans les chloroplastes des cellules vegetales.', 'La plante absorbe du dioxyde de carbone par ses feuilles.', 'Le dioxygene est rejete dans l atmosphere pendant la photosynthese.'];
const ORIGIN2 = ['La chlorophylle donne sa couleur verte aux feuilles et capte la lumiere.', 'Les racines absorbent l eau et les sels mineraux du sol.'];
const VOLC = ['Les volcans naissent de la remontee du magma depuis le manteau terrestre.', 'Une eruption effusive libere une lave fluide qui coule lentement sur les pentes.', 'Une eruption explosive projette des cendres et des gaz tres haut dans le ciel.', 'Le Vesuve a detruit la ville de Pompei en l an soixante dix neuf.', 'Les geologues surveillent les volcans actifs grace aux sismographes et aux capteurs de gaz.'];
const FIG = { id: 'f1', box: [0.1, 0.4, 0.8, 0.35], kind: 'schema', alt: 'Schema', caption: 'Fig. 1' };
const md = (lines: string[], fig = true) => `${lines.join('\n')}${fig ? '\n\n[[f1]]' : ''}`;
const claim = (phraseId: string, extrait: string, texte: string) => ({ phraseId, extrait, texte, type: 'factuelle', aRisque: false });
const mode = { append: false, suite: false };
const extraction = (prompt: string) => {
  if (prompt.includes('Vesuve')) return JSON.stringify({ titre: 'Pompei', matiere: 'histoire_geo', affirmations: [claim('p3-s4', 'detruit la ville de Pompei', 'Le Vesuve a detruit Pompei.')] });
  if (prompt.includes('volcans naissent')) return JSON.stringify({ titre: 'Volcans', matiere: 'svt', affirmations: [claim('p3-s1', 'remontee du magma', 'Les volcans naissent de la remontee du magma.')] });
  return JSON.stringify({ titre: 'La photosynthese', matiere: 'svt', affirmations: [claim('p1-s2', 'dans les chloroplastes', 'La photosynthese se deroule dans les chloroplastes.')] });
};
const script = (over: Partial<Script> = {}): Script =>
  goodScript({
    transcription: (pages) =>
      !pages.length
        ? '{"figures":[{"n":1,"box":[0.2,0.2,0.5,0.5]}]}'
        : JSON.stringify({ pages: pages.map((page) => (mode.append ? { page, suite: mode.suite, md: md(VOLC), figures: [FIG] } : { page, suite: false, md: md(page === 1 ? ORIGIN : ORIGIN2, page === 1), figures: page === 1 ? [FIG] : [] })) }),
    classify: classifyJson(),
    extraction,
    ...over,
  });

async function upload(k: K, pages: number, extra: Record<string, unknown> = {}) {
  const r = await scansCreate(k.ctx, event({ body: { pages, contentType: 'image/jpeg', ...extra } }));
  if (r.statusCode !== 201) return { r, jobId: '', i: { jobId: '', sid: 's1' } };
  const jobId = body(r).jobId as string;
  const i = { jobId, sid: 's1' };
  for (let n = 0; n < pages; n++) {
    const key = `${scansPrefix('s1', jobId)}${n}`;
    k.s3.objects.set(key, JPEG);
    await scanStart(k.ctx, { detail: { object: { key } } });
  }
  return { r, jobId, i };
}
async function toReview(k: K, pages: number, extra: Record<string, unknown> = {}) {
  const u = await upload(k, pages, extra);
  expect(u.r.statusCode).toBe(201);
  await awaitUpload(k.ctx, { ...u.i, token: 'tok-up' });
  expect((await scanCheck(k.ctx, u.i)).ok).toBe(true);
  expect((await transcribe(k.ctx, u.i)).ok).toBe(true);
  await cropFigures(k.ctx, u.i);
  await awaitConfirm(k.ctx, { ...u.i, token: 'tok-conf' });
  return u;
}
const confirm = (k: K, jobId: string, b: Record<string, unknown> = {}) => jobsConfirm(k.ctx, event({ params: { jobId }, body: { corrections: [], ...b } }));
async function fakeVerify(k: K, docId: string) {
  for (const c of await k.db.query(`DOC#${docId}`, 'CLAIM#')) await k.db.put({ ...keys.verdict(docId, Number(c.SK.slice(6))), statut: 'verifiee', niveau: 2, secondeLecture: false, sources: [], ...(c.SK === 'CLAIM#01' ? { coutMicros: 20_000 } : {}) });
}
async function machine(k: K, i: { jobId: string; sid: string }) {
  const { indices } = await sectionsPlan(k.ctx, i);
  for (const index of indices) {
    const ex = await extract(k.ctx, { ...i, index });
    if (!ex.ok) return false;
    if (ex.claims) {
      await fakeVerify(k, ex.docId!);
      await sectionCost(k.ctx, { ...i, docId: ex.docId! });
    }
  }
  await quotaConsume(k.ctx, i);
  for (const index of indices) await generate(k.ctx, { ...i, index });
  await finalize(k.ctx, i);
  return true;
}

/** Cours d'origine termine: 2 pages, 1 section, 1 fiche, 1 figure gardee. Renvoie son identifiant (= celui du job). */
async function makeCourse(k: K) {
  mode.append = false;
  const u = await toReview(k, 2);
  expect((await confirm(k, u.jobId, { figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(200);
  expect(await machine(k, u.i)).toBe(true);
  return u.jobId;
}
const SECTIONS = [
  { fromSentenceId: 'p3-s1', subject: 'svt', topic: 'Volcans', title: 'Les volcans' },
  { fromSentenceId: 'p3-s4', subject: 'histoire_geo', topic: 'Pompei', title: 'Pompei' },
];
/** Un ajout de 1 page arrive a la relecture. */
async function appendReview(k: K, coursId: string, o: { suite?: boolean } = {}) {
  mode.append = true;
  mode.suite = o.suite === true;
  return toReview(k, 1, { coursId });
}
async function appendDone(k: K, coursId: string) {
  const u = await appendReview(k, coursId);
  expect((await confirm(k, u.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(200);
  expect(await machine(k, u.i)).toBe(true);
  return u;
}

/** Tout ce qui appartient au cours d'origine, hors verrou et liste des jobs (metadonnees de l'ajout). */
async function snap(k: K, coursId: string) {
  const rows = [...k.db.items.values()]
    .filter((x) => (x.PK === 'STUDENT#s1' && (x.SK.startsWith(`COURS#${coursId}`) || x.SK.startsWith('DOC#'))) || x.PK.startsWith('DOC#'))
    .map((x) => {
      const { appendJobId, jobIds, ...rest } = x as Record<string, unknown>;
      void appendJobId;
      void jobIds;
      return rest;
    })
    .sort((a, b) => `${a.PK}${a.SK}`.localeCompare(`${b.PK}${b.SK}`));
  return JSON.stringify({ rows, figures: [...k.figures.objects.keys()].sort() });
}
const lock = async (k: K, coursId: string) => (await k.db.get(keys.cours('s1', coursId)))!.appendJobId as string | undefined;

describe('ajout nominal', () => {
  it('pages a la suite, sections allongees, fiches d origine inchangees, quota par page ajoutee, figures et blocs uniques', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const origDocs = [...k.db.items.values()].filter((x) => x.PK === 'STUDENT#s1' && x.SK.startsWith('DOC#')).map((d) => JSON.stringify(d));
    expect(await quota(k)).toMatchObject({ utilise: 2, reserve: 0 });
    const u = await appendReview(k, coursId, { suite: true });
    expect(await lock(k, coursId)).toBe(u.jobId); // verrou pose avec le job
    expect(await quota(k)).toMatchObject({ utilise: 2, reserve: 1 });
    // relecture: seules les nouvelles pages (numerotees a la suite), deux phrases de contexte, lien de continuation
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: u.jobId } })));
    expect(t.pages.map((p: { page: number }) => p.page)).toEqual([3]);
    expect(t.pages[0].sentences[0]).toMatchObject({ id: 'p3-s1', continuesId: 'p2-s2' });
    expect(t.context.map((s: { id: string }) => s.id)).toEqual(['p2-s1', 'p2-s2']);
    expect(k.prompts.at(-1)).toContain('Les racines absorbent'); // le modele de lecture voit la fin du cours (texte seul)
    expect(t.photoUrls).toHaveLength(1);
    expect(t.figures[0].figureId).toBe('f1');
    expect((await confirm(k, u.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(200);
    const mid = (await k.db.get(keys.cours('s1', coursId)))!;
    expect(mid.pages).toBe(3);
    expect((mid.sections as unknown[]).length).toBe(3);
    expect(await machine(k, u.i)).toBe(true);
    const head = (await k.db.get(keys.cours('s1', coursId)))!;
    expect(head).toMatchObject({ pages: 3, nbPhrases: 11 });
    expect(head.appendJobId).toBeUndefined(); // verrou libere en dernier pas
    expect((head.sections as { statut: string; docId?: string }[]).map((s) => s.statut)).toEqual(['fiche', 'fiche', 'fiche']);
    // fiches d'origine inchangees, nouvelles fiches locales a leur scan
    for (const d of origDocs) expect(JSON.stringify(await k.db.get(JSON.parse(d)))).toBe(d);
    const newDocs = (await k.db.query('STUDENT#s1', 'DOC#')).filter((d) => d.jobId === u.jobId);
    expect(newDocs.map((d) => [d.sectionIndex, d.sectionCount, d.coursId, d.pagesConsommees])).toEqual([[0, 2, coursId, 1], [1, 2, coursId, 0]]);
    // le texte du cours: page 3 ecrite, pages 1 et 2 intactes; GET /cours montre tout
    const g = body(await cours(k.ctx, event({ params: { coursId } }))) as { texts: { page: number }[]; blocks: { id: string; figureId?: string }[]; figures: { figureId: string }[]; sections: unknown[] };
    expect(g.texts.map((x) => x.page)).toEqual([1, 2, 3]);
    expect(g.sections).toHaveLength(3);
    // P15: identifiants de blocs et de figures uniques dans tout le cours; les anciens ne changent pas
    expect(new Set(g.blocks.map((b) => b.id)).size).toBe(g.blocks.length);
    expect(g.figures.map((f) => f.figureId)).toEqual(['f1', 'f2']);
    expect(g.blocks.filter((b) => b.figureId).map((b) => b.figureId)).toEqual(['f1', 'f2']);
    expect(k.figures.objects.has(figureKey('s1', coursId, 'f2'))).toBe(true);
    // quota consomme une seule fois, pour la page ajoutee
    expect(await quota(k)).toMatchObject({ utilise: 3, reserve: 0 });
    // la fiche de l'ajout retrouve SA figure (rang par docId, pas par sectionIndex local)
    const d1 = body(await docs(k.ctx, event({ params: { docId: newDocs[0].SK.slice(4) } })));
    expect(d1.figures.map((f: { figureId: string }) => f.figureId)).toEqual(['f2']);
    expect(before).not.toBe(await snap(k, coursId)); // le cours a bien change
  });
});

describe('creation: limites, verrou, roles', () => {
  it('cours inconnu, d un autre eleve, id invalide: 404 / 404 / 400 sans rien reserver; parent 403', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const r0 = await quota(k);
    expect((await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId: 'inconnu' } }))).statusCode).toBe(404);
    await k.db.put({ ...keys.cours('s2', 'COURS_S2'), jobId: 'x', pages: 1, nbPhrases: 1, sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', ignore: false, statut: 'fiche' }], createdAt: 'x' });
    expect((await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId: 'COURS_S2' } }))).statusCode).toBe(404);
    expect((await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId: 'a/b' } }))).statusCode).toBe(400);
    expect((await scansCreate(k.ctx, parent({ body: { pages: 1, contentType: 'image/jpeg', coursId } }))).statusCode).toBe(403);
    expect(await quota(k)).toEqual(r0);
    expect(await lock(k, coursId)).toBeUndefined();
  });

  it('30 pages et 20 sections: cours_plein (409) avant toute reservation', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const r0 = await quota(k);
    await k.db.update(keys.cours('s1', coursId), { set: { pages: 30 } });
    const full = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    expect(full.statusCode).toBe(409);
    expect(body(full)).toMatchObject({ code: 'cours_plein' });
    await k.db.update(keys.cours('s1', coursId), { set: { pages: 2, sections: Array.from({ length: 20 }, (_, n) => ({ fromSentenceId: `p1-s${n + 1}`, subject: 'svt', ignore: false, statut: 'sans_fiche' })) } });
    expect(body(await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }))).code).toBe('cours_plein');
    expect(await quota(k)).toEqual(r0);
    expect(await lock(k, coursId)).toBeUndefined();
  });

  it('18 sections: l ajout est borne a 2 sections (refus ordinaire a la confirmation, rien ecrit)', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const sections = Array.from({ length: 17 }, (_, n) => ({ fromSentenceId: 'p1-s1', subject: 'svt', ignore: true, statut: 'ignoree', n }));
    const head = (await k.db.get(keys.cours('s1', coursId)))!;
    await k.db.update(keys.cours('s1', coursId), { set: { sections: [...(head.sections as unknown[]), ...sections.map(({ n, ...s }) => (void n, s))] } });
    const u = await appendReview(k, coursId);
    const three = [...SECTIONS, { fromSentenceId: 'p3-s5', subject: 'svt' }];
    const r = await confirm(k, u.jobId, { sections: three });
    expect(r.statusCode).toBe(400);
    expect((await k.db.get(keys.cours('s1', coursId)))!.pages).toBe(2);
    expect((await job(k, u.jobId)).state).toBe('a_confirmer');
  });

  it('verrou: deux POST concurrents, un seul ajout; le second recoit 409 sans reservation', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const mk = () => scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    const [a, b] = await Promise.all([mk(), mk()]);
    expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
    const jobs = [...k.db.items.values()].filter((x) => x.SK.startsWith('JOB#') && x.appendTo === coursId);
    expect(jobs).toHaveLength(1);
    expect(await quota(k)).toMatchObject({ utilise: 2, reserve: 1 });
    expect(await lock(k, coursId)).toBe(jobs[0].SK.slice(4));
    const third = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    expect(body(third)).toMatchObject({ code: 'etat_invalide' });
  });

  it('scan d origine pas termine: 409, rien reserve', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    await k.db.update(jobKey('s1', coursId), { set: { state: 'generation' } });
    const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    expect(r.statusCode).toBe(409);
    expect(await quota(k)).toMatchObject({ reserve: 0 });
  });

  it('quota epuise: 429, verrou libere, aucun job ouvert', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    await k.db.update(keys.quota('f1', '2026-12', 's1'), { set: { restant: 0 } });
    const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    expect(r.statusCode).toBe(429);
    expect(await lock(k, coursId)).toBeUndefined();
    await k.db.update(keys.quota('f1', '2026-12', 's1'), { set: { restant: 50 } });
    expect((await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }))).statusCode).toBe(201);
  });

  it('verrou d un job final restaure ou absent: repris; job final non restaure: restaure puis repris', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    await endWithoutDoc(k.ctx, 's1', u.jobId, ['a_confirmer'], 'rejete', 'x');
    expect(await lock(k, coursId)).toBeUndefined();
    // job final dont la restauration n'a pas eu lieu (arret apres la transition): la creation suivante la termine
    await k.db.update(keys.cours('s1', coursId), { set: { appendJobId: u.jobId } });
    await k.db.update(jobKey('s1', u.jobId), { remove: ['restoredAt'] });
    expect(await reclaimLock(k.ctx, 's1', (await k.db.get(keys.cours('s1', coursId)))!)).toBe(true);
    expect(typeof (await job(k, u.jobId)).restoredAt).toBe('string');
    expect(await lock(k, coursId)).toBeUndefined();
    // job absent (expire apres 7 jours)
    await k.db.update(keys.cours('s1', coursId), { set: { appendJobId: 'ABSENT' } });
    expect(await reclaimLock(k.ctx, 's1', (await k.db.get(keys.cours('s1', coursId)))!)).toBe(true);
    expect(await lock(k, coursId)).toBeUndefined();
  });
});

describe('echec, annulation, expiration: le cours d origine est restaure, jamais supprime', () => {
  it('annulation avant la confirmation', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    expect((await jobsCancel(k.ctx, event({ params: { jobId: u.jobId } }))).statusCode).toBe(200);
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
    expect(await quota(k)).toMatchObject({ utilise: 2, reserve: 0, restant: 198 });
    expect((await k.db.query(`JOB#${u.jobId}`)).every((x) => typeof x.ttl === 'number')).toBe(true); // copie de travail: TTL de 7 jours, comme une annulation ordinaire
  });

  it('apres le debut de la confirmation, l annulation est refusee (la restauration complete releve de l expiration)', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    const orig = k.db.update.bind(k.db);
    k.db.update = async (key, spec) => {
      if (spec.set?.state === 'verification') throw new Error('plantage');
      return orig(key, spec);
    };
    await expect(confirm(k, u.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] })).rejects.toThrow();
    k.db.update = orig;
    expect((await jobsCancel(k.ctx, event({ params: { jobId: u.jobId } }))).statusCode).toBe(409);
    expect((await delScan(k.ctx, event({ params: { scanId: u.jobId } }))).statusCode).toBe(409);
    expect(await lock(k, coursId)).toBe(u.jobId);
  });

  it('expiration de la confirmation', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    await expire(k.ctx, { ...u.i, phase: 'confirm' });
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
  });

  it('plantage entre l ecriture de l en-tete et la transition: l expiration restaure le cours', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    const orig = k.db.update.bind(k.db);
    k.db.update = async (key, spec) => {
      if (spec.set?.state === 'verification') throw new Error('plantage');
      return orig(key, spec);
    };
    await expect(confirm(k, u.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] })).rejects.toThrow();
    k.db.update = orig;
    expect((await k.db.get(keys.cours('s1', coursId)))!.pages).toBe(3); // l'en-tete et les textes sont ecrits
    expect(await k.db.get(keys.coursText('s1', coursId, 3))).toBeDefined();
    await expire(k.ctx, { ...u.i, phase: 'confirm' });
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
    expect(k.figures.objects.has(figureKey('s1', coursId, 'f2'))).toBe(false);
  });

  it('course perdue (l annulation gagne pendant la confirmation)', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    const orig = k.db.update.bind(k.db);
    let done = false;
    k.db.update = async (key, spec) => {
      if (spec.set?.state === 'verification' && !done) {
        done = true;
        await endWithoutDoc(k.ctx, 's1', u.jobId, ['a_confirmer'], 'rejete', 'annule'); // l'annulation passe avant
      }
      return orig(key, spec);
    };
    expect((await confirm(k, u.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(409);
    k.db.update = orig;
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
  });

  it('panne de generate apres la consommation: fiches de l ajout supprimees, pages rendues, cours d origine identique', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    await confirm(k, u.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] });
    const { indices } = await sectionsPlan(k.ctx, u.i);
    for (const index of indices) {
      const ex = await extract(k.ctx, { ...u.i, index });
      await fakeVerify(k, ex.docId!);
      await sectionCost(k.ctx, { ...u.i, docId: ex.docId! });
    }
    await quotaConsume(k.ctx, u.i);
    k.ctx.port = { converse: async () => { throw new Error('Bedrock indisponible'); } };
    await expect(generate(k.ctx, { ...u.i, index: 0 })).rejects.toThrow();
    await failJob(k.ctx, { ...u.i, error: { Error: 'Error' } });
    await failJob(k.ctx, { ...u.i, error: { Error: 'Error' } }); // rejeu
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
    expect(await quota(k)).toMatchObject({ utilise: 2, reserve: 0, restant: 198 });
  });

  it('aucune affirmation exploitable (noClaims): ajout rejete, cours d origine identique, pages rendues', async () => {
    const k = await makeCtx(script({ extraction: JSON.stringify({ titre: 'x', matiere: 'svt', affirmations: [] }) }));
    mode.append = false;
    const o = await toReview(k, 2);
    // l'extraction du cours d'origine doit reussir: on le fabrique avec le script normal puis on change de modele
    k.ctx.port = (await makeCtx(script())).ctx.port;
    await confirm(k, o.jobId, { figures: [{ figureId: 'f1', keep: true }] });
    expect(await machine(k, o.i)).toBe(true);
    const coursId = o.jobId;
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    k.ctx.port = (await makeCtx(script({ extraction: JSON.stringify({ titre: 'x', matiere: 'svt', affirmations: [] }) }))).ctx.port;
    await confirm(k, u.jobId, { sections: SECTIONS });
    expect(await machine(k, u.i)).toBe(false);
    expect((await job(k, u.jobId)).state).toBe('rejete');
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
    expect(await quota(k)).toMatchObject({ utilise: 2, reserve: 0 });
  });

  it('une restauration rejouee apres qu un second ajout a pris le verrou ne change rien', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const first = await appendReview(k, coursId);
    const firstJob = await job(k, first.jobId);
    await endWithoutDoc(k.ctx, 's1', first.jobId, ['a_confirmer'], 'rejete', 'x');
    const second = await appendReview(k, coursId);
    await confirm(k, second.jobId, { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] });
    const mid = await snap(k, coursId);
    const head = JSON.stringify(await k.db.get(keys.cours('s1', coursId)));
    await restoreAfterFailedAppend(k.ctx, 's1', firstJob); // rejeu tardif du premier job
    await restoreAfterFailedAppend(k.ctx, 's1', await job(k, first.jobId));
    expect(await snap(k, coursId)).toBe(mid);
    expect(JSON.stringify(await k.db.get(keys.cours('s1', coursId)))).toBe(head);
    expect(await lock(k, coursId)).toBe(second.jobId);
    expect(await machine(k, second.i)).toBe(true);
    expect((await k.db.get(keys.cours('s1', coursId)))!.pages).toBe(3);
  });

  it('DELETE /scans/{id} d un ajout non confirme: restaure et libere le verrou', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const before = await snap(k, coursId);
    const u = await appendReview(k, coursId);
    expect((await delScan(k.ctx, event({ params: { scanId: u.jobId } }))).statusCode).toBe(204);
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBeUndefined();
  });
});

describe('reprise et cout', () => {
  it('transcribe rejoue sur un ajout: ni nouvel appel de modele ni nouveau passage du compteur du jour', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    mode.append = true;
    const u = await upload(k, 1, { coursId });
    await awaitUpload(k.ctx, { ...u.i, token: 'tok-up' });
    await scanCheck(k.ctx, u.i);
    expect((await transcribe(k.ctx, u.i)).ok).toBe(true);
    const calls = k.calls.length;
    const counter = (await k.db.get(keys.transcriptions('s1', '2026-12-01')))!.n;
    expect((await job(k, u.jobId)).textDone).toBe(true);
    expect((await transcribe(k.ctx, u.i)).ok).toBe(true);
    expect(k.calls.length).toBe(calls);
    expect((await k.db.get(keys.transcriptions('s1', '2026-12-01')))!.n).toBe(counter);
    expect(await k.db.get({ PK: `JOB#${u.jobId}`, SK: 'TEXT#1' })).toBeUndefined(); // pas de TEXT#1: l'ajout commence a la page 3
  });

  it('confirmation rejouee: pas de doublon de section, de texte ni de bloc', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    const req = { sections: SECTIONS, figures: [{ figureId: 'f1', keep: true }] };
    expect((await confirm(k, u.jobId, req)).statusCode).toBe(200);
    expect((await confirm(k, u.jobId, req)).statusCode).toBe(409); // la transition reste l'arbitre
    const head = (await k.db.get(keys.cours('s1', coursId)))!;
    expect((head.sections as unknown[]).length).toBe(3);
    expect(head.pages).toBe(3);
    const blocks = (await k.db.get(keys.coursBlocks('s1', coursId)))!;
    expect(new Set((blocks.blocks as { id: string }[]).map((b) => b.id)).size).toBe((blocks.blocks as unknown[]).length);
  });

  it('plafond de cout et quota: par page ajoutee', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    expect((await job(k, u.jobId)).pages).toBe(1);
    expect(await quota(k)).toMatchObject({ reserve: 1 });
  });
});

describe('DELETE /cours et ajout', () => {
  const del = (k: K, coursId: string) => coursH(k.ctx, { ...event({ params: { coursId } }), routeKey: 'DELETE /cours/{coursId}', queryStringParameters: { fiches: 'supprimer' } });
  it('pendant un ajout ouvert: 409, rien supprime', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    const before = await snap(k, coursId);
    expect((await del(k, coursId)).statusCode).toBe(409);
    expect(await snap(k, coursId)).toBe(before);
    expect(await lock(k, coursId)).toBe(u.jobId);
  });

  it('verrou d un job final non restaure: la suppression reprend la restauration puis supprime, tous les jobs perdent coursId', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const done = await appendDone(k, coursId); // un ajout reussi: le cours a deux jobs
    expect((await job(k, done.jobId)).coursId).toBe(coursId);
    const u = await appendReview(k, coursId);
    await k.db.update(jobKey('s1', u.jobId), { set: { state: 'echec', finishedAt: 'x' } }); // arret apres la transition, avant la restauration
    expect(await lock(k, coursId)).toBe(u.jobId);
    expect((await del(k, coursId)).statusCode).toBe(204);
    expect(await k.db.get(keys.cours('s1', coursId))).toBeUndefined();
    expect((await job(k, coursId)).coursId).toBeUndefined();
    expect((await job(k, done.jobId)).coursId).toBeUndefined();
    expect((await k.db.query(`JOB#${done.jobId}`)).filter((x) => x.SK.startsWith('TEXT#') || x.SK === 'BLOCKS')).toEqual([]);
    expect([...k.figures.objects.keys()]).toEqual([]);
  });

  it('pendant la suppression, aucun ajout ne demarre', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    await k.db.update(keys.cours('s1', coursId), { set: { appendJobId: 'suppression' } });
    const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    expect(r.statusCode).toBe(409);
    expect(await quota(k)).toMatchObject({ reserve: 0 });
  });
});

describe('confidentialite et isolation', () => {
  it('le parent ne lit ni le cours ni la transcription d un ajout; aucun texte de cours dans les erreurs', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    expect((await cours(k.ctx, parent({ params: { coursId } }))).statusCode).toBe(403);
    expect((await jobsTranscription(k.ctx, parent({ params: { jobId: u.jobId } }))).statusCode).toBe(403);
    const full = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId } }));
    expect(full.body).not.toMatch(/photosynthese|volcan/i);
  });

  it('la photo de l ajout est supprimee a la confirmation; l ajout n ecrit aucune photo hors de son job', async () => {
    const k = await makeCtx(script());
    const coursId = await makeCourse(k);
    const u = await appendReview(k, coursId);
    await confirm(k, u.jobId, { sections: SECTIONS });
    expect([...k.s3.objects.keys()].filter((x) => x.includes(u.jobId))).toEqual([]);
    expect(readJson([])).toBeTruthy();
  });
});
