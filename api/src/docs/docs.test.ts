import { describe, expect, it } from 'vitest';
import { guarded } from '../pipeline/http.js';
import { body, ev, putDoc, world } from '../scans/kit.js';
import { docsDelete, docsPatch, docsRead } from './docs.js';

const patch = async (t: Awaited<ReturnType<typeof world>>, who: Parameters<typeof ev>[0], docId: string, b: unknown) => guarded(docsPatch)(t.ctx, ev(who, 'PATCH /docs/{docId}', { params: { docId }, body: b }));

describe('PATCH /docs/{docId} (B2)', () => {
  it('change la matiere et le sujet; null retire le sujet; sujet nettoye', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { sujet: 'Ancien' });
    const r = await patch(t, 's1', 'D1', { subject: 'histoire_geo', topic: '  La <b>Revolution</b>  ' });
    expect(r.statusCode).toBe(200);
    expect(body(r)).toMatchObject({ docId: 'D1', subject: 'histoire_geo', topic: 'La b Revolution /b' });
    const gone = await patch(t, 's1', 'D1', { topic: null });
    expect(body(gone).topic).toBeUndefined();
    expect((await t.db.get({ PK: 'STUDENT#s1', SK: 'DOC#D1' }))?.sujet).toBeUndefined();
    expect((await t.db.get({ PK: 'STUDENT#s1', SK: 'DOC#D1' }))?.matiere).toBe('histoire_geo');
  });
  it('{} , sujet vide apres nettoyage, matiere inconnue: 400', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { sujet: 'Garde' });
    for (const b of [{}, { topic: '<>' }, { topic: '   ' }, { topic: '\u200b' }, { subject: 'x' }, { topic: 5 }]) expect((await patch(t, 's1', 'D1', b)).statusCode, JSON.stringify(b)).toBe(400);
    expect((await t.db.get({ PK: 'STUDENT#s1', SK: 'DOC#D1' }))?.sujet).toBe('Garde');
  });
  it("parent: 403 avant toute recherche (meme pour une fiche inconnue); fiche d'un frere ou inconnue: 404 et rien n'est cree", async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1');
    await putDoc(t, 's3', 'D3', { sujet: 'Frere' });
    expect((await patch(t, 'p1', 'D1', { topic: 'X' })).statusCode).toBe(403);
    expect((await patch(t, 'p1', 'inconnu', { topic: 'X' })).statusCode).toBe(403);
    expect((await patch(t, 's1', 'D3', { topic: 'Pirate' })).statusCode).toBe(404);
    expect((await patch(t, 's9', 'D3', { topic: 'Pirate' })).statusCode).toBe(404);
    expect((await patch(t, 's1', 'inconnu', { topic: 'X' })).statusCode).toBe(404);
    expect((await t.db.get({ PK: 'STUDENT#s3', SK: 'DOC#D3' }))?.sujet).toBe('Frere');
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'DOC#inconnu' })).toBeUndefined(); // pas de fiche fantome
  });
});

describe('docs-read et docs-delete (B2)', () => {
  it('renvoie topic, folderId, coursId, sectionIndex seulement quand ils existent', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { sujet: 'Sujet', dossierId: 'F1', coursId: 'C1', sectionIndex: 1 });
    await putDoc(t, 's1', 'DOLD');
    const list = body(await guarded(docsRead)(t.ctx, ev('s1', 'GET /docs'))).items;
    expect(list.find((d: { docId: string }) => d.docId === 'D1')).toMatchObject({ topic: 'Sujet', folderId: 'F1', coursId: 'C1', sectionIndex: 1 });
    expect(Object.keys(list.find((d: { docId: string }) => d.docId === 'DOLD')).sort()).toEqual(['createdAt', 'docId', 'subject', 'title']);
    const one = body(await guarded(docsRead)(t.ctx, ev('s1', 'GET /docs/{docId}', { params: { docId: 'D1' } })));
    expect(one).toMatchObject({ docId: 'D1', topic: 'Sujet', coursId: 'C1' });
  });
  it('supprimer une fiche ne touche jamais au cours', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { coursId: 'C1', sectionIndex: 0, sectionCount: 1 });
    await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1', jobId: 'J1', pages: 1, createdAt: 'x', sections: [] });
    await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1#T01', page: 1, sentences: [{ id: 'p1-s1', text: 'Texte' }] });
    expect((await guarded(docsDelete)(t.ctx, ev('s1', 'DELETE /docs/{docId}', { params: { docId: 'D1' } }))).statusCode).toBe(204);
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'COURS#C1' })).toBeDefined();
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'COURS#C1#T01' })).toBeDefined();
  });
});

describe('sources: hotes autorises (audit L-14)', () => {
  it("docsRead ne rend que les sources https d'un hote de la liste", async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1');
    await t.db.put({ PK: 'DOC#D1', SK: 'CLAIM#01', texte: 'Une phrase.', aRisque: false });
    const src = (url: string) => ({ passageId: url, url, site: 's', titre: 't', extrait: 'e', niveau: 2 });
    const urls = ['https://fr.wikipedia.org/wiki/Paris', 'javascript:alert(1)', 'http://fr.wikipedia.org/wiki/X', 'https://evil.example.invalid/x', 'https://fr.wikipedia.org.evil.example.invalid/x', 'https://u:p@fr.wikipedia.org/x'];
    await t.db.put({ PK: 'DOC#D1', SK: 'VERDICT#01', statut: 'verifiee', niveau: 2, secondeLecture: false, sources: urls.map(src) });
    const r = await guarded(docsRead)(t.ctx, ev('s1', 'GET /docs/{docId}', { params: { docId: 'D1' } }));
    expect(body(r).claims[0].sources.map((s: { url: string }) => s.url)).toEqual(['https://fr.wikipedia.org/wiki/Paris']);
  });
});
