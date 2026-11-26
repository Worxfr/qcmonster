// Archive de l'eleve (R1 3.6): asynchrone, flux, 150 Mo, isolation. Aucun reseau: tout est en memoire.
import { crc32, inflateRawSync } from 'node:zlib';
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { figureKey } from '../pipeline/figures.js';
import { partSink, type PartUploader } from '../lib/multipart.js';
import { FID, SID, seed, studentCtx, testDeps, type TestEnv } from '../lib/testkit.js';
import { buildStudentExport, getExport, MAX_EXPORTS_PER_HOUR, requestExport, type FigureReader, type StudentExportDeps } from './student-export.js';

/** Lit un zip (entrees deflate ou stockees) sans dependance: assez pour verifier le contenu. */
function unzip(buf: Buffer): Map<string, Buffer> {
  const out = new Map<string, Buffer>();
  const eocd = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const n = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  for (let k = 0; k < n; k++) {
    const method = buf.readUInt16LE(p + 10);
    const crc = buf.readUInt32LE(p + 16);
    const csize = buf.readUInt32LE(p + 20);
    const nlen = buf.readUInt16LE(p + 28);
    const off = buf.readUInt32LE(p + 42);
    const name = buf.subarray(p + 46, p + 46 + nlen).toString('utf8');
    const data = buf.subarray(off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28), off + 30 + buf.readUInt16LE(off + 26) + buf.readUInt16LE(off + 28) + csize);
    const raw = method === 8 ? inflateRawSync(data) : data;
    expect(crc32(raw)).toBe(crc);
    out.set(name, Buffer.from(raw));
    p += 46 + nlen;
  }
  return out;
}

function env(maxFigureBytes?: number) {
  const t: TestEnv = testDeps();
  const objects = new Map<string, Buffer>(); // bucket des figures
  const gets: string[] = [];
  const figures: FigureReader = {
    async list(prefix) {
      return [...objects].filter(([k]) => k.startsWith(prefix)).map(([key, b]) => ({ key, size: b.length }));
    },
    async get(key) {
      gets.push(key);
      return objects.get(key);
    },
  };
  const written: Buffer[] = [];
  const parts: number[] = [];
  let aborted = false;
  const uploader: PartUploader = { async start() {}, async part(_n, b) { parts.push(b.length); written.push(Buffer.from(b)); }, async complete() {}, async abort() { aborted = true; } };
  const sinks: ReturnType<typeof partSink>[] = [];
  const launched: { sid: string; exportId: string }[] = [];
  const deps: StudentExportDeps = {
    ...t.deps,
    archives: t.archives,
    figures,
    openSink: () => {
      const s = partSink(uploader, 1024);
      sinks.push(s);
      return s;
    },
    launch: async (p) => void launched.push(p),
    ...(maxFigureBytes ? { maxFigureBytes } : {}),
  };
  return { t, deps, objects, gets, written, parts, sinks, launched, wasAborted: () => aborted };
}

async function seedCours(t: TestEnv, e: ReturnType<typeof env>, sid: string, coursId: string, createdAt: string, bytes: number, figs = ['f1']) {
  await t.store.commit([
    { item: { ...keys.cours(sid, coursId), jobId: coursId, pages: 1, createdAt, nbPhrases: 1, sections: [] }, when: 'any' },
    { item: { ...keys.coursText(sid, coursId, 1), page: 1, sentences: [{ id: 'p1-s1', text: `Texte ${coursId}` }] }, when: 'any' },
    { item: { ...keys.coursBlocks(sid, coursId), blocks: [], figures: figs.map((f) => ({ figureId: f, page: 1, kind: 'schema', alt: 'a' })) }, when: 'any' },
  ]);
  for (const f of figs) e.objects.set(figureKey(sid, coursId, f), Buffer.alloc(bytes, 7));
}

describe('demande et lecture', () => {
  it('POST: etat en_cours, construction lancee; GET du meme eleve seulement; 3 demandes par heure', async () => {
    const e = env();
    await seed(e.t);
    const r = await requestExport(e.deps, studentCtx);
    expect(r).toEqual({ exportId: 'id0001', state: 'en_cours' });
    expect(e.launched).toEqual([{ sid: SID, exportId: 'id0001' }]);
    expect(await getExport(e.deps, studentCtx, 'id0001')).toEqual({ exportId: 'id0001', state: 'en_cours' });
    // un autre eleve de la famille: introuvable
    await expect(getExport(e.deps, { ...studentCtx, studentId: 'autre' }, 'id0001')).rejects.toMatchObject({ status: 404 });
    await requestExport(e.deps, studentCtx);
    await requestExport(e.deps, studentCtx);
    await expect(requestExport(e.deps, studentCtx)).rejects.toMatchObject({ status: 429, code: 'quota_epuise' });
    expect(MAX_EXPORTS_PER_HOUR).toBe(3);
    e.t.clk.advance(3_700_000);
    await expect(requestExport(e.deps, studentCtx)).resolves.toMatchObject({ state: 'en_cours' });
  });
  it('lancement impossible: la demande passe en echec et l\'erreur remonte', async () => {
    const e = env();
    await seed(e.t);
    e.deps.launch = async () => {
      throw new Error('invoke');
    };
    await expect(requestExport(e.deps, studentCtx)).rejects.toThrow('invoke');
    expect((await e.t.store.get(keys.exportJob(SID, 'id0001')))!.state).toBe('echec');
  });
});

