// M1 #89: acces reels de jobs-confirm avec phrases ajoutees = acces declares dans shared/m1-access.ts (alimente le test d'infra m1-access).
import { describe, expect, it } from 'vitest';
import { JOBS_CONFIRM_ACCESS } from '../../../shared/m1-access.js';
import * as api from './api.js';
import { cropFigures } from './figures.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { awaitConfirm, awaitUpload, scanCheck, scanStart, transcribe } from './steps.js';
import { classifyJson, COURSE_LINES, event, goodScript, JPEG, makeCtx } from './testkit.js';

const jobsConfirm = guarded(api.jobsConfirm);
const scansCreate = guarded(api.scansCreate);
const part = (pk: unknown) => `${String(pk).split('#')[0]}#`;

/** Enregistre chaque appel d'un port: `<verbe> <partition>` pour la base, `<port>.<methode>` pour le reste. */
function spy<T extends object>(target: T, log: Set<string>, name: string): T {
  return new Proxy(target, {
    get(t, p) {
      const v = (t as Record<string | symbol, unknown>)[p];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        const m = String(p);
        if (name === 'db') {
          const verb = ({ get: 'get', query: 'query', queryGsi1: 'query', put: 'write', update: 'write', transact: 'write', remove: 'batch' } as Record<string, string>)[m];
          if (!verb) throw new Error(`methode de base non prevue: ${m}`);
          const a0 = a[0] as { PK?: string; key?: { PK: string }; put?: { PK: string } }[] | { PK: string } | string;
          const pks = m === 'transact' ? (a0 as { PK?: string; key?: { PK: string }; put?: { PK: string } }[]).map((o) => o.key?.PK ?? o.put?.PK ?? o.PK) : m === 'remove' ? (a0 as { PK: string }[]).map((k) => k.PK) : [typeof a0 === 'string' ? a0 : (a0 as { PK: string }).PK];
          for (const pk of pks) log.add(`${verb} ${part(pk)}`);
        } else log.add(`${name}.${m}`);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}

describe('M1 #89: acces declares = acces reels', () => {
  it('jobs-confirm avec phrases ajoutees, section ajoutee et figure gardee ne touche que shared/m1-access.ts', async () => {
    const k = await makeCtx(goodScript({ transcription: (pages) => JSON.stringify({ pages: pages.map((page) => ({ page, suite: false, md: `# Titre\n\n${COURSE_LINES.join('\n')}\n\n[[f1]]`, figures: [{ id: 'f1', box: [0.1, 0.4, 0.8, 0.35], kind: 'schema', alt: 'Schema', caption: 'Fig' }] })) }), classify: classifyJson() }));
    const r = await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }));
    const i = { jobId: JSON.parse(r.body ?? '{}').jobId as string, sid: 's1' };
    const key = `${scansPrefix('s1', i.jobId)}0`;
    k.s3.objects.set(key, JPEG);
    await scanStart(k.ctx, { detail: { object: { key } } });
    await awaitUpload(k.ctx, { ...i, token: 'tok-up' });
    await scanCheck(k.ctx, i);
    await transcribe(k.ctx, i);
    await cropFigures(k.ctx, i);
    await awaitConfirm(k.ctx, { ...i, token: 'tok-conf' });

    const log = new Set<string>();
    const ctx = { ...k.ctx, db: spy(k.ctx.db, log, 'db'), s3: spy(k.ctx.s3, log, 's3'), figures: spy(k.ctx.figures, log, 'figures'), sfn: spy(k.ctx.sfn, log, 'sfn') };
    const res = await jobsConfirm(ctx, event({ params: { jobId: i.jobId }, body: { corrections: [], figures: [{ figureId: 'f1', keep: true }], added: [{ key: 'n1', afterId: 'p1-s3', text: 'Une phrase oubliee par l eleve.' }, { key: 'n2', afterId: null, text: 'Une autre phrase oubliee.' }] } }));
    expect(res.statusCode).toBe(200);

    const A = JOBS_CONFIRM_ACCESS;
    const allowed = new Set([...A.get.map((p) => `get ${p}`), ...A.query.map((p) => `query ${p}`), ...A.write.map((p) => `write ${p}`), ...A.batch.map((p) => `batch ${p}`), ...A.scans.map((m) => `s3.${{ get: 'getBytes', list: 'list', delete: 'deleteAll' }[m]}`), ...A.figures.map((m) => `figures.${{ put: 'copyFromScans', list: 'list', delete: 'deleteAll' }[m]}`), ...A.sfn.map((m) => `sfn.${m === 'SendTaskSuccess' ? 'taskSuccess' : 'taskFailure'}`)]);
    const undeclared = [...log].filter((x) => !allowed.has(x));
    expect(undeclared, `acces non declares dans shared/m1-access.ts: ${undeclared.join(', ')}`).toEqual([]);
    // Les ajouts n'ont ajoute AUCUN acces: la liste observee contient bien les ecritures du cours et de la copie de travail.
    expect([...log]).toEqual(expect.arrayContaining(['get JOB#', 'query JOB#', 'write STUDENT#', 'write JOB#', 'figures.copyFromScans', 'sfn.taskSuccess']));
  });
});
