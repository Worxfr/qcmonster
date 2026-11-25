import { describe, expect, it } from 'vitest';
import { guarded } from '../pipeline/http.js';
import { body, ev, putDoc, putJob, world, type World } from '../scans/kit.js';
import { coursApi } from './cours.js';

const get = (t: World, who: Parameters<typeof ev>[0], id: string) => guarded(coursApi)(t.ctx, ev(who, 'GET /cours/{coursId}', { params: { coursId: id } }));
const del = (t: World, who: Parameters<typeof ev>[0], id: string, fiches?: string) => guarded(coursApi)(t.ctx, ev(who, 'DELETE /cours/{coursId}', { params: { coursId: id }, query: fiches ? { fiches } : {} }));
const has = async (t: World, pk: string, sk: string) => (await t.db.get({ PK: pk, SK: sk })) !== undefined;

/** Cours C1 de s1 (2 pages, 3 sections: fiche D1, fiche D2 supprimee, ignoree), son job J1 et sa copie de travail; un cours C1 homonyme chez s3. */
async function seeded() {
  const t = await world();
  await putJob(t, 's1', 'J1', { state: 'termine', coursId: 'C1', docIds: ['D1', 'D2'] });
  await t.db.put({ PK: 'JOB#J1', SK: 'TEXT#1', text: 'COPIE-DE-TRAVAIL' });
  await putDoc(t, 's1', 'D1', { coursId: 'C1', sectionIndex: 0, sectionCount: 2 });
  await putDoc(t, 's1', 'DAUTRE', { sujet: 'sans cours' });
  const sentence = (p: number, n: number, text: string) => ({ id: `p${p}-s${n}`, text });
  await t.db.put({
    PK: 'STUDENT#s1',
    SK: 'COURS#C1',
    jobId: 'J1',
    pages: 2,
    createdAt: '2026-12-01T10:05:00.000Z',
    nbPhrases: 3,
    sections: [
      { fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Photosynthese', title: 'La photosynthese', ignore: false, docId: 'D1', statut: 'fiche' },
      { fromSentenceId: 'p2-s1', subject: 'histoire_geo', ignore: false, docId: 'D2', statut: 'fiche' },
      { fromSentenceId: 'p2-s2', subject: 'autre', ignore: true, statut: 'ignoree' },
    ],
  });
  await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1#T02', page: 2, sentences: [sentence(2, 1, 'Page deux.')] });
  await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1#T01', page: 1, sentences: [sentence(1, 1, 'Page un.')] });
  await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1x', jobId: 'Jx', pages: 1, createdAt: 'x', nbPhrases: 1, sections: [] }); // id voisin: jamais touche
  await t.db.put({ PK: 'STUDENT#s3', SK: 'COURS#C1', jobId: 'J3', pages: 1, createdAt: 'x', nbPhrases: 1, sections: [] });
  await t.db.put({ PK: 'STUDENT#s3', SK: 'COURS#C1#T01', page: 1, sentences: [sentence(1, 1, 'Texte du frere')] });
  await t.db.put({ PK: 'JOB#J3', SK: 'TEXT#1', text: 'COPIE-FRERE' });
  return t;
}

describe('GET /cours/{coursId} (B2)', () => {
  it('rend le texte par page (tri numerique), le decoupage et les liens: fiche supprimee => status supprimee sans docId', async () => {
    const t = await seeded();
    const r = body(await get(t, 's1', 'C1'));
    expect(r.texts.map((x: { page: number }) => x.page)).toEqual([1, 2]);
    expect(r.texts[0].sentences[0].text).toBe('Page un.');
    expect(r.sections.map((s: { status: string; docId?: string }) => [s.status, s.docId])).toEqual([['fiche', 'D1'], ['supprimee', undefined], ['ignoree', undefined]]);
    expect(r).toMatchObject({ coursId: 'C1', pages: 2, createdAt: '2026-12-01T10:05:00.000Z' });
  });
  it('le tri des pages est numerique (page 10 apres la page 2)', async () => {
    const t = await seeded();
    await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1#T10', page: 10, sentences: [] });
    expect((body(await get(t, 's1', 'C1')).texts as { page: number }[]).map((x) => x.page)).toEqual([1, 2, 10]);
  });
  it("parent: 403 (meme pour un cours inconnu); cours d'un frere, d'une autre famille, inconnu: 404 identiques", async () => {
    const t = await seeded();
    expect((await get(t, 'p1', 'C1')).statusCode).toBe(403);
    expect((await get(t, 'p1', 'inconnu')).statusCode).toBe(403);
    await t.db.put({ PK: 'STUDENT#s3', SK: 'COURS#C3', jobId: 'J3', pages: 1, createdAt: 'x', nbPhrases: 1, sections: [] });
    const a = await get(t, 's1', 'C3');
    const b = await get(t, 's9', 'C3');
    const c = await get(t, 's1', 'inconnu');
    expect([a.statusCode, b.statusCode, c.statusCode]).toEqual([404, 404, 404]);
    expect(a.body).toBe(c.body);
    // C1 existe chez s3 aussi: chacun lit SON cours, jamais le texte de l'autre
    expect(JSON.stringify(body(await get(t, 's3', 'C1')))).toContain('Texte du frere');
    expect(JSON.stringify(body(await get(t, 's1', 'C1')))).not.toContain('Texte du frere');
  });
});

describe('DELETE /cours/{coursId} (B2)', () => {
  it('parametre fiches obligatoire: absent ou inconnu = 400, rien supprime', async () => {
    const t = await seeded();
    expect((await del(t, 's1', 'C1')).statusCode).toBe(400);
    expect((await del(t, 's1', 'C1', 'tout')).statusCode).toBe(400);
    expect(await has(t, 'STUDENT#s1', 'COURS#C1')).toBe(true);
  });
  it('parent: 403 et rien supprime; cours du frere ou d\'une autre famille: 404 et intact', async () => {
    const t = await seeded();
    expect((await del(t, 'p1', 'C1', 'garder')).statusCode).toBe(403);
    expect((await del(t, 'p1', 'inconnu')).statusCode).toBe(403); // role avant parametre
    await t.db.put({ PK: 'STUDENT#s3', SK: 'COURS#C3', jobId: 'J3', pages: 1, createdAt: 'x', nbPhrases: 1, sections: [] });
    expect((await del(t, 's1', 'C3', 'supprimer')).statusCode).toBe(404);
    expect((await del(t, 's9', 'C3', 'supprimer')).statusCode).toBe(404);
    expect(await has(t, 'STUDENT#s1', 'COURS#C1')).toBe(true);
    expect(await has(t, 'STUDENT#s3', 'COURS#C3')).toBe(true);
    expect(await has(t, 'JOB#J3', 'TEXT#1')).toBe(true);
  });
  it('garder: les fiches restent sans coursId, sectionIndex ni sectionCount; le job perd coursId; texte et copie de travail supprimes', async () => {
    const t = await seeded();
    expect((await del(t, 's1', 'C1', 'garder')).statusCode).toBe(204);
    const d1 = await t.db.get({ PK: 'STUDENT#s1', SK: 'DOC#D1' });
    expect(d1).toBeDefined();
    for (const k of ['coursId', 'sectionIndex', 'sectionCount']) expect(d1![k], k).toBeUndefined();
    expect((await t.db.get({ PK: 'STUDENT#s1', SK: 'JOB#J1' }))?.coursId).toBeUndefined();
    expect(await has(t, 'STUDENT#s1', 'COURS#C1')).toBe(false);
    expect(await has(t, 'STUDENT#s1', 'COURS#C1#T01')).toBe(false);
    expect(await has(t, 'STUDENT#s1', 'COURS#C1#T02')).toBe(false);
    expect(await has(t, 'JOB#J1', 'TEXT#1')).toBe(false);
    // voisins intacts
    expect(await has(t, 'STUDENT#s1', 'COURS#C1x')).toBe(true);
    expect(await has(t, 'STUDENT#s1', 'DOC#DAUTRE')).toBe(true);
    expect(await has(t, 'STUDENT#s3', 'COURS#C1')).toBe(true);
    expect(await has(t, 'STUDENT#s3', 'COURS#C1#T01')).toBe(true);
    expect(await has(t, 'JOB#J3', 'TEXT#1')).toBe(true);
    expect((await del(t, 's1', 'C1', 'garder')).statusCode).toBe(404);
  });
  it("supprimer: les fiches du cours disparaissent avec leur arbre, pas celles d'ailleurs; signalements de ces fiches supprimes", async () => {
    const t = await seeded();
    await t.db.put({ PK: 'DOC#D1', SK: 'CLAIM#01', texte: 'x' });
    await t.db.put({ PK: 'FAMILY#f1', SK: 'REPORT#R1', docId: 'D1', commentaire: 'libre' });
    await t.db.put({ PK: 'FAMILY#f1', SK: 'REPORT#R2', docId: 'DAUTRE', commentaire: 'autre' });
    expect((await del(t, 's1', 'C1', 'supprimer')).statusCode).toBe(204);
    expect(await has(t, 'STUDENT#s1', 'DOC#D1')).toBe(false);
    expect(await has(t, 'DOC#D1', 'CLAIM#01')).toBe(false);
    expect(await has(t, 'FAMILY#f1', 'REPORT#R1')).toBe(false);
    expect(await has(t, 'FAMILY#f1', 'REPORT#R2')).toBe(true);
    expect(await has(t, 'STUDENT#s1', 'DOC#DAUTRE')).toBe(true);
    expect(await has(t, 'STUDENT#s1', 'COURS#C1')).toBe(false);
    expect(await has(t, 'JOB#J1', 'TEXT#1')).toBe(false);
  });
  it("interrompue avant la fin, elle se reprend par un second DELETE", async () => {
    const t = await seeded();
    const real = t.db.remove;
    t.db.remove = async () => { throw new Error('coupure'); };
    await expect(del(t, 's1', 'C1', 'garder')).rejects.toThrow('coupure');
    t.db.remove = real;
    expect(await has(t, 'STUDENT#s1', 'COURS#C1')).toBe(true); // l'en-tete reste: le second appel retrouve le cours
    expect((await del(t, 's1', 'C1', 'garder')).statusCode).toBe(204);
    expect(await has(t, 'STUDENT#s1', 'COURS#C1')).toBe(false);
    expect(await has(t, 'JOB#J1', 'TEXT#1')).toBe(false);
  });
});