describe('construction en flux', () => {
  it('zip complet: texte, tests avec reponses, figures sans compression; lien re-signe a chaque lecture', async () => {
    const e = env();
    await seed(e.t, { nQcm: 1, nGap: 0 });
    await seedCours(e.t, e, SID, 'c1', '2026-11-01T00:00:00Z', 3000, ['f1', 'f2']);
    await e.t.store.commit([{ item: { ...keys.test(SID, '2026-12-01T10:00:00Z', 'T1'), docId: 'doc1', items: [{ q: 'doc1:qcm:01', choice: 'ma reponse' }] }, when: 'any' }]);
    const { exportId } = await requestExport(e.deps, studentCtx);
    await buildStudentExport(e.deps, { sid: SID, exportId });
    const files = unzip(Buffer.concat(e.written));
    expect([...files.keys()].sort()).toEqual(['export.json', 'figures/c1/f1.jpg', 'figures/c1/f2.jpg', `tests/${SID}.jsonl`]);
    const exp = JSON.parse(files.get('export.json')!.toString());
    expect(exp.cours[0].texts[0].sentences[0].text).toBe('Texte c1');
    expect(files.get(`tests/${SID}.jsonl`)!.toString()).toContain('ma reponse');
    expect(files.get('figures/c1/f1.jpg')!.length).toBe(3000);
    const st = await getExport(e.deps, studentCtx, exportId);
    expect(st.state).toBe('pret');
    expect(st.archive).toMatchObject({ courses: 1, figures: 2, tests: 1, truncated: false, omittedCourses: 0, format: 'zip' });
    expect(st.archive!.url).toContain(`exports/${SID}/${exportId}.zip`);
    expect(st.archive!.sizeBytes).toBe(Buffer.concat(e.written).length);
    // rejeu de la construction: sans effet
    const before = e.written.length;
    await buildStudentExport(e.deps, { sid: SID, exportId });
    expect(e.written.length).toBe(before);
  });

  it('memoire bornee: jamais plus d\'une partie et d\'un morceau en memoire, une figure lue a la fois', async () => {
    const e = env();
    await seed(e.t);
    await seedCours(e.t, e, SID, 'c1', '2026-11-01T00:00:00Z', 50_000, ['f1', 'f2', 'f3', 'f4']);
    const { exportId } = await requestExport(e.deps, studentCtx);
    await buildStudentExport(e.deps, { sid: SID, exportId });
    expect(e.parts.slice(0, -1).every((n) => n === 1024)).toBe(true);
    expect(e.sinks[0].maxHeld()).toBeLessThanOrEqual(1024 + 50_100); // une partie + le plus gros morceau
    expect(e.sinks[0].maxHeld()).toBeLessThan(4 * 50_000); // jamais les 4 images ensemble
    expect(e.gets).toHaveLength(4);
  });

  it('150 Mo: les cours les plus anciens perdent leurs images, le texte reste complet, truncated et omittedCourses le disent', async () => {
    const e = env(10_000); // borne reduite pour le test
    await seed(e.t);
    await seedCours(e.t, e, SID, 'vieux', '2026-01-01T00:00:00Z', 6000);
    await seedCours(e.t, e, SID, 'recent', '2026-11-01T00:00:00Z', 6000);
    const { exportId } = await requestExport(e.deps, studentCtx);
    await buildStudentExport(e.deps, { sid: SID, exportId });
    const files = unzip(Buffer.concat(e.written));
    expect([...files.keys()].filter((k) => k.startsWith('figures/'))).toEqual(['figures/recent/f1.jpg']);
    const exp = JSON.parse(files.get('export.json')!.toString());
    expect(exp.cours.map((c: { texts: unknown[] }) => c.texts.length)).toEqual([1, 1]); // texte complet des deux cours
    expect(exp.truncated).toBe(true);
    const st = await getExport(e.deps, studentCtx, exportId);
    expect(st.archive).toMatchObject({ truncated: true, omittedCourses: 1, figures: 1, courses: 2 });
  });

  it('isolation: les figures et cours d\'un autre eleve ne sont ni listes, ni lus, ni exportes', async () => {
    const e = env();
    await seed(e.t);
    await seed(e.t, { sid: 'autre', docId: 'docX' });
    await seedCours(e.t, e, SID, 'c1', '2026-11-01T00:00:00Z', 100);
    await seedCours(e.t, e, 'autre', 'cX', '2026-11-01T00:00:00Z', 100);
    // un cours de l'eleve qui nomme (a tort) une figure d'un autre: la cle est reconstruite avec le sid du jeton, donc introuvable
    await e.t.store.commit([{ item: { ...keys.coursBlocks(SID, 'c1'), blocks: [], figures: [{ figureId: 'f1', page: 1, kind: 'schema', alt: 'a' }, { figureId: '../../autre/cX/f1', page: 1, kind: 'schema', alt: 'a' }] }, when: 'any' }]);
    const { exportId } = await requestExport(e.deps, studentCtx);
    await buildStudentExport(e.deps, { sid: SID, exportId });
    expect(e.gets.every((k) => k.startsWith(`figures/${SID}/`))).toBe(true);
    const all = [...unzip(Buffer.concat(e.written)).entries()].map(([k, v]) => k + v.toString('latin1')).join('');
    expect(all).not.toContain('Texte cX');
    expect(FID).toBe('fam1');
  });

  it('echec: partie abandonnee, etat echec, l\'erreur remonte', async () => {
    const e = env();
    await seed(e.t);
    await seedCours(e.t, e, SID, 'c1', '2026-11-01T00:00:00Z', 100);
    e.deps.figures = { ...e.deps.figures, get: async () => { throw new Error('S3'); } };
    const { exportId } = await requestExport(e.deps, studentCtx);
    await expect(buildStudentExport(e.deps, { sid: SID, exportId })).rejects.toThrow('S3');
    expect(e.wasAborted()).toBe(true);
    expect((await getExport(e.deps, studentCtx, exportId)).state).toBe('echec');
  });
});
