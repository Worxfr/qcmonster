// R1-A: blocs, figures, LaTeX, retrait de phrases, suppression, isolation. Modele simule uniquement (aucun appel reel, aucun cout).
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import * as api from './api.js';
import { coursApi } from '../cours/cours.js';
import { docsRead } from '../docs/docs.js';
import { scansDelete } from '../scans/delete.js';
import { jobKey } from './ctx.js';
import { cropFigures, disabledFigureStore, figureKey, figuresConfig, tempFigureKey } from './figures.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { awaitConfirm, awaitUpload, failJob, scanCheck, scanStart, transcribe } from './steps.js';
import { extract, finalize, generate, quotaConsume, sectionCost, sectionsPlan } from './steps-doc.js';
import { classifyJson, COURSE_LINES, event, goodScript, JPEG, makeCtx, parent, type Script } from './testkit.js';

const jobsConfirm = guarded(api.jobsConfirm);
const jobsTranscription = guarded(api.jobsTranscription);
const scansCreate = guarded(api.scansCreate);
const cours = guarded(coursApi);
const docs = guarded(docsRead);
const delScan = guarded(scansDelete);
type K = Awaited<ReturnType<typeof makeCtx>>;
const body = (r: { body?: string }) => JSON.parse(r.body ?? '{}');

const MD = `# La photosynthese\n\n${COURSE_LINES.join('\n')}\n\n[[f1]]`;
const FIG = { id: 'f1', box: [0.1, 0.4, 0.8, 0.35], kind: 'schema', alt: 'Schema de la feuille', caption: 'Fig. 1' };
const readMd = (over: { md?: string; figures?: unknown[] } = {}) => JSON.stringify({ pages: [{ page: 1, suite: false, md: over.md ?? MD, figures: over.figures ?? [FIG] }] });
/** Un seul script: lecture (pages connues) ou reprise de cadres (aucune page dans l'invite). */
const script = (read: string, box = '{"figures":[{"n":1,"box":[0.2,0.2,0.5,0.5]}]}', over: Partial<Script> = {}): Script =>
  goodScript({ transcription: (pages) => (pages.length ? read : box), classify: classifyJson(), ...over });

