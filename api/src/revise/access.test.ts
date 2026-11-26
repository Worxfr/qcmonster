// M1 #90, docs/M1-design.md 7.3: « droits declares = droits reels ». Chaque handler, exerce sur ses chemins (heureux, conflit, echec, nettoyage, reprise) avec un enregistreur
// d'acces, ne touche QUE ce que shared/revise-access.ts declare. Un handler sans scenario fait echouer le test. L'autre sens (declare = accorde au role synthetise) est dans infra/test/m1-roles.test.ts.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { deleteStudentTree } from '../../../shared/delete-tree.js';
import { REVISE_HANDLERS } from '../../../shared/revise-access.js';
import { coursApi } from '../cours/cours.js';
import { docsDelete } from '../docs/docs.js';
import { allowedOf, spyCtx } from '../pipeline/access-spy.js';
import { scansCreate } from '../pipeline/api.js';
import { guarded } from '../pipeline/http.js';
import { treeDbFrom } from '../pipeline/ports.js';
import { event } from '../pipeline/testkit.js';
import { revCommit, revExtract, revFail, revGenerate, revPrepare } from './machine.js';
import { reviseCancel } from './cancel.js';
import { reviseCreate } from './create.js';
import { reviseGet } from './get.js';
import { bodyOf, correction, COURS, create, DOC, fakeVerify, setup } from './testkit.js';

type K = Awaited<ReturnType<typeof setup>>;
type Scenario = (k: K, spy: K['ctx']) => Promise<void>;
const ids = (revisionId: string) => ({ revisionId, sid: 's1', fid: 'f1', coursId: COURS });
const del = (ctx: K['ctx'], fiches: 'garder' | 'supprimer' = 'supprimer') => guarded(coursApi)(ctx, { ...event({ params: { coursId: COURS } }), routeKey: 'DELETE /cours/{coursId}', queryStringParameters: { fiches } });
const createWith = (spy: K['ctx'], body: unknown) => guarded(reviseCreate)(spy, event({ params: { coursId: COURS }, body }));

/** Une modification prete a etre validee: la copie est faite (`generate`), `rev-commit` n'a pas commence. */
async function generated(k: K) {
  const b = bodyOf(await create(k.ctx, correction));
  await revPrepare(k.ctx, ids(b.revisionId));
  const ex = await revExtract(k.ctx, { ...ids(b.revisionId), index: 0 });
  await fakeVerify(k.ctx, ex.docId);
  await revGenerate(k.ctx, { ...ids(b.revisionId), index: 0 });
  return b;
}

