import { BatchWriteCommand, QueryCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { describe, expect, it } from 'vitest';
import { keys } from './ddb/keys.js';
import { deleteCoursTree, deleteDocTree, deleteFamilyTree, deleteSharesOf, deleteStudentTree, dynamoTreeDb, memoryTreeDb, type TreeDb, type TreeKey } from './delete-tree.js';

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

describe('cles de suppression (DynamoDB refuse une cle avec autre chose que PK et SK)', () => {
  it('fiche, cours et eleve portant pages/docId/docIds: aucune cle ne porte un autre attribut', async () => {
    const mk = () => memoryTreeDb([
      { ...keys.student('f1', 's1') }, { ...keys.family('f1') },
      { ...keys.doc('s1', 'd1'), pages: 4, docId: 'd1' }, keys.claim('d1', 1),
      { ...keys.cours('s1', 'c1'), pages: 4 }, keys.coursText('s1', 'c1', 1),
      { ...keys.job('s1', 'j1'), pages: 4, docIds: ['d1'] }, keys.text('j1', 1),
    ]);
    const a = mk();
    expect(await deleteDocTree(a, 's1', 'd1')).toBeGreaterThan(0);
    expect(a.keys().some((x) => x.SK === 'DOC#d1' || x.PK === 'DOC#d1')).toBe(false);
    const b = mk();
    expect(await deleteCoursTree(b, 's1', 'c1', { jobId: 'j1' })).toBe(3);
    const c = mk();
    expect(await deleteStudentTree(c, 'f1', 's1')).toBeGreaterThan(0);
    expect(c.keys().filter((x) => x.PK.startsWith('STUDENT#'))).toEqual([]);
  });
});

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

// S1 (#34, docs/S1-design.md section 8): les liens de partage partent avec la fiche, l'eleve ou la famille, la copie publique AVANT le reste, et seulement si l'option est passee.
describe('S1: deleteSharesOf et option deleteShares', () => {
  const H = (c: string) => c.repeat(64);
  const share = (c: string) => [k(`SHARE#${H(c)}`, 'META'), k(`SHARE#${H(c)}`, 'DAY#2026-12-01'), k(`SHARE#${H(c)}`, 'REPORT#r1')];
  const ref = (sid: string, n: number, docId: string, c: string, famSlot: number): TreeKey => ({ ...keys.shareRef(sid, n), docId, hash: H(c), famSlot });
  const slot = (n: number, sid: string): TreeKey => ({ ...keys.shareSlot('f1', n), sid });
  const seedS = (): TreeKey[] => [
    ...seed(), keys.doc('s1', 'd3'), keys.qcm('d3', 1),
    ref('s1', 1, 'd1', 'a', 1), ref('s1', 2, 'd1', 'b', 2), ref('s1', 3, 'd3', 'c', 3), slot(1, 's1'), slot(2, 's1'), slot(3, 's1'),
    ...share('a'), ...share('b'), ...share('c'),
    ref('s2', 1, 'd2', 'd', 4), slot(4, 's2'), ...share('d'), // le frere: jamais touche par les suppressions de s1
  ];
  const left = (db: { keys: () => { PK: string; SK: string }[] }) => db.keys().map((x) => `${x.PK}|${x.SK}`);
  const spy = (db: TreeDb & { keys: () => { PK: string; SK: string }[] }) => {
    const calls: string[] = [];
    return { calls, db: { ...db, list: async (pk: string, sk?: string) => (calls.push(`list ${pk} ${sk ?? ''}`), db.list(pk, sk)), remove: async (ks: { PK: string; SK: string }[]) => (calls.push(...ks.map((x) => `remove ${x.PK}`)), db.remove(ks)), keys: db.keys } };
  };

  it('fiche supprimee avec 2 liens: plus aucun SHARE# de ces liens, ni SHAREREF# ni SHARESLOT#; le lien d\'une autre fiche et le frere restent (comptes avant/apres)', async () => {
    const db = memoryTreeDb(seedS());
    const before = db.keys().length;
    const n = await deleteDocTree(db, 's1', 'd1', { deleteShares: { familyId: 'f1' } });
    expect(before - db.keys().length).toBe(n);
    const l = left(db).join('\n');
    expect(l).not.toMatch(new RegExp(`SHARE#(${H('a')}|${H('b')})|STUDENT#s1\\|SHAREREF#[12]\\b|SHARESLOT#[12]\\b|DOC#d1`));
    for (const keep of [`SHARE#${H('c')}|META`, 'STUDENT#s1|SHAREREF#3', 'FAMILY#f1|SHARESLOT#3', `SHARE#${H('d')}|META`, 'STUDENT#s2|SHAREREF#1', 'FAMILY#f1|SHARESLOT#4']) expect(l, keep).toContain(keep);
  });
  it('option ABSENTE (failJob, append): aucune lecture ni ecriture sur SHARE#, SHAREREF# ni SHARESLOT#, liens intacts', async () => {
    const mem = memoryTreeDb(seedS());
    const before = left(mem).filter((x) => /SHARE/.test(x)).sort();
    const { calls, db } = spy(mem);
    await deleteDocTree(db, 's1', 'd1');
    await deleteCoursTree(db, 's1', 'c9');
    await deleteStudentTree(db, 'f1', 's1');
    await deleteFamilyTree(db, 'f1');
    // deleteStudentTree et deleteFamilyTree sans option emportent STUDENT#s1 en bloc (SHAREREF# compris, comme tout element de la partition): ce qu'on exclut, c'est tout acces EXPLICITE aux partages
    expect(calls.filter((c) => /SHARE#|SHARESLOT|SHAREREF/.test(c)), 'acces aux partages sans option').toEqual([]);
    expect(before.length).toBeGreaterThan(0);
  });
  it('deleteDocTree seul, sans option: les liens de la fiche restent', async () => {
    const db = memoryTreeDb(seedS());
    await deleteDocTree(db, 's1', 'd1');
    expect(left(db)).toContain(`SHARE#${H('a')}|META`);
    expect(left(db)).toContain('STUDENT#s1|SHAREREF#1');
  });
  it('cours supprime avec garder: les fiches et leurs liens restent (deleteCoursTree ne touche jamais aux partages)', async () => {
    const db = memoryTreeDb([...seedS(), keys.cours('s1', 'c1')]);
    await deleteCoursTree(db, 's1', 'c1');
    expect(left(db).filter((x) => /SHARE/.test(x))).toHaveLength(left(memoryTreeDb(seedS())).filter((x) => /SHARE/.test(x)).length);
  });
  it('cours supprime avec supprimer: deleteDocTree est appele avec l\'option pour chaque fiche', async () => {
    const db = memoryTreeDb(seedS());
    for (const d of ['d1', 'd3']) await deleteDocTree(db, 's1', d, { deleteShares: { familyId: 'f1' } });
    expect(left(db).filter((x) => /SHARE#[0-9a-f]{64}\|/.test(x) && !x.includes(H('d')))).toEqual([]);
    expect(left(db).filter((x) => /SHAREREF|SHARESLOT/.test(x)).sort()).toEqual(['FAMILY#f1|SHARESLOT#4', 'STUDENT#s2|SHAREREF#1']);
  });
  it('eleve supprime: tous ses liens, copies comprises; le frere et ses liens restent', async () => {
    const db = memoryTreeDb(seedS());
    await deleteStudentTree(db, 'f1', 's1', { deleteShares: true });
    const l = left(db).join('\n');
    expect(l).not.toMatch(new RegExp(`SHARE#(${H('a')}|${H('b')}|${H('c')})|SHARESLOT#[123]\\b|STUDENT#s1`));
    expect(l).toContain(`SHARE#${H('d')}|REPORT#r1`);
    expect(l).toContain('FAMILY#f1|SHARESLOT#4');
  });
  it('famille supprimee: plus aucun SHARE# ni elements de la famille (copies de TOUS les eleves)', async () => {
    const db = memoryTreeDb(seedS());
    await deleteFamilyTree(db, 'f1', { deleteShares: true });
    expect(left(db).filter((x) => /SHARE/.test(x))).toEqual([]);
  });
  it('est idempotent et rejouable apres un echec au milieu: la reprise finit le travail, rien d\'orphelin', async () => {
    const mem = memoryTreeDb(seedS());
    let fail = true;
    const flaky: TreeDb = { ...mem, list: mem.list, mutateTest: mem.mutateTest, remove: async (ks) => { if (fail && ks.some((x) => x.PK.startsWith('STUDENT#'))) { fail = false; throw new Error('panne'); } return mem.remove(ks); } };
    await expect(deleteSharesOf(flaky, 'f1', 's1')).rejects.toThrow('panne'); // copies supprimees, references encore la
    expect(left(mem).filter((x) => /SHARE#[0-9a-f]{64}\|/.test(x) && !x.includes(H('d')))).toEqual([]);
    expect(left(mem)).toContain('STUDENT#s1|SHAREREF#1');
    expect(await deleteSharesOf(flaky, 'f1', 's1')).toBe(6); // 3 references + 3 emplacements
    expect(await deleteSharesOf(flaky, 'f1', 's1')).toBe(0);
  });
  it('ECHEC de la suppression d\'une copie: l\'erreur remonte, la fiche et ses references restent (aucune copie orpheline)', async () => {
    const mem = memoryTreeDb(seedS());
    const bad: TreeDb = { ...mem, list: mem.list, mutateTest: mem.mutateTest, remove: async (ks) => { if (ks.some((x) => x.PK.startsWith('SHARE#'))) throw new Error('panne copie'); return mem.remove(ks); } };
    const before = mem.keys().length;
    await expect(deleteDocTree(bad, 's1', 'd1', { deleteShares: { familyId: 'f1' } })).rejects.toThrow('panne copie');
    expect(mem.keys()).toHaveLength(before);
  });
  it('un jeton de hachage invalide dans une reference ne supprime pas d\'autre partition; la reference part quand meme', async () => {
    const mem = memoryTreeDb([...seedS(), { ...keys.shareRef('s1', 4), docId: 'd1', hash: 'FAMILY#f1', famSlot: 9 }]);
    await deleteSharesOf(mem, 'f1', 's1');
    expect(left(mem)).toContain('FAMILY#f1|META');
    expect(left(mem)).not.toContain('STUDENT#s1|SHAREREF#4');
  });
  it('emplacement libere puis reutilise par un frere: jamais supprime par la suppression de s1', async () => {
    const mem = memoryTreeDb([...seedS(), ref('s1', 4, 'd1', 'e', 4)]); // la reference de s1 pointe l\'emplacement 4, qui est maintenant a s2
    await deleteSharesOf(mem, 'f1', 's1', { docId: 'd1' });
    expect(left(mem)).toContain('FAMILY#f1|SHARESLOT#4');
  });
  it('identifiants invalides refuses', async () => {
    await expect(deleteSharesOf(memoryTreeDb([]), 'f1', 'a#b')).rejects.toThrow(RangeError);
    await expect(deleteSharesOf(memoryTreeDb([]), 'f1', 's1', { docId: '' })).rejects.toThrow(RangeError);
  });
  it('dynamoTreeDb: la projection porte `hash` par un alias (mot reserve) avec famSlot et sid', async () => {
    const sent: { input: Record<string, unknown> }[] = [];
    const client = { send: async (c: { input: Record<string, unknown> }) => (sent.push(c), { Items: [{ PK: 'STUDENT#s1', SK: 'SHAREREF#1', hash: H('a'), famSlot: 2, docId: 'd1' }] }) } as unknown as DynamoDBDocumentClient;
    const r = await dynamoTreeDb(client, 'T').list('STUDENT#s1', 'SHAREREF#');
    expect(r[0]).toMatchObject({ hash: H('a'), famSlot: 2 });
    expect(sent[0].input.ProjectionExpression).toMatch(/#h\b/);
    expect(sent[0].input.ExpressionAttributeNames).toEqual({ '#h': 'hash' });
  });
  it('S1 (#111 m2): closeSharing ecrit sharing:false par BatchWriteItem (PutRequest), seulement si le partage est ouvert', async () => {
    const sent: { name: string; input: Record<string, unknown> }[] = [];
    const item = { PK: 'FAMILY#f1', SK: 'STUDENT#s1', statut: 'actif', sharing: true, niveau: 'seconde' };
    const mk = (cur: unknown) => ({ send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => (sent.push({ name: c.constructor.name, input: c.input }), c.constructor.name === 'GetCommand' ? { Item: cur } : {}) }) as unknown as DynamoDBDocumentClient;
    await dynamoTreeDb(mk(item), 'T').closeSharing!({ PK: 'FAMILY#f1', SK: 'STUDENT#s1' });
    expect(sent.map((s) => s.name)).toEqual(['GetCommand', 'BatchWriteCommand']);
    expect(JSON.stringify(sent[1].input)).toContain('"PutRequest"');
    expect(JSON.stringify(sent[1].input)).toContain('"sharing":false');
    expect(JSON.stringify(sent[1].input)).toContain('"niveau":"seconde"'); // l'element est recopie, pas ecrase
    sent.length = 0;
    await dynamoTreeDb(mk({ ...item, sharing: false }), 'T').closeSharing!({ PK: 'FAMILY#f1', SK: 'STUDENT#s1' });
    await dynamoTreeDb(mk(undefined), 'T').closeSharing!({ PK: 'FAMILY#f1', SK: 'STUDENT#s1' });
    expect(sent.map((s) => s.name)).toEqual(['GetCommand', 'GetCommand']); // rien a ecrire
  });
  it('tous les ports reels de suppression implementent closeSharing', () => {
    expect(typeof dynamoTreeDb({} as DynamoDBDocumentClient, 'T').closeSharing).toBe('function');
    expect(typeof memoryTreeDb([]).closeSharing).toBe('function');
  });
});

describe('S1 (#111 m2): deleteStudentTree ferme le partage AVANT de supprimer les liens', () => {
  it("ordre: closeSharing, puis la liste des references; sans l'option, jamais d'appel", async () => {
    const mem = memoryTreeDb([keys.family('f1'), { ...keys.student('f1', 's1'), sharing: true } as never]);
    const log: string[] = [];
    const spy: TreeDb = { ...mem, mutateTest: mem.mutateTest, closeSharing: async (k) => (log.push('close'), mem.closeSharing!(k)), list: async (pk, p) => (log.push(`list ${pk} ${p ?? ''}`), mem.list(pk, p)), remove: async (ks) => (log.push('remove'), mem.remove(ks)) };
    await deleteStudentTree(spy, 'f1', 's1', { deleteShares: true });
    expect(log[0]).toBe('list FAMILY#f1 '); // controle d'appartenance
    expect(log[1]).toBe('close');
    expect(log.findIndex((l) => l === 'list STUDENT#s1 SHAREREF#')).toBeGreaterThan(1);
    log.length = 0;
    const mem2 = memoryTreeDb([keys.family('f1'), keys.student('f1', 's1')]);
    await deleteStudentTree({ ...mem2, mutateTest: mem2.mutateTest, closeSharing: async () => void log.push('close'), list: mem2.list, remove: mem2.remove }, 'f1', 's1');
    expect(log).toEqual([]);
  });
  it('une famille supprimee ferme le partage de chaque eleve', async () => {
    const mem = memoryTreeDb([keys.family('f1'), { ...keys.student('f1', 's1'), sharing: true } as never, { ...keys.student('f1', 's2'), sharing: true } as never]);
    const closed: string[] = [];
    await deleteFamilyTree({ ...mem, mutateTest: mem.mutateTest, closeSharing: async (k) => void closed.push(k.SK), list: mem.list, remove: mem.remove }, 'f1', { deleteShares: true });
    expect(closed.sort()).toEqual(['STUDENT#s1', 'STUDENT#s2']);
  });
  it("le port memoire pose sharing:false sur l'eleve", async () => {
    const mem = memoryTreeDb([keys.family('f1'), { ...keys.student('f1', 's1'), sharing: true } as never]);
    await mem.closeSharing!(keys.student('f1', 's1'));
    expect(mem.get(keys.student('f1', 's1'))).toMatchObject({ sharing: false });
  });
});