async function toConfirm(k: K) {
  const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }));
  const jobId = body(r).jobId as string;
  const i = { jobId, sid: 's1' };
  const key = `${scansPrefix('s1', jobId)}0`;
  k.s3.objects.set(key, JPEG);
  await scanStart(k.ctx, { detail: { object: { key } } });
  await awaitUpload(k.ctx, { ...i, token: 'tok-up' });
  expect((await scanCheck(k.ctx, i)).ok).toBe(true);
  expect((await transcribe(k.ctx, i)).ok).toBe(true);
  return i;
}
async function toReview(k: K) {
  const i = await toConfirm(k);
  expect((await cropFigures(k.ctx, i)).ok).toBe(true);
  await awaitConfirm(k.ctx, { ...i, token: 'tok-conf' });
  return i;
}
const confirm = (k: K, jobId: string, b: Record<string, unknown> = {}) => jobsConfirm(k.ctx, event({ params: { jobId }, body: { corrections: [], ...b } }));
const quotaOf = async (k: K) => (await k.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>;

describe('lecture: blocs, figures, doute', () => {
  it('transcribe ecrit les blocs du job; cropFigures ecrit le recadrage; la transcription rend blocs, figures signees et doute', async () => {
    const k = await makeCtx(script(readMd({ md: MD.replace('Elle se deroule', '~Elle se deroule') })));
    const i = await toReview(k);
    expect(k.prompts[0]).toContain('[[f1]]'); // la consigne demande les figures
    expect(await k.db.get(keys.jobBlocks(i.jobId))).toMatchObject({ figures: [{ figureId: 'f1', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.35 } }] });
    expect(k.crop.calls).toEqual([{ box: { x: 0.1, y: 0.4, w: 0.8, h: 0.35 } }]);
    expect(k.s3.objects.has(tempFigureKey('s1', i.jobId, 'f1'))).toBe(true);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: i.jobId } })));
    expect(t.blocks.map((b: { kind: string }) => b.kind)).toEqual(['titre', 'paragraphe', 'figure']);
    expect(t.figures[0].url).toContain(`scans/s1/${i.jobId}/fig/f1.jpg`);
    expect(t.pages[0].sentences.filter((s: { doubt?: boolean }) => s.doubt).map((s: { id: string }) => s.id)).toEqual(['p1-s3']);
  });

  it('cadre invalide: reprise par le modele plus gros (Sonnet), cadre corrige', async () => {
    const k = await makeCtx(script(readMd({ figures: [{ ...FIG, box: [0, 0, 1, 1] }] })));
    const i = await toConfirm(k);
    expect((await k.db.get(keys.jobBlocks(i.jobId)))!.figures).toEqual([expect.objectContaining({ box: { x: 0.2, y: 0.2, w: 0.5, h: 0.5 } })]);
    expect(k.calls).toEqual(['transcription', 'classement', 'transcription']); // lecture, classement, reprise de cadre
  });

  it('cadre toujours invalide: page entiere (box absent), le scan ne echoue pas', async () => {
    const k = await makeCtx(script(readMd({ figures: [{ ...FIG, box: [0, 0, 1, 1] }] }), '{"figures":[{"n":1,"box":[0,0,1,1]}]}'));
    const i = await toReview(k);
    const fig = (await k.db.get(keys.jobBlocks(i.jobId)))!.figures as { box?: unknown; boxInvalid?: boolean }[];
    expect(fig[0].box).toBeUndefined();
    expect(fig[0].boxInvalid).toBeUndefined();
    expect(k.crop.calls).toEqual([{ box: undefined }]); // image de la page entiere
    expect(body(await jobsTranscription(k.ctx, event({ params: { jobId: i.jobId } }))).figures[0].box).toBeUndefined();
  });

  it('JobBudgetExceededError pendant la reprise: page entiere, pas d\'echec', async () => {
    const k = await makeCtx(script(readMd({ figures: [{ ...FIG, box: [0, 0, 1, 1] }] }), 'JAMAIS'));
    // le classement consomme tout le plafond du job: la reprise de cadre ne doit plus etre appelee
    Object.defineProperty(k.ctx.port, 'converse', {
      value: ((orig) => async (req: Parameters<typeof orig>[0]) => {
        if (!req.images?.length && req.prompt.includes('<texte>')) await k.db.update(jobKey('s1', [...k.s3.objects.keys()][0].split('/')[2]), { set: { coutMicros: 9_000_000 } });
        if (req.images?.length && !req.prompt.includes('image 1')) throw new Error('la reprise ne doit pas etre appelee');
        return orig(req);
      })(k.ctx.port.converse.bind(k.ctx.port)),
    });
    const i = await toReview(k);
    expect(((await k.db.get(keys.jobBlocks(i.jobId)))!.figures as { box?: unknown }[])[0].box).toBeUndefined();
  });

  it('toute autre erreur de la reprise (debit, reseau): page entiere, la lecture payee n\'est pas rejouee', async () => {
    const k = await makeCtx(script(readMd({ figures: [{ ...FIG, box: [0, 0, 1, 1] }] })));
    const orig = k.ctx.port.converse.bind(k.ctx.port);
    Object.defineProperty(k.ctx.port, 'converse', { value: async (req: Parameters<typeof orig>[0]) => { if (req.prompt.includes('Repere chaque figure')) throw Object.assign(new Error('debit'), { name: 'ThrottlingException' }); return orig(req); } });
    const i = await toReview(k);
    expect(((await k.db.get(keys.jobBlocks(i.jobId)))!.figures as { box?: unknown }[])[0].box).toBeUndefined();
    expect(await k.db.get({ PK: `JOB#${i.jobId}`, SK: 'TEXT#1' })).toBeDefined();
    expect(k.calls.filter((c) => c === 'transcription')).toHaveLength(1); // une seule lecture (la reprise a echoue avant de repondre)
  });

  it('FIGURES_ENABLED=false: aucune figure demandee ni gardee, cropFigures sans effet', async () => {
    const k = await makeCtx(script(readMd()));
    k.ctx.cfg = { figuresEnabled: false };
    const i = await toReview(k);
    expect(k.prompts[0]).not.toContain('[[f1]]');
    expect((await k.db.get(keys.jobBlocks(i.jobId)))!.figures).toEqual([]);
    expect(k.crop.calls).toEqual([]);
    expect(body(await jobsTranscription(k.ctx, event({ params: { jobId: i.jobId } }))).figures).toBeUndefined();
  });

  it('FIGURE_BOX_MODEL=sonnet: Sonnet donne les cadres meme quand Haiku en a un valide', async () => {
    const k = await makeCtx(script(readMd()));
    k.ctx.cfg = { figureBoxModel: 'sonnet' };
    const i = await toConfirm(k);
    expect(((await k.db.get(keys.jobBlocks(i.jobId)))!.figures as { box: { x: number } }[])[0].box.x).toBe(0.2);
  });
});

