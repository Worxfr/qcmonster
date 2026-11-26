// H1-B: archive d'export (zip, sans reponse de l'eleve ni texte de question, borne, limite horaire, isolation entre familles, suppression).
import { inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { newTestId, schoolYearOf } from '../../../shared/tests-history.js';
import { HttpError } from '../lib/http.js';
import { FID, SID, parentCtx, seed, testDeps, type TestEnv } from '../lib/testkit.js';
import { MAX_ARCHIVES_PER_HOUR, capByYears, createExportArchive } from './archive.js';
import { deleteFamily, exportFamily } from './family.js';
import { deleteStudent } from './students.js';

/** Lecteur de zip de test: parcourt le repertoire central et decompresse chaque fichier (verifie aussi la structure du zip). */
function unzip(buf: Buffer): Record<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(end + 10);
  let p = buf.readUInt32LE(end + 16);
  const out: Record<string, string> = {};
  for (let i = 0; i < n; i++) {
    expect(buf.readUInt32LE(p)).toBe(0x02014b50);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nameLen).toString('utf8');
    expect(buf.readUInt32LE(off)).toBe(0x04034b50);
    const start = off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28);
    const data = inflateRawSync(buf.subarray(start, start + csize));
    expect(data.length).toBe(buf.readUInt32LE(p + 24));
    out[name] = data.toString('utf8');
    p += 46 + nameLen;
  }
  return out;
}

const SECRET = 'REPONSE-SECRETE-ELEVE';
async function addTest(t: TestEnv, sid: string, iso: string, o: { docId?: string; correct?: number } = {}) {
  const ms = Date.parse(iso);
  const id = newTestId(ms);
  const startedAt = iso.replace('.000Z', 'Z');
  await t.store.commit([
    {
      item: {
        ...keys.test(sid, startedAt, id),
        docId: o.docId ?? 'doc1', titre: 'Titre', matiere: 'svt', mode: 'qcm', anneeScolaire: schoolYearOf(new Date(ms)), startedAt, endedAt: startedAt, total: 2, answered: 2, correct: o.correct ?? 1, firstTry: 1, xpGained: 5,
        items: [
          { q: 'doc1:qcm:01', r: 1, k: 'qcm', ok: true, n: 1, f: true, xp: 5, at: startedAt, c: SECRET },
          { q: 'doc1:qcm:02', r: 2, k: 'qcm', ok: false, n: 2, f: false, xp: 0, at: startedAt, c: SECRET },
        ],
      },
      when: 'any',
    },
  ]);
  return id;
}
const rejects = async (p: Promise<unknown>, status: number) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
};
const zips = (t: TestEnv) => [...t.archives.objects].filter(([k]) => k.endsWith('.zip'));
const bodyOf = (t: TestEnv) => zips(t)[0][1].body;

