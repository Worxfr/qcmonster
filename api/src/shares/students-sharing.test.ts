// S1-A (#34): `PATCH /students/{sid}` avec `sharing` ne pose que le DRAPEAU, sur l'element eleve (role `manage`: ni STUDENT#*, ni SHARE#*, ni BatchWriteItem).
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { updateStudent } from '../family/students.js';
import { FID, parentCtx, seed, SID, testDeps } from '../lib/testkit.js';

describe('students-update: champ sharing', () => {
  it("pose le drapeau, le rend dans la vue, et n'ecrit RIEN d'autre (ni lien, ni Cognito)", async () => {
    const t = testDeps();
    await seed(t);
    t.identity.users.clear();
    const before = new Map([...t.store.items].map(([k, v]) => [k, JSON.stringify(v)]));
    const on = await updateStudent(t.deps, parentCtx, SID, { sharing: true });
    expect(on.sharing).toBe(true);
    expect(await t.store.get(keys.student(FID, SID))).toMatchObject({ sharing: true });
    const changed = [...t.store.items].filter(([k, v]) => before.get(k) !== JSON.stringify(v)).map(([k]) => k);
    expect(changed).toEqual([`FAMILY#${FID}|STUDENT#${SID}`]);
    const off = await updateStudent(t.deps, parentCtx, SID, { sharing: false });
    expect(off.sharing).toBeUndefined();
    expect(await t.store.get(keys.student(FID, SID))).toMatchObject({ sharing: false });
    expect(t.identity.users.size).toBe(0);
  });
  it('couper le partage ne supprime AUCUN lien (voie dediee: DELETE /students/{sid}/shares)', async () => {
    const t = testDeps();
    await seed(t);
    await t.store.commit([{ item: { ...keys.shareRef(SID, 1), shareId: 's', hash: 'a'.repeat(64), docId: 'doc1', title: 'Titre', count: 5, createdAt: 'x', expiresAt: '2027-01-01T00:00:00.000Z', famSlot: 1, ttl: 1 }, when: 'any' }]);
    await updateStudent(t.deps, parentCtx, SID, { sharing: false });
    expect(await t.store.get(keys.shareRef(SID, 1))).toBeDefined();
  });
});