describe('cropFigures en panne: le scan echoue, quota rendu une seule fois', () => {
  it('apres reprises, l\'erreur remonte; failJob rend le quota une fois et supprime les recadrages', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toConfirm(k);
    k.crop.fail.on = true;
    await expect(cropFigures(k.ctx, i)).rejects.toThrow('sharp');
    await expect(cropFigures(k.ctx, i)).rejects.toThrow('sharp'); // reprise de la machine
    expect((await quotaOf(k)).reserve).toBe(1);
    await failJob(k.ctx, { ...i, error: { Error: 'Error' } });
    await failJob(k.ctx, { ...i, error: { Error: 'Error' } }); // rejeu
    expect((await k.db.get(jobKey('s1', i.jobId)))!.state).toBe('echec');
    expect((await quotaOf(k)).reserve ?? 0).toBe(0);
    expect((await quotaOf(k)).consomme ?? 0).toBe(0);
    expect([...k.s3.objects.keys()].filter((x) => x.includes('/fig/'))).toEqual([]);
    expect(await k.db.get(keys.jobBlocks(i.jobId))).toBeUndefined();
  });
  it('cropFigures est idempotent: une figure deja ecrite n\'est pas rognee deux fois', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toConfirm(k);
    await cropFigures(k.ctx, i);
    await cropFigures(k.ctx, i);
    expect(k.crop.calls).toHaveLength(1);
  });
});

