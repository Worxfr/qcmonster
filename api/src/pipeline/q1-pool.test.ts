// Q1: second tour de generation (la banque), docs/Q1-design.md sections 4 et 12.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema, parseQuestionId } from '../../../shared/items.js';
import * as api from './api.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { addVariants } from './pool-gen.js';
import { awaitConfirm, awaitUpload, scanCheck, scanStart, transcribe } from './steps.js';
import { extract, generate } from './steps-doc.js';
import { event, goodScript, JPEG, makeCtx, type Script } from './testkit.js';

type K = Awaited<ReturnType<typeof makeCtx>>;
const scansCreate = guarded(api.scansCreate);
const jobsConfirm = guarded(api.jobsConfirm);

async function verified(k: K, status: 'verifiee' | 'non_verifiable' = 'verifiee') {
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
  for (const c of await k.db.query(`DOC#${ex.docId}`, 'CLAIM#')) await k.db.put({ ...keys.verdict(ex.docId!, Number(c.SK.slice(6))), statut: status, secondeLecture: false, sources: [] });
  return { i, docId: ex.docId! };
}

const VARIANTS = JSON.stringify({
  qcm: [
    { claimId: '01', enonce: 'Quel organite abrite la photosynthese chez la plante ?', choix: ['Les chloroplastes', 'Les racines', 'Le noyau', 'La vacuole'], cle: 0 }, // retenu
    { claimId: '02', enonce: 'Par quel organe le dioxyde de carbone entre-t-il ?', choix: ['Les feuilles', 'Les racines', 'Le tronc', 'Les fleurs'], cle: 0 }, // rejete a l'aveugle (solve: 3)
    { claimId: '01', enonce: 'Ou se deroule la photosynthese ?', choix: ['Dans les chloroplastes', 'Dans les racines', 'Dans le noyau', 'Dans le sol'], cle: 0 }, // jumelle du premier tour
  ],
  trous: [
    { claimId: '03', phrase: 'Le dioxygene est ____ dans l atmosphere.', attendu: 'rejete' }, // retenu
    { claimId: '04', phrase: 'La chlorophylle donne sa couleur ____ aux feuilles.', attendu: 'verte' }, // meme fait, meme reponse que le premier tour
  ],
});
const withVariants = (v: Script['variantes']): Script => goodScript({ variantes: v });
const nn = (items: { questionId: string }[]) => items.map((x) => parseQuestionId(x.questionId).nn);

