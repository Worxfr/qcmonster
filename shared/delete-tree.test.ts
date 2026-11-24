import { describe, expect, it } from 'vitest';
import { keys } from './ddb/keys.js';
import { deleteDocTree, deleteFamilyTree, deleteStudentTree, memoryTreeDb } from './delete-tree.js';

const k = (PK: string, SK: string) => ({ PK, SK });
const seed = () => [
  keys.family('f1'), keys.student('f1', 's1'), keys.student('f1', 's2'),
  keys.quota('f1', '2026-12', 's1'), keys.quota('f1', '2026-12', 's2'), keys.quotaFamily('f1', '2026-12'),
  keys.week('f1', '2026-W49', 's1'), keys.report('f1', 'r1'),
  keys.job('s1', 'j1'), keys.text('j1', 1), keys.text('j1', 2),
  keys.doc('s1', 'd1'), keys.claim('d1', 1), keys.verdict('d1', 1), keys.qcm('d1', 1), keys.gap('d1', 1),
  keys.profile('s1'), keys.day('s1', '2026-12-01'), keys.attempt('s1', 'd1:qcm:01', '2026-12-01'), keys.transcriptions('s1', '2026-12-01'),
  keys.doc('s2', 'd2'), keys.claim('d2', 1), keys.profile('s2'),
  keys.passage('p1'), keys.cost('dev', '2026-12'),
];

describe('suppression en cascade', () => {
  it('deleteDocTree efface fiche, affirmations, verdicts, QCM et trous, rien d\'autre', async () => {
    const db = memoryTreeDb(seed());
    expect(await deleteDocTree(db, 's1', 'd1')).toBe(5);
    expect(db.keys()).toHaveLength(seed().length - 5);
    expect(db.keys().some((x) => x.PK === 'DOC#d2')).toBe(true);
  });
  it('deleteStudentTree efface tout l\'eleve s1 (compte avant/apres) et laisse s2, la famille et les elements communs', async () => {
    const db = memoryTreeDb(seed());
    const before = db.keys().length;
    const n = await deleteStudentTree(db, 'f1', 's1');
    expect(before - db.keys().length).toBe(n);
    const left = db.keys().map((x) => `${x.PK}|${x.SK}`).join('\n');
    expect(left).not.toMatch(/STUDENT#s1|DOC#d1|JOB#j1|#s1\b/);
    for (const keep of ['FAMILY#f1|META', 'FAMILY#f1|STUDENT#s2', 'STUDENT#s2|PROFILE', 'DOC#d2|CLAIM#01', 'FAMILY#f1|QUOTA#2026-12#FAMILY', 'PASSAGE#p1|META', 'COST#dev|MONTH#2026-12', 'FAMILY#f1|REPORT#r1']) expect(left).toContain(keep);
  });
  it('deleteFamilyTree efface tous les eleves puis la famille', async () => {
    const db = memoryTreeDb(seed());
    await deleteFamilyTree(db, 'f1');
    const left = db.keys().map((x) => x.PK);
    expect(left.sort()).toEqual(['COST#dev', 'PASSAGE#p1']);
  });
  it('est idempotent', async () => {
    const db = memoryTreeDb([k('FAMILY#f9', 'META')]);
    expect(await deleteFamilyTree(db, 'f9')).toBe(1);
    expect(await deleteFamilyTree(db, 'f9')).toBe(0);
  });
});