describe('archive: contenu', () => {
  it('zip lisible: export.json + un jsonl par eleve (toutes annees), sans reponse donnee, sans texte de question, lien de 10 minutes', async () => {
    const t = testDeps();
    await seed(t, { nQcm: 2 });
    await addTest(t, SID, '2026-12-01T10:00:00.000Z');
    await addTest(t, SID, '2027-09-02T10:00:00.000Z'); // autre annee scolaire
    const r = await createExportArchive(t.deps, parentCtx);
    expect(r).toMatchObject({ format: 'zip', students: 1, tests: 2, truncated: false });
    expect(r.expiresAt).toBe(new Date(t.clk.t + 600_000).toISOString());
    expect(r.url).toContain(`exports/${FID}/`);
    expect(r.sizeBytes).toBe(bodyOf(t).length);
    const files = unzip(bodyOf(t));
    expect(Object.keys(files).sort()).toEqual(['export.json', `tests/${SID}.jsonl`]);
    expect(JSON.parse(files['export.json']).familyId).toBe(FID);
    const lines = files[`tests/${SID}.jsonl`].trim().split('\n').map((l) => JSON.parse(l));
    expect(lines.map((l) => l.schoolYear)).toEqual(['2026-2027', '2027-2028']);
    expect(lines[0].questions).toEqual([
      { questionId: 'doc1:qcm:01', rank: 1, kind: 'qcm', correct: true, attempts: 1, firstTry: true, xpGained: 5, answeredAt: '2026-12-01T10:00:00Z' },
      { questionId: 'doc1:qcm:02', rank: 2, kind: 'qcm', correct: false, attempts: 2, firstTry: false, xpGained: 0, answeredAt: '2026-12-01T10:00:00Z' },
    ]);
    // Rien de l'eleve n'est lisible dans l'archive (ni dans export.json: testsCount seulement).
    for (const [name, text] of Object.entries(files)) expect(text, name).not.toContain(SECRET);
    for (const l of lines) for (const q of l.questions) expect(Object.keys(q)).not.toEqual(expect.arrayContaining(['choice']));
  });
  it('un passage expire (ttl) n\'est pas ecrit', async () => {
    const t = testDeps();
    await seed(t);
    const id = await addTest(t, SID, '2026-11-01T10:00:00.000Z');
    const it = (await t.store.query(`STUDENT#${SID}`, 'TEST#'))[0];
    await t.store.commit([{ item: { ...it, ttl: 1 }, when: 'any' }]);
    expect(id).toBeDefined();
    expect((await createExportArchive(t.deps, parentCtx)).tests).toBe(0);
    expect(unzip(bodyOf(t))[`tests/${SID}.jsonl`]).toBe('');
  });
});

describe('archive: famille du jeton seule', () => {
  it('ne contient rien d\'une autre famille', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await addTest(t, SID, '2026-12-01T10:00:00.000Z');
    await addTest(t, 'stu2', '2026-12-01T10:00:00.000Z', { docId: 'doc2' });
    const r = await createExportArchive(t.deps, parentCtx);
    expect(r.tests).toBe(1);
    const files = unzip(bodyOf(t));
    expect(Object.keys(files)).not.toContain('tests/stu2.jsonl');
    expect(JSON.stringify(files)).not.toContain('stu2');
    expect(zips(t)[0][0].startsWith(`exports/${FID}/`)).toBe(true);
  });
});

describe('archive: borne de 50 000 passages (ici 3)', () => {
  it('omet les annees scolaires les plus anciennes, entieres, et le dit', async () => {
    const t = testDeps();
    await seed(t);
    await addTest(t, SID, '2025-10-01T10:00:00.000Z');
    await addTest(t, SID, '2025-11-01T10:00:00.000Z');
    await addTest(t, SID, '2026-10-01T10:00:00.000Z');
    await addTest(t, SID, '2026-11-01T10:00:00.000Z');
    const r = await createExportArchive({ ...t.deps, maxTests: 3 }, parentCtx);
    expect(r).toMatchObject({ tests: 2, truncated: true });
    const years = unzip(bodyOf(t))[`tests/${SID}.jsonl`].trim().split('\n').map((l) => JSON.parse(l).schoolYear);
    expect(years).toEqual(['2026-2027', '2026-2027']);
  });
  it('si l\'annee la plus recente depasse seule la borne, garde ses passages les plus recents', () => {
    const mk = (d: string) => ({ testId: d, startedAt: d, schoolYear: '2026-2027' }) as never;
    const { kept, truncated } = capByYears(new Map([['a', [mk('2026-10-01'), mk('2026-11-01'), mk('2026-12-01')]]]), 2);
    expect(truncated).toBe(true);
    expect((kept.get('a') ?? []).map((x) => (x as { startedAt: string }).startedAt)).toEqual(['2026-11-01', '2026-12-01']);
  });
  it('sous la borne: rien d\'omis', async () => {
    const t = testDeps();
    await seed(t);
    await addTest(t, SID, '2025-10-01T10:00:00.000Z');
    expect((await createExportArchive(t.deps, parentCtx)).truncated).toBe(false);
  });
});