describe('Q1: banque de questions (second tour)', () => {
  it('ajoute les variantes retenues apres le premier tour, jette les jumelles et les QCM refuses a l\'aveugle', async () => {
    const k = await makeCtx(withVariants(VARIANTS));
    const { i, docId } = await verified(k);
    const r = await generate(k.ctx, i);
    expect(r).toMatchObject({ qcm: 3, gaps: 2 });
    const qcm = (await k.db.query(`DOC#${docId}`, 'QCM#')).map((q) => QcmItemSchema.parse(q));
    const gaps = (await k.db.query(`DOC#${docId}`, 'GAP#')).map((q) => GapItemSchema.parse(q));
    expect(nn(qcm)).toEqual([1, 2, 3]); // le premier tour garde 01 et 02
    expect(nn(gaps)).toEqual([1, 2]);
    expect(qcm[2].choix[qcm[2].cle]).toBe('Les chloroplastes');
    expect(gaps[1].attendu).toBe('rejete');
    expect((await k.db.get(keys.doc('s1', docId)))!.nbQuestions).toBe(5);
    // 4 appels de modele au lieu de 2: generation, controle, variantes, controle
    expect(k.calls.filter((c) => ['generation', 'solve', 'variantes'].includes(c))).toEqual(['generation', 'solve', 'variantes', 'solve']);
  });

  it('sans variantes retenues: aucune ecriture de plus', async () => {
    const k = await makeCtx(goodScript());
    const { i, docId } = await verified(k);
    await generate(k.ctx, i);
    expect(k.calls.filter((c) => c === 'solve')).toHaveLength(1);
    expect(k.calls).toContain('variantes');
    expect((await k.db.get(keys.doc('s1', docId)))!.nbQuestions).toBe(3);
  });

  it.each([
    ['sortie illisible', "ceci n'est pas du json"],
    ['limitation de debit ou delai (erreur levee par l\'appel)', () => { throw new Error('ThrottlingException'); }],
  ])('%s: la fiche est publiee avec le premier tour, sans erreur', async (_n, v) => {
    const k = await makeCtx(withVariants(v as Script['variantes']));
    const { i, docId } = await verified(k);
    const r = await generate(k.ctx, i);
    expect(r).toMatchObject({ qcm: 2, gaps: 1 });
    expect(await k.db.get(keys.doc('s1', docId))).toBeDefined();
    expect(k.calls.filter((c) => c === 'generation')).toHaveLength(1);
  });

  it('sortie coupee par la limite de jetons: les objets entiers sont recuperes', async () => {
    const cut = VARIANTS.slice(0, VARIANTS.indexOf('"trous"') - 1) + ',"trous":[{"claimId":"04","phrase":"La chlorophylle donne sa ____ verte aux feu';
    const k = await makeCtx(withVariants(cut));
    const { i, docId } = await verified(k);
    await generate(k.ctx, i);
    expect(nn((await k.db.query(`DOC#${docId}`, 'QCM#')) as never)).toEqual([1, 2, 3]);
    expect(await k.db.query(`DOC#${docId}`, 'GAP#')).toHaveLength(1);
  });

  it('pas de second tour sans fait verifie', async () => {
    const k = await makeCtx(withVariants(VARIANTS));
    const { i, docId } = await verified(k, 'non_verifiable');
    await generate(k.ctx, i);
    expect(k.calls).not.toContain('variantes');
    expect((await k.db.get(keys.doc('s1', docId)))!.nbQuestions).toBe(0);
  });

  it('pas de second tour si le premier tour est vide', async () => {
    const k = await makeCtx(withVariants(VARIANTS));
    const { i, docId } = await verified(k);
    const eligible = new Map([['01', { id: '01', texte: 'x' }]]);
    expect(await addVariants(k.ctx, i, docId, eligible, { qcm: [], gaps: [] }, Date.now())).toEqual({ qcm: 0, gaps: 0 });
    expect(k.calls).not.toContain('variantes');
  });

  it('pas de second tour apres 120 s de generate', async () => {
    const k = await makeCtx(withVariants(VARIANTS));
    const { i, docId } = await verified(k);
    const eligible = new Map([['01', { id: '01', texte: 'La photosynthese se deroule dans les chloroplastes.' }]]);
    const first = { qcm: [{ claimId: '01', enonce: 'Ou se deroule la photosynthese ?', choix: ['Dans les chloroplastes', 'Dans les racines', 'Dans le noyau', 'Dans le sol'], cle: 0 }], gaps: [] };
    const started = k.ctx.now().getTime() - 121_000;
    expect(await addVariants(k.ctx, i, docId, eligible, first, started)).toEqual({ qcm: 0, gaps: 0 });
    expect(k.calls).not.toContain('variantes');
  });

  it("numerotation a partir de max(nn)+1, jamais d'ecrasement, arret a 99", async () => {
    const k = await makeCtx(withVariants(VARIANTS));
    const { i, docId } = await verified(k);
    const eligible = new Map([
      ['01', { id: '01', texte: 'La photosynthese se deroule dans les chloroplastes.' }],
      ['04', { id: '04', texte: 'La chlorophylle donne sa couleur verte aux feuilles.' }],
    ]);
    await k.db.put({ ...keys.qcm(docId, 98), questionId: `${docId}:qcm:98`, enonce: 'ancienne', choix: ['a', 'b', 'c', 'd'], cle: 0, claimId: '01' });
    const first = { qcm: [{ claimId: '01', enonce: 'Ou se deroule la photosynthese ?', choix: ['Dans les chloroplastes', 'Dans les racines', 'Dans le noyau', 'Dans le sol'], cle: 0 }], gaps: [{ claimId: '04', phrase: 'La chlorophylle donne sa couleur ____ aux feuilles.', attendu: 'verte' }] };
    const r = await addVariants(k.ctx, i, docId, eligible, first, k.ctx.now().getTime());
    expect(r.qcm).toBe(1);
    expect(nn((await k.db.query(`DOC#${docId}`, 'QCM#')) as never).filter((n) => n >= 98)).toEqual([98, 99]);
    expect((await k.db.get(keys.qcm(docId, 98)))!.enonce).toBe('ancienne');
    const again = await addVariants(k.ctx, i, docId, eligible, first, k.ctx.now().getTime());
    expect(again.qcm).toBe(0); // plus de numero libre: rien n'est ecrit, aucune erreur
  });
});
