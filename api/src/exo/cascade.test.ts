// E1: supprimer une fiche, un eleve ou une famille ne laisse ni exercice, ni progression, ni copie, ni passage, ni image (S3 d'abord).
import { describe, expect, it } from 'vitest';
import { deleteDocTree, deleteFamilyTree, deleteStudentTree } from '../../../shared/delete-tree.js';
import { keys } from '../../../shared/ddb/keys.js';
import { storeTreeDb } from '../lib/store.js';
import { SID, FID, seed, testDeps } from '../lib/testkit.js';

async function populated() {
  const t = testDeps();
  await seed(t, { matiere: 'maths' });
  const put = (item: Record<string, unknown> & { PK: string; SK: string }) => t.store.commit([{ item, when: 'any' }]);
  await put({ ...keys.exo('doc1', 1), titre: 'x' });
  await put({ ...keys.exop(SID, 'doc1', 1), etat: 'prete', docId: 'doc1' });
  await put({ ...keys.exop(SID, 'doc2', 1), etat: 'prete', docId: 'doc2' }); // autre fiche: reste
  await put({ ...keys.copie(SID, 'C1'), docId: 'doc1', pages: 2, etat: 'en_correction' });
  await put({ ...keys.copie(SID, 'C2'), docId: 'doc1', pages: 1, etat: 'corrigee' });
  await put({ ...keys.copie(SID, 'C3'), docId: 'doc2', pages: 1, etat: 'corrigee' });
  for (const n of [1, 2, 3]) await put({ ...keys.test(SID, `2026-12-01T10:0${n}:00Z`, `T${n}`), docId: 'doc1', mode: 'exercice', items: [] });
  return t;
}
const left = (t: Awaited<ReturnType<typeof populated>>) => [...t.store.items.keys()].filter((k) => /EXO|COPIE|TEST#/.test(k));

describe('E1: suppression en cascade', () => {
  it('fiche: exercice, progression, copies et 3 passages partent, S3 d\'abord par cles exactes; le reste de l\'eleve demeure', async () => {
    const t = await populated();
    const order: string[] = [];
    const tree = storeTreeDb(t.store);
    const remove = tree.remove;
    tree.remove = async (ks) => (order.push('dynamo'), remove(ks));
    await deleteDocTree(tree, SID, 'doc1', { deleteFiles: async (ks) => void order.push(`s3:${ks.join(',')}`) });
    expect(order[0]).toBe(`s3:copies/${SID}/C1/p1,copies/${SID}/C1/p2,copies/${SID}/C2/p1`);
    expect(order.indexOf('dynamo')).toBeGreaterThan(0);
    expect(left(t).sort()).toEqual([`STUDENT#${SID}|COPIE#C3`, `STUDENT#${SID}|EXOP#doc2:01`].sort());
  });
  it('suppression interrompue apres S3: reprise sans erreur', async () => {
    const t = await populated();
    const tree = storeTreeDb(t.store);
    await expect(deleteDocTree(tree, SID, 'doc1', { deleteFiles: async () => { throw new Error('coupure'); } })).rejects.toThrow();
    expect(left(t).length).toBeGreaterThan(4); // rien supprime en base: la fiche existe encore
    await deleteDocTree(tree, SID, 'doc1', { deleteFiles: async () => undefined });
    expect(left(t)).toHaveLength(2);
  });
  it('eleve puis famille: plus rien', async () => {
    const t = await populated();
    await deleteStudentTree(storeTreeDb(t.store), FID, SID);
    expect(left(t)).toEqual([]);
    const t2 = await populated();
    await deleteFamilyTree(storeTreeDb(t2.store), FID);
    expect(left(t2)).toEqual([]);
  });
});
