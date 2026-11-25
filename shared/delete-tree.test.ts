import { BatchWriteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { keys } from './ddb/keys.js';
import { deleteDocTree, deleteFamilyTree, deleteStudentTree, dynamoTreeDb, memoryTreeDb } from './delete-tree.js';

const k = (PK: string, SK: string) => ({ PK, SK });
const seed = () => [
  keys.family('f1'), keys.student('f1', 's1'), keys.student('f1', 's2'),
  keys.quota('f1', '2026-12', 's1'), keys.quota('f1', '2026-12', 's2'), keys.quotaFamily('f1', '2026-12'),
  keys.week('f1', '2026-W49', 's1'), { ...keys.report('f1', 'r1'), studentId: 's1', docId: 'd1' }, { ...keys.report('f1', 'r0'), docId: 'd1' }, { ...keys.report('f1', 'r2'), studentId: 's2', docId: 'd2' },
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
    for (const keep of ['FAMILY#f1|META', 'FAMILY#f1|STUDENT#s2', 'STUDENT#s2|PROFILE', 'DOC#d2|CLAIM#01', 'FAMILY#f1|QUOTA#2026-12#FAMILY', 'PASSAGE#p1|META', 'COST#dev|MONTH#2026-12', 'FAMILY#f1|REPORT#r2']) expect(left).toContain(keep);
    expect(left).not.toMatch(/REPORT#r1|REPORT#r0/); // D3: les signalements de l'eleve partent avec lui (avec studentId, ou anciens via sa fiche)
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

describe('suppression: garde-fous', () => {
  it('deleteDocTree: la fiche d\'un autre eleve n\'est PAS supprimee (appartenance), renvoie 0', async () => {
    const db = memoryTreeDb(seed());
    expect(await deleteDocTree(db, 's2', 'd1')).toBe(0); // d1 appartient a s1
    expect(db.keys()).toHaveLength(seed().length);
    expect(await deleteDocTree(db, 's1', 'd-inexistant')).toBe(0);
  });
  it('deleteStudentTree: un eleve d\'une autre famille n\'est pas touche', async () => {
    const db = memoryTreeDb(seed());
    expect(await deleteStudentTree(db, 'f2', 's1')).toBe(0);
    expect(db.keys()).toHaveLength(seed().length);
  });
  it('identifiants invalides refuses (vide, #, trop long)', async () => {
    const db = memoryTreeDb(seed());
    for (const bad of ['', 'a#b', 'a b', 'x'.repeat(65), 'a/b']) {
      await expect(deleteDocTree(db, bad, 'd1')).rejects.toThrow(RangeError);
      await expect(deleteStudentTree(db, 'f1', bad)).rejects.toThrow(RangeError);
      await expect(deleteFamilyTree(db, bad)).rejects.toThrow(RangeError);
    }
    expect(db.keys()).toHaveLength(seed().length);
  });
  it('un type d\'element de famille inconnu qui finit par le sid n\'est pas supprime (prefixes explicites)', async () => {
    const db = memoryTreeDb([...seed(), k('FAMILY#f1', 'AUTRE#2026#s1')]);
    await deleteStudentTree(db, 'f1', 's1');
    expect(db.keys().some((x) => x.SK === 'AUTRE#2026#s1')).toBe(true);
  });
});

describe('dynamoTreeDb', () => {
  it('lit avec ConsistentRead et reessaie les elements non traites avec attente croissante', async () => {
    const calls: { cmd: string; consistent?: boolean }[] = [];
    const waits: number[] = [];
    let batches = 0;
    const client = {
      async send(cmd: unknown) {
        if (cmd instanceof QueryCommand) {
          calls.push({ cmd: 'query', consistent: cmd.input.ConsistentRead });
          return { Items: [{ PK: 'p', SK: 's' }] };
        }
        if (cmd instanceof BatchWriteCommand) {
          batches++;
          return batches < 3 ? { UnprocessedItems: cmd.input.RequestItems } : {};
        }
        throw new Error('commande inattendue');
      },
    } as unknown as DynamoDBDocumentClient;
    const db = dynamoTreeDb(client, 't', async (ms) => void waits.push(ms));
    expect(await db.list('p')).toEqual([{ PK: 'p', SK: 's' }]);
    expect(calls[0].consistent).toBe(true);
    await db.remove([{ PK: 'p', SK: 's' }]);
    expect(batches).toBe(3);
    expect(waits).toEqual([100, 200]);
  });
});