describe('confirmation: figures, retrait, LaTeX', () => {
  it('figureId inconnu: 400, rien n\'est modifie', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    const r = await confirm(k, i.jobId, { figures: [{ figureId: 'f9', keep: true }] });
    expect(r.statusCode).toBe(400);
    expect((await k.db.get(jobKey('s1', i.jobId)))!.state).toBe('a_confirmer');
    expect(await k.db.get(keys.cours('s1', i.jobId))).toBeUndefined();
    expect(k.figures.objects.size).toBe(0);
  });

  it('par defaut rien n\'est garde; une figure gardee est copiee, avec son alt corrige; le recadrage temporaire part avec la photo', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    expect((await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true, alt: 'Ma description' }] })).statusCode).toBe(200);
    expect([...k.figures.objects.keys()]).toEqual([figureKey('s1', i.jobId, 'f1')]);
    const b = (await k.db.get(keys.coursBlocks('s1', i.jobId)))!;
    expect(b.figures).toEqual([expect.objectContaining({ figureId: 'f1', alt: 'Ma description' })]);
    expect((b.blocks as { kind: string }[]).map((x) => x.kind)).toEqual(['titre', 'paragraphe', 'figure']);
    expect([...k.s3.objects.keys()].filter((x) => x.startsWith(scansPrefix('s1', i.jobId)))).toEqual([]);

    const k2 = await makeCtx(script(readMd()));
    const i2 = await toReview(k2);
    await confirm(k2, i2.jobId, {});
    expect(k2.figures.objects.size).toBe(0);
    const b2 = (await k2.db.get(keys.coursBlocks('s1', i2.jobId)))!;
    expect(b2.figures).toEqual([]);
    expect((b2.blocks as { kind: string }[]).some((x) => x.kind === 'figure')).toBe(false); // pas de bloc de figure sans image
  });

  it('erreur S3 pendant la copie: 503, etat du job inchange, rien de garde', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    k.figures.failCopy.on = true;
    const r = await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] });
    expect(r.statusCode).toBe(503);
    expect((await k.db.get(jobKey('s1', i.jobId)))!.state).toBe('a_confirmer');
    expect(await k.db.get(keys.cours('s1', i.jobId))).toBeUndefined();
    k.figures.failCopy.on = false;
    expect((await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(200); // l'eleve renvoie la confirmation
  });

  it('course perdue (job annule pendant la copie): le cours orphelin ET ses figures sont supprimes', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    k.figures.copyFromScans = async (a, b) => {
      await delScan(k.ctx, event({ params: { scanId: i.jobId } })); // annulation pendant la confirmation, avant que la copie n'ecrive
      k.figures.objects.set(b, JPEG); // la copie, deja en vol, ecrit apres l'annulation
      return true;
    };
    expect((await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(409);
    expect(k.figures.objects.size).toBe(0);
    expect(await k.db.get(keys.coursBlocks('s1', i.jobId))).toBeUndefined();
    expect(await k.db.get(keys.cours('s1', i.jobId))).toBeUndefined();
  });

  it('une copie de figure laissee par une confirmation interrompue ne survit pas a la fin du scan', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    k.figures.objects.set(figureKey('s1', i.jobId, 'f1'), JPEG);
    await delScan(k.ctx, event({ params: { scanId: i.jobId } }));
    expect(k.figures.objects.size).toBe(0);
  });

  it('removed: phrase inconnue = 400; phrase retiree absente du cours, des blocs et de la copie de travail; debut de section retire = 400', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    expect((await confirm(k, i.jobId, { removed: ['p9-s9'] })).statusCode).toBe(400);
    expect((await confirm(k, i.jobId, { removed: ['p1-s1'], sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }] })).statusCode).toBe(400);
    expect((await k.db.get(jobKey('s1', i.jobId)))!.state).toBe('a_confirmer');
    expect((await confirm(k, i.jobId, { removed: ['p1-s1', 'p1-s9'], corrections: [{ id: 'p1-s9', text: 'inutile' }] })).statusCode).toBe(200);
    const text = (await k.db.get(keys.coursText('s1', i.jobId, 1)))!;
    expect((text.sentences as { id: string }[]).map((s) => s.id)).not.toContain('p1-s1');
    expect((text.sentences as { id: string }[]).map((s) => s.id)).not.toContain('p1-s9');
    const blocks = (await k.db.get(keys.coursBlocks('s1', i.jobId)))!.blocks as { kind: string; sentenceIds?: string[] }[];
    expect(blocks.map((b) => b.kind)).toEqual(['paragraphe']); // le titre n'avait que p1-s1
    expect(blocks[0].sentenceIds).not.toContain('p1-s9');
    expect(((await k.db.get({ PK: `JOB#${i.jobId}`, SK: 'TEXT#1' }))!.sentences as { id: string }[]).map((s) => s.id)).not.toContain('p1-s1');
  });

  it('purgeScan (job deja termine, reparation d\'un nettoyage interrompu): figures/ du cours supprime meme si endWithoutDoc ne repasse pas', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] });
    expect(k.figures.objects.size).toBe(1);
    await k.db.update(jobKey('s1', i.jobId), { set: { state: 'echec' } }); // fin deja decidee: seul `purgeScan` nettoie
    await failJob(k.ctx, { ...i, error: { Error: 'Error' } });
    expect(k.figures.objects.size).toBe(0);
    expect(await k.db.get(keys.cours('s1', i.jobId))).toBeUndefined();
    expect(await k.db.get(keys.coursBlocks('s1', i.jobId))).toBeUndefined();
  });

  it('doute eteint par la correction et jamais garde dans le cours', async () => {
    const k = await makeCtx(script(readMd({ md: MD.replace('Elle se deroule', '~Elle se deroule') })));
    const i = await toReview(k);
    await confirm(k, i.jobId, { corrections: [{ id: 'p1-s3', text: 'Elle se deroule dans les chloroplastes.' }] });
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', i.jobId, 1)))).not.toContain('doubt');
  });

  it('LaTeX: une correction a formule interdite ou a $ impair est refusee (400), une formule sure est acceptee', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await toReview(k);
    for (const text of ['Voir $\\href{http://a}{b}$', 'coute 5 $ environ', '$\\htmlData{a=b}{c}$']) {
      expect((await confirm(k, i.jobId, { corrections: [{ id: 'p1-s3', text }] })).statusCode).toBe(400);
    }
    expect((await k.db.get(jobKey('s1', i.jobId)))!.state).toBe('a_confirmer');
    expect((await confirm(k, i.jobId, { corrections: [{ id: 'p1-s3', text: 'Soit $E = mc^{2}$.' }] })).statusCode).toBe(200);
  });
});