const SCENARIOS: Record<string, Scenario[]> = {
  'revise-create': [
    async (_k, spy) => void (await createWith(spy, correction)), // chemin heureux
    async (k, spy) => { await create(k.ctx, correction); await createWith(spy, correction); }, // verrou pris: 409
    async (_k, spy) => void (await createWith(spy, { removed: ['p1-s1'] })), // refus 400
    async (k, spy) => { await k.db.put({ ...keys.revMonth('s1', '2026-12'), coutMicros: 500_000 }); await createWith(spy, correction); }, // plafond
    async (_k, spy) => { const boom = { ...spy, sfn: { ...spy.sfn, start: async () => { throw new Error('panne'); } } }; await createWith(boom, correction).catch(() => undefined); }, // lancement impossible: annulation
    async (k, spy) => { await k.db.update(keys.cours('s1', COURS), { set: { appendJobId: 'ancien' } }); await createWith(spy, correction); }, // verrou d'un job expire: repris
  ],
  'revise-cancel': [
    async (k, spy) => {
      const b = bodyOf(await create(k.ctx, correction));
      await guarded(reviseCancel)(spy, event({ params: { coursId: COURS, revisionId: b.revisionId } }));
      await guarded(reviseCancel)(spy, event({ params: { coursId: COURS, revisionId: b.revisionId } }));
    },
  ],
  'revise-get': [async (k, spy) => { const b = bodyOf(await create(k.ctx, correction)); await guarded(reviseGet)(spy, event({ params: { coursId: COURS, revisionId: b.revisionId } })); }],
  'rev-prepare': [async (k, spy) => { const b = bodyOf(await create(k.ctx, correction)); await revPrepare(spy, ids(b.revisionId)); }],
  'rev-extract': [async (k, spy) => { const b = bodyOf(await create(k.ctx, correction)); await revPrepare(k.ctx, ids(b.revisionId)); await revExtract(spy, { ...ids(b.revisionId), index: 0 }); }],
  'rev-generate': [
    async (k, spy) => {
      const b = bodyOf(await create(k.ctx, correction));
      await revPrepare(k.ctx, ids(b.revisionId));
      const ex = await revExtract(k.ctx, { ...ids(b.revisionId), index: 0 });
      await fakeVerify(k.ctx, ex.docId);
      await revGenerate(spy, { ...ids(b.revisionId), index: 0 });
    },
  ],
  'rev-commit': [async (k, spy) => { const b = await generated(k); await revCommit(spy, ids(b.revisionId)); await revCommit(spy, ids(b.revisionId)); }], // et rejeu
  'rev-fail': [
    async (k, spy) => { const b = await generated(k); await revFail(spy, ids(b.revisionId)); }, // annulation: copie supprimee
    async (k, spy) => { const b = await generated(k); await revCommit(k.ctx, ids(b.revisionId)); await revFail(spy, ids(b.revisionId)); }, // apres une validation finie
    async (k, spy) => { // validation commencee puis interrompue: rejeu complet
      const b = await generated(k);
      await k.db.update(keys.job('s1', b.revisionId), { set: { commitStartedAt: 'x' } });
      await revFail(spy, ids(b.revisionId));
    },
  ],
  'cours-delete': [
    async (k, spy) => { await create(k.ctx, correction); await del(spy); }, // 409 sans ecriture
    async (k, spy) => { const b = await generated(k); await k.db.update(keys.job('s1', b.revisionId), { set: { state: 'echec', commitStartedAt: 'x' } }); await del(spy); }, // bloquee: nettoyage
    async (_k, spy) => void (await del(spy, 'garder')),
  ],
  'docs-delete': [async (k, spy) => { await create(k.ctx, correction); await guarded(docsDelete)(spy, event({ params: { docId: DOC } })); }],
  'scans-create': [async (k, spy) => { await create(k.ctx, correction); await guarded(scansCreate)(spy, event({ body: { pages: 1, contentType: 'image/jpeg', coursId: COURS } })); }],
  'students-delete': [async (k, spy) => { await generated(k); await deleteStudentTree(treeDbFrom(spy.db), 'f1', 's1'); }],
};

describe('M1 #90: droits declares = droits reels', () => {
  it('chaque handler declare a un scenario (on ne peut pas ajouter une fonction sans dire ce qu\'elle fait)', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(REVISE_HANDLERS).sort());
  });
  for (const [name, scenarios] of Object.entries(SCENARIOS)) {
    it(`${name}: ne touche que ce que shared/revise-access.ts declare`, async () => {
      const log = new Set<string>();
      for (const s of scenarios) {
        const k = await setup();
        await s(k, spyCtx(k.ctx, log));
      }
      const allowed = allowedOf(REVISE_HANDLERS[name].access);
      // Handlers existants (suppression, creation de scan): leurs droits S3 et Step Functions sont deja testes ailleurs; ici seul ce que M1 ajoute en base compte.
      const mine = ['reviseStart', 'revise', 'coursRead', 'pipeline'].includes(REVISE_HANDLERS[name].role);
      const undeclared = [...log].filter((x) => !allowed.has(x) && (mine || /^(get|query|write|batch) /.test(x)));
      expect(undeclared, `acces non declares pour ${name}: ${undeclared.join(', ')}`).toEqual([]);
      // jamais de S3 ni de figures: ces roles n'en ont pas
      if (mine) expect([...log].filter((x) => x.startsWith('s3.') || x.startsWith('figures.'))).toEqual([]);
    });
  }
  it('les scenarios exercent bien les chemins d\'echec et de nettoyage', async () => {
    const k = await setup();
    const log = new Set<string>();
    const b = await generated(k);
    await revFail(spyCtx(k.ctx, log), ids(b.revisionId));
    expect([...log]).toEqual(expect.arrayContaining(['batch DOC#', 'batch JOB#', 'update STUDENT#', 'update FAMILY#', 'put JOB#']));
  });
});