describe('archive: limite horaire par famille', () => {
  it('la 4e demande dans l\'heure est refusee (429), une autre famille n\'est pas touchee, et la limite se leve apres une heure', async () => {
    const t = testDeps();
    await seed(t);
    for (let i = 0; i < MAX_ARCHIVES_PER_HOUR; i++) {
      await createExportArchive(t.deps, parentCtx);
      t.clk.advance(1000);
    }
    await rejects(createExportArchive(t.deps, parentCtx), 429);
    expect(t.archives.objects.size).toBe(6); // 3 marqueurs + 3 zips; rien d'ecrit par la demande refusee
    await createExportArchive(t.deps, { ...parentCtx, familyId: 'fam2' }); // une autre famille a sa propre limite
    t.clk.advance(3_600_000);
    await createExportArchive(t.deps, parentCtx);
  });
});

describe('suppression de la famille', () => {
  it('efface aussi les archives sous exports/<familyId>/, pas celles d\'une autre famille', async () => {
    const t = testDeps();
    await seed(t);
    await createExportArchive(t.deps, parentCtx);
    await createExportArchive(t.deps, { ...parentCtx, familyId: 'fam2' });
    expect(t.archives.objects.size).toBe(4);
    await deleteFamily(t.deps, parentCtx);
    expect([...new Set([...t.archives.objects.keys()].map((k) => k.split('/')[1]))]).toEqual(['fam2']);
  });
});

describe('B1: le parent ne lit jamais le texte d\'une question ni la bonne reponse', () => {
  it('export.json de l\'archive: questions sans prompt, choix ni reponse (QCM# et GAP# semees); GET /family/export inchange', async () => {
    const t = testDeps();
    await seed(t, { nQcm: 2, nGap: 1 }); // enonces « Question n ? », choix A..D, phrase « Le ____ 1 », attendu « Énergie »
    await createExportArchive(t.deps, parentCtx);
    const raw = unzip(bodyOf(t))['export.json'];
    for (const secret of ['Question 1', 'Question 2', 'Le ____', 'Énergie', '"prompt"', '"choices"', '"answer"', '"choix"']) expect(raw, secret).not.toContain(secret);
    const doc = JSON.parse(raw).docs[0];
    expect(doc.questions).toEqual([
      { questionId: 'doc1:gap:01', kind: 'gap' },
      { questionId: 'doc1:qcm:01', kind: 'qcm' },
      { questionId: 'doc1:qcm:02', kind: 'qcm' },
    ]);
    // L'export JSON existant n'est pas modifie (point a trancher par le proprietaire, voir docs/H1B-report.md).
    const full = await exportFamily(t.deps, parentCtx);
    expect(full.docs[0].questions).toHaveLength(3);
    expect(JSON.stringify(full)).toContain('Question 1');
  });
});

describe('C3: suppression d\'un eleve', () => {
  it('efface aussi les archives deja faites de la famille (elles contiennent ses passages), pas celles d\'une autre famille', async () => {
    const t = testDeps();
    await seed(t);
    await createExportArchive(t.deps, parentCtx);
    await createExportArchive(t.deps, { ...parentCtx, familyId: 'fam2' });
    await deleteStudent(t.deps, parentCtx, SID);
    expect([...new Set([...t.archives.objects.keys()].map((k) => k.split('/')[1]))]).toEqual(['fam2']);
  });
});

describe('C4: marqueur ecrit avant la construction', () => {
  it('une construction qui echoue compte quand meme dans la limite horaire; le marqueur existe des le debut', async () => {
    const t = testDeps();
    await seed(t);
    const real = t.store.query;
    let seen: string[] = [];
    t.store.query = async () => {
      seen = [...t.archives.objects.keys()];
      throw new Error('panne simulee');
    };
    for (let i = 0; i < MAX_ARCHIVES_PER_HOUR; i++) await expect(createExportArchive(t.deps, parentCtx)).rejects.toThrow('panne simulee');
    expect(seen).toHaveLength(MAX_ARCHIVES_PER_HOUR); // vu depuis la lecture: marqueurs deja la
    expect([...t.archives.objects.keys()].every((k) => k.endsWith('.lock'))).toBe(true);
    t.store.query = real;
    await rejects(createExportArchive(t.deps, parentCtx), 429);
  });
});

