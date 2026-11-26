// Dette de #89 (revue de la PR #101, m2): deux confirmations DIFFERENTES du meme job (deux onglets) ne se melangent plus. La confirmation est reclamee
// (`confirmFp`, condition sur l'etat) AVANT l'ecriture du cours; la perdante ne laisse rien. Le meme corps rejoue apres une panne reprend avec les memes identifiants.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import * as api from './api.js';
import { jobKey } from './ctx.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { cropFigures } from './figures.js';
import { awaitConfirm, awaitUpload, scanCheck, scanStart, transcribe } from './steps.js';
import { classifyJson, COURSE_LINES, event, goodScript, JPEG, makeCtx } from './testkit.js';

const jobsConfirm = guarded(api.jobsConfirm);
const scansCreate = guarded(api.scansCreate);
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}');
const MD = `# La photosynthese\n\n${COURSE_LINES.join('\n')}`;

const MDF = `${MD}\n\n[[f1]]`;
async function review(withFigure = false) {
  const figs = [{ id: 'f1', box: [0.1, 0.4, 0.8, 0.35], kind: 'schema', alt: 'Schema', caption: 'Fig' }];
  const k = await makeCtx(goodScript({ transcription: (pages) => JSON.stringify({ pages: pages.map((page) => ({ page, suite: false, md: withFigure ? MDF : MD, figures: withFigure ? figs : [] })) }), classify: classifyJson() }));
  const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }));
  const i = { jobId: body(r).jobId as string, sid: 's1' };
  const key = `${scansPrefix('s1', i.jobId)}0`;
  k.s3.objects.set(key, JPEG);
  await scanStart(k.ctx, { detail: { object: { key } } });
  await awaitUpload(k.ctx, { ...i, token: 'tok-up' });
  await scanCheck(k.ctx, i);
  await transcribe(k.ctx, i);
  await cropFigures(k.ctx, i);
  await awaitConfirm(k.ctx, { ...i, token: 'tok-conf' });
  return { k, i };
}
const confirm = (k: Awaited<ReturnType<typeof review>>['k'], jobId: string, b: Record<string, unknown>) => jobsConfirm(k.ctx, event({ params: { jobId }, body: { corrections: [], ...b } }));
const A = { added: [{ key: 'n1', afterId: 'p1-s2', text: 'Phrase ajoutee par le premier onglet de l eleve.' }] };
const B = { added: [{ key: 'n1', afterId: 'p1-s3', text: 'Phrase ajoutee par le second onglet de l eleve.' }] };

describe('jobs-confirm: deux requetes differentes', () => {
  it('la seconde requete (autre contenu) est refusee 409 AVANT toute ecriture: le cours durable est celui de la premiere', async () => {
    const { k, i } = await review();
    expect((await confirm(k, i.jobId, A)).statusCode).toBe(200);
    const before = JSON.stringify([...k.db.items.entries()]);
    expect((await confirm(k, i.jobId, B)).statusCode).toBe(409);
    expect(JSON.stringify([...k.db.items.entries()])).toBe(before);
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', i.jobId, 1)))).toContain('premier onglet');
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', i.jobId, 1)))).not.toContain('second onglet');
  });
  it('en course (les deux lisent le job a confirmer): une seule reclame gagne, l\'autre ne laisse rien et n\'ecrase pas le cours', async () => {
    const { k, i } = await review();
    const rs = await Promise.all([confirm(k, i.jobId, A), confirm(k, i.jobId, B)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([200, 409]);
    const winner = rs[0].statusCode === 200 ? 'premier' : 'second';
    const text = JSON.stringify(await k.db.get(keys.coursText('s1', i.jobId, 1)));
    expect(text).toContain(`${winner} onglet`);
    const job = (await k.db.get(jobKey('s1', i.jobId)))!;
    // la fiche du plan du job est celle du cours: memes identifiants
    const head = (await k.db.get(keys.cours('s1', i.jobId)))!;
    expect((head.sections as { docId?: string }[]).map((s) => s.docId)).toEqual((job.sections as { docId?: string }[]).map((s) => s.docId));
  });
  it('le meme corps rejoue apres une panne reprend avec les MEMES identifiants de fiches', async () => {
    const { k, i } = await review();
    let boom = true;
    const db = { ...k.ctx.db, put: async (...a: Parameters<typeof k.ctx.db.put>) => { if (boom && a[0].SK.includes('#T')) { boom = false; throw new Error('panne'); } return k.ctx.db.put(...a); } };
    await expect(jobsConfirm({ ...k.ctx, db: db as typeof k.ctx.db }, event({ params: { jobId: i.jobId }, body: { corrections: [], ...A } }))).rejects.toThrow('panne');
    const first = (await k.db.get(jobKey('s1', i.jobId)))!;
    expect(first.state).toBe('a_confirmer'); // panne avant la transition: le meme onglet peut recommencer
    expect(first.confirmDocIds).toHaveLength(1);
    expect((await confirm(k, i.jobId, B)).statusCode).toBe(409); // une autre requete reste refusee
    expect((await confirm(k, i.jobId, A)).statusCode).toBe(200);
    expect((await k.db.get(jobKey('s1', i.jobId)))!.docIds).toEqual(first.confirmDocIds);
  });
  it('mutation de la garde: sans confirmFp la seconde requete ecraserait le cours (le test ci-dessus la detecte)', async () => {
    const { k, i } = await review();
    await confirm(k, i.jobId, A);
    const job = (await k.db.get(jobKey('s1', i.jobId)))!;
    expect(typeof job.confirmFp).toBe('string');
    expect(job.confirmStartedAt).toBeDefined();
  });
  it('copie des figures impossible (503): la reclamation est rendue, une relecture corrigee (autre corps) peut etre renvoyee', async () => {
    const { k, i } = await review(true);
    k.figures.failCopy.on = true;
    const fig = { figures: [{ figureId: 'f1', keep: true }] };
    expect((await confirm(k, i.jobId, { ...A, ...fig })).statusCode).toBe(503);
    const job = (await k.db.get(jobKey('s1', i.jobId)))!;
    expect(job.state).toBe('a_confirmer');
    expect(job.confirmFp).toBeUndefined();
    expect(job.confirmDocIds).toBeUndefined();
    k.figures.failCopy.on = false;
    expect((await confirm(k, i.jobId, { ...B, ...fig })).statusCode).toBe(200);
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', i.jobId, 1)))).toContain('second onglet');
  });
});
