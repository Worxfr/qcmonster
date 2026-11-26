import { BatchWriteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { keys } from './ddb/keys.js';
import { deleteCoursTree, deleteDocTree, deleteFamilyTree, deleteStudentTree, dynamoTreeDb, memoryTreeDb } from './delete-tree.js';

const k = (PK: string, SK: string) => ({ PK, SK });
const seed = () => [
  keys.family('f1'), keys.student('f1', 's1'), keys.student('f1', 's2'),
  { ...keys.name('f1', 'ana'), studentId: 's1' }, { ...keys.name('f1', 'bob'), studentId: 's2' }, // reservations de surnom (ID1)
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
    expect(left).not.toContain('NAME#ana'); // ID1: la reservation du nom part avec l'eleve, celle du frere reste
    expect(left).toContain('FAMILY#f1|NAME#bob');
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

describe('cours: blocs et figures (R1)', () => {
  const cours = () => [keys.cours('s1', 'c1'), keys.coursText('s1', 'c1', 1), keys.coursBlocks('s1', 'c1'), keys.cours('s1', 'c10'), keys.coursBlocks('s1', 'c10'), keys.jobBlocks('j1'), keys.text('j1', 1)];
  it('deleteCoursTree supprime COURS#<id>#B et JOB#<jobId>/BLOCKS (comptes avant/apres), pas le cours voisin c10', async () => {
    const db = memoryTreeDb(cours());
    expect(await deleteCoursTree(db, 's1', 'c1', { jobId: 'j1' })).toBe(5);
    expect(db.keys().map((x) => x.SK).sort()).toEqual(['COURS#c10', 'COURS#c10#B']);
  });
  it('un cours d\'un autre eleve n\'est pas touche', async () => {
    const db = memoryTreeDb(cours());
    expect(await deleteCoursTree(db, 's2', 'c1', { jobId: 'j1' })).toBe(0);
    expect(db.keys()).toHaveLength(7);
  });
  it('deleteStudentTree emporte aussi les blocs du cours et du job', async () => {
    const db = memoryTreeDb([keys.family('f1'), keys.student('f1', 's1'), keys.job('s1', 'j1'), ...cours()]);
    await deleteStudentTree(db, 'f1', 's1');
    expect(db.keys().map((x) => x.PK)).toEqual(['FAMILY#f1']);
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

describe('historique des tests (H1): les passages TEST# partent avec la fiche, l\'eleve et la famille', () => {
  const T = (sid: string, n: string, docId: string) => ({ ...keys.test(sid, `2026-12-0${n}T10:00:00Z`, `ID${n}`.padEnd(26, '0')), docId });
  const withTests = () => [...seed(), T('s1', '1', 'd1'), T('s1', '2', 'd1'), T('s1', '3', 'dX'), T('s2', '4', 'd2')];
  const tests = (db: ReturnType<typeof memoryTreeDb>, sid: string) => db.keys().filter((x) => x.PK === `STUDENT#${sid}` && x.SK.startsWith('TEST#')).map((x) => x.SK.slice(-26, -25));

  it('supprimer une fiche supprime ses passages seulement (ceux des autres fiches et des autres eleves restent)', async () => {
    const db = memoryTreeDb(withTests());
    expect(await deleteDocTree(db, 's1', 'd1')).toBe(7);
    expect(db.keys().filter((x) => x.SK.startsWith('TEST#')).map((x) => x.PK + x.SK.slice(5, 25))).toEqual(['STUDENT#s12026-12-03T10:00:00Z', 'STUDENT#s22026-12-04T10:00:00Z']);
  });
  it('une fiche qui n\'est pas a l\'eleve ne supprime rien, passages compris', async () => {
    const db = memoryTreeDb(withTests());
    expect(await deleteDocTree(db, 's2', 'd1')).toBe(0);
    expect(db.keys().filter((x) => x.SK.startsWith('TEST#'))).toHaveLength(4);
  });
  it('supprimer l\'eleve supprime tous ses passages, y compris ceux d\'une fiche deja supprimee', async () => {
    const db = memoryTreeDb(withTests());
    await deleteStudentTree(db, 'f1', 's1');
    expect(tests(db, 's1')).toEqual([]);
    expect(tests(db, 's2')).toHaveLength(1);
  });
  it('supprimer la famille supprime tous les passages de tous ses eleves', async () => {
    const db = memoryTreeDb(withTests());
    await deleteFamilyTree(db, 'f1');
    expect(db.keys().filter((x) => x.SK.startsWith('TEST#'))).toEqual([]);
  });
});

describe('Q1: effacement d\'un passage multi-fiches', () => {
  const line = (q: string, r: number, ok: boolean, xp = 5) => ({ q, r, k: 'qcm', ok, n: 1, f: ok, xp, at: 'x', c: 'B' });
  const multi = (extra: Record<string, unknown> = {}) => ({
    ...keys.test('s1', '2026-12-01T09:00:00Z', '01JTESTID0000000000000000A'),
    docId: 'd1', docIds: ['d1', 'd2', 'd3'], scope: 'fiches', titre: '3 fiches', mode: 'qcm', total: 6, answered: 6, correct: 4, firstTry: 4, xpGained: 20,
    items: [line('d1:qcm:01', 1, true), line('d2:qcm:01', 2, true), line('d3:qcm:01', 3, false, 0), line('d1:qcm:02', 4, true), line('d2:qcm:02', 5, false, 0), line('d3:qcm:02', 6, true)],
    ...extra,
  });
  const base = () => [keys.student('f1', 's1'), keys.doc('s1', 'd1'), keys.doc('s1', 'd2'), keys.doc('s1', 'd3'), keys.qcm('d1', 1), keys.qcm('d2', 1), keys.qcm('d3', 1), multi()];
  const test = (db: ReturnType<typeof memoryTreeDb>) => db.get(multi()) as Record<string, unknown> | undefined;

  it('supprimer la PREMIERE fiche: le passage reste avec 2 fiches, docId = la 2e, compteurs recalcules', async () => {
    const db = memoryTreeDb(base());
    await deleteDocTree(db, 's1', 'd1');
    expect(test(db)).toMatchObject({ docId: 'd2', docIds: ['d2', 'd3'], scope: 'fiches', titre: '2 fiches', total: 4, answered: 4, correct: 2, firstTry: 2, xpGained: 10 });
    expect((test(db)!.items as { q: string }[]).map((l) => l.q)).toEqual(['d2:qcm:01', 'd3:qcm:01', 'd2:qcm:02', 'd3:qcm:02']);
  });
  it('supprimer une AUTRE fiche: ses lignes partent, le passage reste', async () => {
    const db = memoryTreeDb(base());
    await deleteDocTree(db, 's1', 'd3');
    expect(test(db)).toMatchObject({ docId: 'd1', docIds: ['d1', 'd2'], total: 4, titre: '2 fiches' });
  });
  it('passage incomplet: total approche, jamais sous le nombre de lignes', async () => {
    const db = memoryTreeDb([...base().slice(0, -1), multi({ total: 10, answered: 6, items: (multi().items as unknown[]) })]);
    await deleteDocTree(db, 's1', 'd2');
    expect(test(db)).toMatchObject({ total: 8, answered: 4 });
  });
  it('la DERNIERE fiche restante efface le passage; une seule fiche restante: scope fiche', async () => {
    const db = memoryTreeDb(base());
    await deleteDocTree(db, 's1', 'd1');
    await deleteDocTree(db, 's1', 'd2');
    expect(test(db)).toMatchObject({ scope: 'fiche', docIds: ['d3'], docId: 'd3', titre: '1 fiche' });
    await deleteDocTree(db, 's1', 'd3');
    expect(test(db)).toBeUndefined();
  });
  it('m3: un passage de dossier qui n\'a plus qu\'une fiche devient un passage d\'une fiche et garde le nom du dossier', async () => {
    const db = memoryTreeDb([...base().slice(0, -1), multi({ scope: 'dossier', titre: 'Histoire', docIds: ['d1', 'd2'], items: [line('d1:qcm:01', 1, true), line('d2:qcm:01', 2, true)], total: 2, answered: 2 })]);
    await deleteDocTree(db, 's1', 'd1');
    expect(test(db)).toMatchObject({ scope: 'fiche', docIds: ['d2'], docId: 'd2', titre: 'Histoire', total: 1, answered: 1 });
  });
  it('m10 (M14): un passage a 2 fiches dont toutes les lignes viennent de la fiche supprimee disparait', async () => {
    const db = memoryTreeDb([...base().slice(0, -1), multi({ docIds: ['d1', 'd2'], titre: '2 fiches', items: [line('d1:qcm:01', 1, true), line('d1:qcm:02', 2, false, 0)], total: 4, answered: 2 })]);
    await deleteDocTree(db, 's1', 'd1');
    expect(test(db)).toBeUndefined();
  });
  it('passage d\'une seule fiche: supprime comme avant', async () => {
    const one = { ...keys.test('s1', '2026-12-02T09:00:00Z', '01JTESTID0000000000000000B'), docId: 'd1', items: [line('d1:qcm:01', 1, true)] };
    const db = memoryTreeDb([...base(), one]);
    await deleteDocTree(db, 's1', 'd1');
    expect(db.get(one)).toBeUndefined();
    expect(test(db)).toBeDefined();
  });
  it('reponse concurrente: la reecriture est refaite sur l\'element relu, la ligne ajoutee entre-temps n\'est pas perdue', async () => {
    let db: ReturnType<typeof memoryTreeDb>;
    let once = true;
    db = memoryTreeDb(base(), {
      beforeWrite: (key) => {
        if (!once) return;
        once = false;
        const cur = db.get(key) as Record<string, unknown> & { v: number };
        // une reponse arrive: nouvelle ligne et version suivante
        db = Object.assign(db, {});
        (cur.items as unknown[]).push(line('d2:qcm:03', 7, true));
        cur.v += 1;
      },
    });
    await deleteDocTree(db, 's1', 'd1');
    const items = test(db)!.items as { q: string }[];
    expect(items.map((l) => l.q)).toContain('d2:qcm:03');
    expect(items.some((l) => l.q.startsWith('d1:'))).toBe(false);
  });
  it('5 conflits de suite: erreur levee', async () => {
    const db = memoryTreeDb(base(), { beforeWrite: (key) => void ((db.get(key) as { v: number }).v += 1) });
    await expect(deleteDocTree(db, 's1', 'd1')).rejects.toThrow(/incomplete/);
  });
  it('deleteStudentTree et deleteFamilyTree: aucun TEST# ne reste, mutateTest jamais appele', async () => {
    const db = memoryTreeDb([keys.family('f1'), ...base()]);
    await deleteStudentTree(db, 'f1', 's1');
    expect(db.keys().filter((x) => x.SK.startsWith('TEST#'))).toEqual([]);
    expect(db.mutations).toBe(0);
    const db2 = memoryTreeDb([keys.family('f1'), ...base()]);
    await deleteFamilyTree(db2, 'f1');
    expect(db2.keys().filter((x) => x.SK.startsWith('TEST#'))).toEqual([]);
    expect(db2.mutations).toBe(0);
  });
});