describe('suppression: ordre, S3 avant DynamoDB, isolation, parent', () => {
  async function confirmed(k: K) {
    const i = await toReview(k);
    await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] });
    return i;
  }
  it('DELETE /cours: figures/ supprime AVANT l\'en-tete, puis blocs et copie de travail', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await confirmed(k);
    const seen: boolean[] = [];
    const del = k.figures.deleteAll;
    k.figures.deleteAll = async (p) => {
      seen.push(!!(await k.db.get(keys.cours('s1', i.jobId)))); // l'en-tete existe encore quand S3 est vide
      return del(p);
    };
    const bare = { ...event({ params: { coursId: i.jobId } }), routeKey: 'DELETE /cours/{coursId}' };
    expect((await cours(k.ctx, bare as never)).statusCode).toBe(400); // `fiches` obligatoire
    const ev = { ...bare, queryStringParameters: { fiches: 'garder' } };
    expect((await cours(k.ctx, ev as never)).statusCode).toBe(204);
    expect(seen).toEqual([true]);
    expect(k.figures.objects.size).toBe(0);
    expect(await k.db.get(keys.coursBlocks('s1', i.jobId))).toBeUndefined();
    expect(await k.db.get(keys.jobBlocks(i.jobId))).toBeUndefined();
  });

  it('GET /cours: blocs et figures signees avec le sid du jeton; le cours d\'un autre eleve est introuvable', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await confirmed(k);
    const get = (who: Parameters<typeof event>[0], id: string) => cours(k.ctx, { ...event({ ...who, params: { coursId: id } }), routeKey: 'GET /cours/{coursId}' } as never);
    const ok = body(await get({}, i.jobId));
    expect(ok.figures[0].url).toContain(`figures/s1/${i.jobId}/f1.jpg`);
    expect(ok.blocks).toHaveLength(3);
    expect(ok.figureCount).toBe(1);
    await k.db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s3', cognitoSub: 'sub-s3', statut: 'actif' });
    expect((await get({ sub: 'sub-s3' }, i.jobId)).statusCode).toBe(404);
    expect((await get({ sub: 'sub-p', groups: '[parent]' }, i.jobId)).statusCode).toBe(403);
  });

  it('marques: le statut le plus severe par phrase; un docId etranger place dans l\'en-tete n\'est jamais lu', async () => {
    const k = await makeCtx(script(readMd()));
    const i = await confirmed(k);
    const head = (await k.db.get(keys.cours('s1', i.jobId)))!;
    await k.db.put({ ...head, sections: [...(head.sections as unknown[]), { fromSentenceId: 'p1-s2', subject: 'svt', ignore: false, docId: 'FOREIGN', statut: 'fiche' }] });
    await k.db.put({ PK: 'STUDENT#s3', SK: 'DOC#FOREIGN', titre: 'x' });
    await k.db.put({ ...keys.claim('FOREIGN', 1), texte: 'secret', origine: { page: 1, phraseId: 'p1-s4', extrait: 'x' }, type: 'factuelle', aRisque: false });
    await k.db.put({ PK: 'STUDENT#s1', SK: 'DOC#D1', titre: 'Fiche' });
    await k.db.put({ ...keys.claim('D1', 1), texte: 'a', origine: { page: 1, phraseId: 'p1-s3', extrait: 'x' }, type: 'factuelle', aRisque: false });
    await k.db.put({ ...keys.claim('D1', 2), texte: 'b', origine: { page: 1, phraseId: 'p1-s3', extrait: 'x' }, type: 'factuelle', aRisque: false });
    await k.db.put({ ...keys.verdict('D1', 1), statut: 'verifiee', sources: [] });
    await k.db.put({ ...keys.verdict('D1', 2), statut: 'erreur', sources: [] });
    await k.db.put({ ...head, sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', ignore: false, docId: 'D1', statut: 'fiche' }, { fromSentenceId: 'p1-s2', subject: 'svt', ignore: false, docId: 'FOREIGN', statut: 'fiche' }] });
    const r = body(await cours(k.ctx, { ...event({ params: { coursId: i.jobId } }), routeKey: 'GET /cours/{coursId}' } as never));
    expect(r.marks).toEqual([{ sentenceId: 'p1-s3', status: 'erreur', docId: 'D1', claimId: '02' }]);
  });

  it('fiche: paragraphes, rappel copie et figures pour l\'eleve; le parent ne recoit ni body, ni recall, ni figures', async () => {
    const claimsOut = (id: string) => ({ phraseId: id, extrait: 'dans les chloroplastes', texte: 'La photosynthese se deroule dans les chloroplastes.', type: 'factuelle', aRisque: false });
    const k = await makeCtx(
      script(readMd(), undefined, {
        extraction: JSON.stringify({ titre: 'La photosynthese', matiere: 'svt', affirmations: [claimsOut('p1-s3')] }),
        generation: JSON.stringify({ resume: 'ancien', fiche: { paragraphes: [{ heading: 'Lieu', text: 'La photosynthese a lieu dans les chloroplastes.', claimIds: ['01'] }], rappel: [{ kind: 'definition', claimId: '01', text: 'INVENTE' }] }, qcm: [], trous: [] }),
      }),
    );
    const i = await toReview(k);
    await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] });
    const { indices } = await sectionsPlan(k.ctx, i);
    const ex = await extract(k.ctx, { ...i, index: indices[0] });
    for (const c of await k.db.query(`DOC#${ex.docId}`, 'CLAIM#')) await k.db.put({ ...keys.verdict(ex.docId!, Number(c.SK.slice(6))), statut: 'verifiee', sources: [] });
    await sectionCost(k.ctx, { ...i, docId: ex.docId! });
    await quotaConsume(k.ctx, i);
    await generate(k.ctx, { ...i, index: 0 });
    await finalize(k.ctx, i);
    const read = (e: ReturnType<typeof event>) => docs(k.ctx, { ...e, routeKey: 'GET /docs/{docId}', pathParameters: { docId: ex.docId! } } as never);
    const eleve = body(await read(event()));
    expect(eleve.body).toEqual([{ heading: 'Lieu', text: 'La photosynthese a lieu dans les chloroplastes.', claimIds: ['01'] }]);
    expect(eleve.recall).toEqual([{ kind: 'definition', text: 'La photosynthese se deroule dans les chloroplastes.', claimId: '01', verified: true }]);
    expect(eleve.summary).toBe('La photosynthese a lieu dans les chloroplastes.');
    expect(eleve.claims[0].sentenceId).toBe('p1-s3');
    expect(eleve.figures[0].url).toContain(`figures/s1/${i.jobId}/f1.jpg`);
    const pere = body(await read(parent()));
    expect(pere.body).toBeUndefined();
    expect(pere.recall).toBeUndefined();
    expect(pere.figures).toBeUndefined();
    expect(JSON.stringify(pere)).not.toContain('figures/');
    expect(pere.claims[0].sentenceId).toBeUndefined();
  });
});

