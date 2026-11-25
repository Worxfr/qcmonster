import { describe, expect, it } from 'vitest';
import { guarded } from '../pipeline/http.js';
import { body, ev, putDoc, putFolder, putJob, world } from './kit.js';
import { scansList } from './list.js';

const call = async (t: Awaited<ReturnType<typeof world>>, who: Parameters<typeof ev>[0], query: Record<string, string> = {}) => guarded(scansList)(t.ctx, ev(who, 'GET /scans', { query }));
const ids = (r: { body?: string }) => body(r).items.map((i: { scanId: string; docId?: string }) => i.docId ?? i.scanId);

async function seeded() {
  const t = await world();
  await putFolder(t, 's1', 'F1', 'Brevet');
  await putFolder(t, 's1', 'FVIDE', 'Vide');
  await putFolder(t, 's3', 'F3', 'Autre eleve');
  await putFolder(t, 's9', 'F9', 'Autre famille');
  await putDoc(t, 's1', 'D1', { sujet: 'La Revolution', dossierId: 'F1', pages: 2 });
  await putDoc(t, 's1', 'DOLD'); // fiche d'avant 1.3: ni sujet, ni dossier, ni pages
  await putDoc(t, 's3', 'D3', { titre: 'Fiche du frere' });
  await putDoc(t, 's9', 'D9', { titre: 'Fiche autre famille' });
  await putJob(t, 's1', 'J1'); // lecture en cours, sans matiere
  return t;
}

describe('GET /scans (B2)', () => {
  it("l'eleve ne voit que ses scans; scan a 1 page ancien et scan sans matiere compris", async () => {
    const t = await seeded();
    const r = await call(t, 's1');
    expect(r.statusCode).toBe(200);
    expect(new Set(ids(r))).toEqual(new Set(['D1', 'DOLD', 'J1']));
    const old = body(r).items.find((i: { docId?: string }) => i.docId === 'DOLD');
    expect(old).toMatchObject({ pages: 1, status: { stage: 'termine', pagesTotal: 1 } });
    expect(old.folderId).toBeUndefined();
    expect(ids(await call(t, 's1', { subject: 'none' }))).toEqual(['J1']);
  });
  it('ne renvoie ni resume ni empreinte', async () => {
    const t = await seeded();
    const raw = (await call(t, 's1')).body!;
    expect(raw).not.toContain('RESUME-SECRET');
    expect(raw).not.toContain('empreinte');
  });
  it('parent: les eleves de sa famille, jamais ceux d\'une autre famille', async () => {
    const t = await seeded();
    expect(new Set(ids(await call(t, 'p1')))).toEqual(new Set(['D1', 'DOLD', 'J1', 'D3']));
    expect(ids(await call(t, 'p1', { studentId: 's3' }))).toEqual(['D3']);
    expect((await call(t, 'p1', { studentId: 's9' })).statusCode).toBe(404);
    expect(ids(await call(t, 'p2'))).toEqual(['D9']);
  });
  it("un eleve qui passe l'identifiant d'un autre (frere, autre famille, inconnu): 404 identiques; le sien: 200", async () => {
    const t = await seeded();
    const r3 = await call(t, 's1', { studentId: 's3' });
    const r9 = await call(t, 's1', { studentId: 's9' });
    const rx = await call(t, 's1', { studentId: 'inconnu' });
    expect([r3.statusCode, r9.statusCode, rx.statusCode]).toEqual([404, 404, 404]);
    expect(r3.body).toBe(r9.body);
    expect(r9.body).toBe(rx.body);
    expect((await call(t, 's1', { studentId: 's1' })).statusCode).toBe(200);
  });
  it("dossier: d'un autre eleve ou d'une autre famille = 404, vide = liste vide, 'none' = hors dossier", async () => {
    const t = await seeded();
    expect((await call(t, 's1', { folderId: 'F3' })).statusCode).toBe(404);
    expect((await call(t, 's1', { folderId: 'F9' })).statusCode).toBe(404);
    expect((await call(t, 'p1', { folderId: 'F9' })).statusCode).toBe(404);
    const empty = await call(t, 's1', { folderId: 'FVIDE' });
    expect(empty.statusCode).toBe(200);
    expect(body(empty).items).toEqual([]);
    expect(ids(await call(t, 's1', { folderId: 'F1' }))).toEqual(['D1']);
    expect(new Set(ids(await call(t, 's1', { folderId: 'none' })))).toEqual(new Set(['DOLD', 'J1']));
  });
  it('parametres invalides et curseur invalide: 400', async () => {
    const t = await seeded();
    for (const q of <Record<string, string>[]>[{ limit: '0' }, { limit: '101' }, { limit: 'x' }, { sort: 'foo' }, { status: 'x' }, { subject: 'x' }, { order: 'x' }, { topic: '' }, { cursor: 'zzz' }]) {
      expect((await call(t, 's1', q)).statusCode, JSON.stringify(q)).toBe(400);
    }
  });
  it('plus de fiches que la limite: la pagination par curseur les rend toutes, une fois', async () => {
    const t = await world();
    for (let n = 0; n < 130; n++) await putDoc(t, 's1', `X${String(n).padStart(3, '0')}`, { createdAt: `2026-11-01T10:${String(n % 60).padStart(2, '0')}:${String(Math.floor(n / 60)).padStart(2, '0')}.000Z` });
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const r = await call(t, 's1', { limit: '50', ...(cursor ? { cursor } : {}) });
      seen.push(...ids(r));
      cursor = body(r).nextCursor;
    } while (cursor);
    expect(seen).toHaveLength(130);
    expect(new Set(seen).size).toBe(130);
  });
  it("l'heure du serveur decide de expiresSoon", async () => {
    const t = await world(); // now = 2026-12-01T10:00:00Z
    await putJob(t, 's1', 'JA', { state: 'a_confirmer', confirmExpiresAt: '2026-12-01T11:00:00.000Z' });
    await putJob(t, 's1', 'JB', { state: 'a_confirmer', confirmExpiresAt: '2026-12-01T20:00:00.000Z' });
    const items = body(await call(t, 's1', { status: 'a_confirmer' })).items;
    expect(items.find((i: { scanId: string }) => i.scanId === 'JA').status.expiresSoon).toBe(true);
    expect(items.find((i: { scanId: string }) => i.scanId === 'JB').status.expiresSoon).toBe(false);
  });
  it('compte sans famille ou eleve inconnu: 403', async () => {
    const t = await seeded();
    const e = ev('s1', 'GET /scans');
    (e.requestContext as unknown as { authorizer: { jwt: { claims: Record<string, string> } } }).authorizer.jwt.claims.sub = 'sub-inconnu';
    expect((await guarded(scansList)(t.ctx, e)).statusCode).toBe(403);
  });
});
