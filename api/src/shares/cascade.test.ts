// S1-A (#34), obligation 1: les quatre suppresseurs passent l'option `deleteShares` et la copie publique disparait AVEC la fiche, le cours, l'eleve ou la famille.
import { describe, expect, it } from 'vitest';
import { coursApi } from '../cours/cours.js';
import { docsDelete } from '../docs/docs.js';
import { deleteFamily } from '../family/family.js';
import { deleteStudent } from '../family/students.js';
import { guarded } from '../pipeline/http.js';
import { ev, putDoc, world } from '../scans/kit.js';
import { parentCtx } from '../lib/testkit.js';
import { seed as famSeed, testDeps } from '../lib/testkit.js';
import { plantedShare } from './testkit.js';

const shareKeys = (items: Iterable<{ PK: string; SK: string }>) => [...items].filter((i) => /^SHARE#|SHAREREF#|SHARESLOT#/.test(`${i.PK}|${i.SK}`)).map((i) => `${i.PK.slice(0, 8)}|${i.SK}`).sort();
const plant = async (put: (i: { PK: string; SK: string }) => Promise<unknown>, fid: string, sid: string, doc: string, k: number, c: string) => {
  for (const i of plantedShare(fid, sid, doc, k, c)) await put(i);
};

describe('docs-delete', () => {
  it('supprime les liens de LA fiche (copie, reference, emplacement) et garde ceux d\'une autre fiche', async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1');
    await putDoc(t, 's1', 'D2');
    await plant((i) => t.db.put(i), 'f1', 's1', 'D1', 1, 'a');
    await plant((i) => t.db.put(i), 'f1', 's1', 'D1', 2, 'b');
    await plant((i) => t.db.put(i), 'f1', 's1', 'D2', 3, 'c');
    expect(shareKeys(t.db.items.values())).toHaveLength(15);
    expect((await guarded(docsDelete)(t.ctx, ev('s1', 'DELETE /docs/{docId}', { params: { docId: 'D1' } }))).statusCode).toBe(204);
    const left = shareKeys(t.db.items.values());
    expect(left).toHaveLength(5); // seul le lien de D2 reste: META, DAY#, REPORT#, SHAREREF#3, SHARESLOT#3
    expect(left.join()).not.toMatch(/SHAREREF#[12]|SHARESLOT#[12]/);
    expect([...t.db.items.keys()].some((k) => k.startsWith(`SHARE#${'a'.repeat(64)}`) || k.startsWith(`SHARE#${'b'.repeat(64)}`))).toBe(false);
  });
  it('une fiche inconnue (404) ne supprime aucun lien', async () => {
    const t = await world();
    await plant((i) => t.db.put(i), 'f1', 's1', 'D1', 1, 'a');
    expect((await guarded(docsDelete)(t.ctx, ev('s1', 'DELETE /docs/{docId}', { params: { docId: 'D1' } }))).statusCode).toBe(404);
    expect(shareKeys(t.db.items.values())).toHaveLength(5);
  });
});

describe('cours-delete', () => {
  const setup = async () => {
    const t = await world();
    await putDoc(t, 's1', 'D1', { coursId: 'C1', sectionIndex: 0, sectionCount: 1 });
    await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#C1', jobId: 'J1', pages: 1, createdAt: 'x', sections: [{ docId: 'D1' }] });
    await plant((i) => t.db.put(i), 'f1', 's1', 'D1', 1, 'a');
    return t;
  };
  const del = (t: Awaited<ReturnType<typeof world>>, fiches: string) => guarded(coursApi)(t.ctx, { ...ev('s1', 'DELETE /cours/{coursId}', { params: { coursId: 'C1' } }), queryStringParameters: { fiches } });
  it('fiches=supprimer: les liens des fiches partent', async () => {
    const t = await setup();
    expect((await del(t, 'supprimer')).statusCode).toBe(204);
    expect(shareKeys(t.db.items.values())).toEqual([]);
  });
  it('fiches=garder: aucun effet sur les liens', async () => {
    const t = await setup();
    expect((await del(t, 'garder')).statusCode).toBe(204);
    expect(shareKeys(t.db.items.values())).toHaveLength(5);
  });
});

describe('students-delete et family-admin', () => {
  it('supprimer un eleve supprime ses copies publiques, pas celles d\'un frere', async () => {
    const t = testDeps();
    const { sid } = await famSeed(t);
    await t.store.commit([{ item: { PK: 'FAMILY#fam1', SK: 'STUDENT#stu2', statut: 'actif', cognitoSub: 'x', pseudo: 'P2' }, when: 'any' }]);
    await plant((i) => t.store.commit([{ item: i, when: 'any' }]), 'fam1', sid, 'doc1', 1, 'a');
    await plant((i) => t.store.commit([{ item: i, when: 'any' }]), 'fam1', 'stu2', 'docX', 2, 'b');
    await deleteStudent(t.deps, parentCtx, sid);
    const left = shareKeys(t.store.items.values());
    expect(left).toHaveLength(5);
    expect(left.join()).toMatch(/SHAREREF#2/);
    expect(left.join()).not.toMatch(/SHAREREF#1/);
  });
  it("supprimer un eleve ferme son partage AVANT de supprimer ses liens (#111 m2)", async () => {
    const t = testDeps();
    const { sid } = await famSeed(t);
    await t.store.commit([{ item: { ...(await t.store.get({ PK: 'FAMILY#fam1', SK: `STUDENT#${sid}` }))!, sharing: true }, when: 'any' }]);
    await plant((i) => t.store.commit([{ item: i, when: 'any' }]), 'fam1', sid, 'doc1', 1, 'a');
    const log: string[] = [];
    const tree = t.deps.tree;
    t.deps.tree = { ...tree, mutateTest: tree.mutateTest, closeSharing: async (k) => (log.push('close'), tree.closeSharing!(k)), list: async (pk, p) => (log.push(`list ${pk} ${p ?? ''}`), tree.list(pk, p)), remove: async (ks) => (log.push('remove'), tree.remove(ks)) };
    await deleteStudent(t.deps, parentCtx, sid);
    expect(log.indexOf('close')).toBeGreaterThanOrEqual(0);
    expect(log.indexOf('close')).toBeLessThan(log.indexOf('list STUDENT#stu1 SHAREREF#'));
    expect(log.indexOf('close')).toBeLessThan(log.indexOf('remove'));
  });
  it('supprimer la famille supprime toutes les copies', async () => {
    const t = testDeps();
    const { sid } = await famSeed(t);
    await plant((i) => t.store.commit([{ item: i, when: 'any' }]), 'fam1', sid, 'doc1', 1, 'a');
    await deleteFamily(t.deps, parentCtx);
    expect(shareKeys(t.store.items.values())).toEqual([]);
  });
});