describe('mode sans figures (R1-A deploye avant le bucket et la couche de R1-B)', () => {
  it('figuresConfig: actif seulement avec FIGURES_ENABLED=true ET un bucket', () => {
    expect(figuresConfig({}).enabled).toBe(false);
    expect(figuresConfig({ QCM_FIGURES_BUCKET: 'b' }).enabled).toBe(false);
    expect(figuresConfig({ FIGURES_ENABLED: 'true' }).enabled).toBe(false);
    expect(figuresConfig({ FIGURES_ENABLED: 'false', QCM_FIGURES_BUCKET: 'b' }).enabled).toBe(false);
    expect(figuresConfig({ FIGURES_ENABLED: 'true', QCM_FIGURES_BUCKET: 'b' })).toEqual({ enabled: true, bucket: 'b' });
  });

  it('le scan marche en texte de bout en bout: aucune figure demandee, rognee, ecrite ni copiee, suppression sans erreur', async () => {
    const k = await makeCtx(script(readMd()));
    k.ctx.figures = disabledFigureStore(); // aucun bucket: toute ecriture ou signature leverait
    k.ctx.cfg = { figuresEnabled: false };
    const i = await toReview(k);
    expect(k.prompts[0]).not.toContain('[[f1]]');
    expect(k.crop.calls).toEqual([]);
    expect([...k.s3.objects.keys()].filter((x) => x.includes('/fig/'))).toEqual([]);
    const t = body(await jobsTranscription(k.ctx, event({ params: { jobId: i.jobId } })));
    expect(t.figures).toBeUndefined();
    expect(t.blocks.some((b: { kind: string }) => b.kind === 'figure')).toBe(false);
    expect((await confirm(k, i.jobId, { corrections: [{ id: 'p1-s3', text: 'Phrase corrigee.' }] })).statusCode).toBe(200);
    expect((await confirm(k, i.jobId, { figures: [{ figureId: 'f1', keep: true }] })).statusCode).toBe(409); // deja confirme
    const get = { ...event({ params: { coursId: i.jobId } }), routeKey: 'GET /cours/{coursId}' };
    const c = body(await cours(k.ctx, get as never));
    expect(c.figures).toEqual([]);
    const del = { ...get, routeKey: 'DELETE /cours/{coursId}', queryStringParameters: { fiches: 'supprimer' } };
    expect((await cours(k.ctx, del as never)).statusCode).toBe(204);
  });

  it('echec et annulation sans bucket: aucun appel au stockage des figures', async () => {
    const k = await makeCtx(script(readMd()));
    k.ctx.figures = disabledFigureStore();
    k.ctx.cfg = { figuresEnabled: false };
    const i = await toReview(k);
    await failJob(k.ctx, { ...i, error: { Error: 'Error' } });
    expect((await k.db.get(jobKey('s1', i.jobId)))!.state).toBe('echec');
    const k2 = await makeCtx(script(readMd()));
    k2.ctx.figures = disabledFigureStore();
    k2.ctx.cfg = { figuresEnabled: false };
    const i2 = await toReview(k2);
    expect((await delScan(k2.ctx, event({ params: { scanId: i2.jobId } }))).statusCode).toBe(204);
  });
});
