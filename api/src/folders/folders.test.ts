import { describe, expect, it } from 'vitest';
import { guarded } from '../pipeline/http.js';
import { body, ev, putDoc, putFolder, world } from '../scans/kit.js';
import { foldersApi } from './folders.js';

const run = async (t: Awaited<ReturnType<typeof world>>, who: Parameters<typeof ev>[0], route: string, o: Parameters<typeof ev>[2] = {}) => guarded(foldersApi)(t.ctx, ev(who, route, o));
const create = async (t: Awaited<ReturnType<typeof world>>, name: string, who: Parameters<typeof ev>[0] = 's1') => run(t, who, 'POST /folders', { body: { name } });
const dossierOf = async (t: Awaited<ReturnType<typeof world>>, sid: string, id: string) => (await t.db.get({ PK: `STUDENT#${sid}`, SK: `DOC#${id}` }))?.dossierId;

describe('folders-api (B2)', () => {
  it('cree, liste par nom, renomme; scanCount calcule a la lecture', async () => {
    const t = await world();
    const b = body(await create(t, '  Brevet   <blanc> '));
    expect(b).toMatchObject({ name: 'Brevet blanc', scanCount: 0 });
    const a = body(await create(t, 'Anglais'));
    await putDoc(t, 's1', 'D1', { dossierId: b.folderId });
    const list = body(await run(t, 's1', 'GET /folders'));
    expect(list.items.map((f: { name: string; scanCount: number }) => [f.name, f.scanCount])).toEqual([['Anglais', 0], ['Brevet blanc', 1]]);
    const r = await run(t, 's1', 'PATCH /folders/{folderId}', { params: { folderId: a.folderId }, body: { name: 'Anglais 2' } });
    expect(body(r).name).toBe('Anglais 2');
  });
  it('nom pris (casse et accents ignores): 409 dossier_nom_pris; renommer avec son propre nom est permis', async () => {
    const t = await world();
    const a = body(await create(t, 'Controle'));
    const dup = await create(t, 'CONTRÔLE');
    expect(dup.statusCode).toBe(409);
    expect(body(dup).code).toBe('dossier_nom_pris');
    const b = body(await create(t, 'Autre'));
    const clash = await run(t, 's1', 'PATCH /folders/{folderId}', { params: { folderId: b.folderId }, body: { name: 'controle' } });
    expect([clash.statusCode, body(clash).code]).toEqual([409, 'dossier_nom_pris']);
    expect((await run(t, 's1', 'PATCH /folders/{folderId}', { params: { folderId: a.folderId }, body: { name: 'CONTROLE' } })).statusCode).toBe(200);
    // un autre eleve peut prendre le meme nom
    expect((await create(t, 'Controle', 's3')).statusCode).toBe(201);
  });
  it('nom vide apres nettoyage: 400 requete_invalide; 51e dossier: 400 dossiers_limite', async () => {
    const t = await world();
    for (const name of ['   ', '<>']) {
      const r = await create(t, name);
      expect([r.statusCode, body(r).code]).toEqual([400, 'requete_invalide']);
    }
    for (let n = 0; n < 50; n++) expect((await create(t, `D${n}`)).statusCode).toBe(201);
    const r = await create(t, 'D50');
    expect([r.statusCode, body(r).code]).toEqual([400, 'dossiers_limite']);
  });
  it('parent: GET seulement (studentId obligatoire, famille verifiee); tout le reste 403 avant toute lecture', async () => {
    const t = await world();
    const f = await putFolder(t, 's1', 'F1', 'Brevet').then(() => 'F1');
    await putDoc(t, 's1', 'D1', { dossierId: f });
    expect(body(await run(t, 'p1', 'GET /folders', { query: { studentId: 's1' } })).items).toHaveLength(1);
    expect((await run(t, 'p1', 'GET /folders')).statusCode).toBe(400);
    expect((await run(t, 'p1', 'GET /folders', { query: { studentId: 's9' } })).statusCode).toBe(404);
    expect((await run(t, 'p2', 'GET /folders', { query: { studentId: 's1' } })).statusCode).toBe(404);
    const writes: [string, Parameters<typeof ev>[2]][] = [
      ['POST /folders', { body: { name: 'X' } }],
      ['PATCH /folders/{folderId}', { params: { folderId: f }, body: { name: 'X' } }],
      ['DELETE /folders/{folderId}', { params: { folderId: f } }],
      ['POST /folders/{folderId}/scans', { params: { folderId: f }, body: { docIds: ['D1'] } }],
      ['DELETE /folders/{folderId}/scans/{docId}', { params: { folderId: f, docId: 'D1' } }],
      // identifiants inconnus: 403 aussi (le role passe avant l'existence)
      ['DELETE /folders/{folderId}', { params: { folderId: 'inconnu' } }],
    ];
    for (const [route, o] of writes) expect((await run(t, 'p1', route, o)).statusCode, route).toBe(403);
    expect(await dossierOf(t, 's1', 'D1')).toBe(f);
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'FOLDER#F1' })).toBeDefined();
  });
  it("isolation: un dossier d'un frere ou d'une autre famille est introuvable (404) pour toutes les routes, et rien n'est modifie", async () => {
    const t = await world();
    await putFolder(t, 's3', 'F3', 'Frere');
    await putDoc(t, 's3', 'D3', { dossierId: 'F3' });
    await putDoc(t, 's1', 'D1');
    const routes: [string, Parameters<typeof ev>[2]][] = [
      ['PATCH /folders/{folderId}', { params: { folderId: 'F3' }, body: { name: 'Pris' } }],
      ['DELETE /folders/{folderId}', { params: { folderId: 'F3' } }],
      ['POST /folders/{folderId}/scans', { params: { folderId: 'F3' }, body: { docIds: ['D1'] } }],
      ['DELETE /folders/{folderId}/scans/{docId}', { params: { folderId: 'F3', docId: 'D3' } }],
    ];
    for (const who of ['s1', 's9'] as const) for (const [route, o] of routes) expect((await run(t, who, route, o)).statusCode, `${who} ${route}`).toBe(404);
    expect(await dossierOf(t, 's3', 'D3')).toBe('F3');
    expect(await dossierOf(t, 's1', 'D1')).toBeUndefined();
    expect((await t.db.get({ PK: 'STUDENT#s3', SK: 'FOLDER#F3' }))?.nom).toBe('Frere');
    expect(body(await run(t, 's1', 'GET /folders')).items).toEqual([]);
    expect((await run(t, 's1', 'GET /folders', { query: { studentId: 's3' } })).statusCode).toBe(404);
  });
  it("ajout: valide tout avant d'ecrire (docId inconnu ou d'un autre eleve = 404 pour l'ensemble), deplace une fiche rangee ailleurs", async () => {
    const t = await world();
    await putFolder(t, 's1', 'FA', 'A');
    await putFolder(t, 's1', 'FB', 'B');
    await putDoc(t, 's1', 'D1');
    await putDoc(t, 's1', 'D2', { dossierId: 'FA' });
    await putDoc(t, 's3', 'D3');
    for (const bad of ['D3', 'inconnu']) {
      const r = await run(t, 's1', 'POST /folders/{folderId}/scans', { params: { folderId: 'FB' }, body: { docIds: ['D1', bad] } });
      expect(r.statusCode).toBe(404);
      expect(await dossierOf(t, 's1', 'D1')).toBeUndefined(); // rien n'a ete ecrit
    }
    expect(await dossierOf(t, 's3', 'D3')).toBeUndefined();
    const ok = await run(t, 's1', 'POST /folders/{folderId}/scans', { params: { folderId: 'FB' }, body: { docIds: ['D1', 'D2'] } });
    expect(body(ok)).toMatchObject({ folderId: 'FB', scanCount: 2 });
    expect(await dossierOf(t, 's1', 'D2')).toBe('FB');
    expect((await run(t, 's1', 'POST /folders/{folderId}/scans', { params: { folderId: 'FB' }, body: { docIds: [] } })).statusCode).toBe(400);
  });
  it("retrait: 404 si la fiche n'est pas dans ce dossier; la fiche reste", async () => {
    const t = await world();
    await putFolder(t, 's1', 'FA', 'A');
    await putFolder(t, 's1', 'FB', 'B');
    await putDoc(t, 's1', 'D1', { dossierId: 'FA' });
    expect((await run(t, 's1', 'DELETE /folders/{folderId}/scans/{docId}', { params: { folderId: 'FB', docId: 'D1' } })).statusCode).toBe(404);
    expect(await dossierOf(t, 's1', 'D1')).toBe('FA');
    expect((await run(t, 's1', 'DELETE /folders/{folderId}/scans/{docId}', { params: { folderId: 'FA', docId: 'D1' } })).statusCode).toBe(204);
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'DOC#D1' })).toBeDefined();
    expect(await dossierOf(t, 's1', 'D1')).toBeUndefined();
  });
  it("suppression: les fiches sortent du dossier (jamais supprimees); interrompue, un second DELETE finit le travail", async () => {
    const t = await world();
    await putFolder(t, 's1', 'FA', 'A');
    await putFolder(t, 's1', 'FB', 'B');
    for (let n = 0; n < 60; n++) await putDoc(t, 's1', `D${n}`, { dossierId: 'FA' });
    await putDoc(t, 's1', 'AUTRE', { dossierId: 'FB' });
    await putDoc(t, 's3', 'D3', { dossierId: 'FA' }); // meme identifiant de dossier chez un frere: intact
    // Interruption: le port de suppression echoue apres que les fiches ont ete detachees.
    const realRemove = t.db.remove;
    t.db.remove = async () => { throw new Error('coupure'); };
    await expect(run(t, 's1', 'DELETE /folders/{folderId}', { params: { folderId: 'FA' } })).rejects.toThrow('coupure');
    t.db.remove = realRemove;
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'FOLDER#FA' })).toBeDefined(); // dossier a re-supprimer
    expect(await dossierOf(t, 's1', 'D0')).toBeUndefined(); // et aucune fiche rangee dans un dossier fantome
    expect((await run(t, 's1', 'DELETE /folders/{folderId}', { params: { folderId: 'FA' } })).statusCode).toBe(204);
    expect(await t.db.get({ PK: 'STUDENT#s1', SK: 'FOLDER#FA' })).toBeUndefined();
    expect((await t.db.query('STUDENT#s1', 'DOC#')).length).toBe(61);
    expect(await dossierOf(t, 's1', 'AUTRE')).toBe('FB');
    expect(await dossierOf(t, 's3', 'D3')).toBe('FA');
    expect((await run(t, 's1', 'DELETE /folders/{folderId}', { params: { folderId: 'FA' } })).statusCode).toBe(404);
  });
});
