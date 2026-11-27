// S1-A (#34), obligation 2: « droits declares = droits reels ». Chaque handler, exerce sur ses chemins (heureux, refus, plafond, echec au milieu, nettoyage, rejeu) avec un
// enregistreur d'acces, ne touche QUE ce que shared/share-access.ts declare. Un handler sans scenario fait echouer le test. L'autre sens (declare = accorde au role synthetise,
// et le role de CHAQUE fonction deployee possede tout ce qu'elle declare) est dans infra/test/s1-handlers.test.ts.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { SHARE_HANDLERS } from '../../../shared/share-access.js';
import { createShare } from './create.js';
import { deleteForParent, deleteMine, listForParent, listMine } from './manage.js';
import { openShare, reportShare } from './public.js';
import { shareable } from './shareable.js';
import { allowedOf, spyShareCtx } from './access-spy.js';
import { body, DOC, make, otherFamilyParent, otherStudent, parent, student, strangerStudent, type Kit } from './testkit.js';

type Setup = Awaited<ReturnType<typeof make>>;
type Scenario = (s: Setup, spy: Kit['ctx']) => Promise<unknown>;
const q5 = (s: Setup) => s.paidIds.slice(0, 5);
const swallow = (p: Promise<unknown>) => p.then(() => undefined, () => undefined);
/** Un lien existant, cree SANS enregistreur. */
const existing = (s: Setup) => createShare(s.k.ctx, student, body(q5(s)) as never);

const SCENARIOS: Record<string, Scenario[]> = {
  'shares-shareable': [
    (s, c) => shareable(c, student, DOC),
    (s, c) => swallow(shareable(c, strangerStudent, DOC)),
    (s, c) => swallow(shareable({ ...c, publicEnabled: false }, student, DOC)),
  ],
  'shares-create': [
    (s, c) => createShare(c, student, body(q5(s)) as never), // heureux
    (s, c) => swallow(createShare(c, student, body(q5(s), { title: 'a@b.fr' }) as never)), // titre refuse
    (s, c) => swallow(createShare(c, student, body([...q5(s).slice(1), 'doc1:qcm:11']) as never)), // non partageable
    async (s, c) => { for (let i = 0; i < 5; i++) await existing(s); await swallow(createShare(c, student, body(q5(s)) as never)); }, // plafond
    async (s, c) => { await s.k.db.update(keys.student('fam1', 'stu1'), { set: { sharing: false } }); await swallow(createShare(c, student, body(q5(s)) as never)); }, // partage coupe
    (s, c) => swallow(createShare(c, otherStudent, body(q5(s)) as never)), // fiche d'un autre
    async (s, c) => { // echec de la transaction (course) puis nouvel essai
      const real = c.db.transact.bind(c.db);
      let first = true;
      const racing = { ...c, db: Object.assign(Object.create(c.db) as object, { transact: async (ops: never) => { if (first) { first = false; await s.k.db.put({ ...keys.shareRef('stu1', 1), shareId: 'x', hash: 'f'.repeat(64), docId: DOC, title: 'xxx', count: 5, createdAt: 'x', expiresAt: '2027-01-01T00:00:00.000Z', famSlot: 9, ttl: 1 }); } return real(ops); } }) } as Kit['ctx'];
      await createShare(racing, student, body(q5(s)) as never);
    },
  ],
  'shares-list': [
    async (s, c) => { const r = await existing(s); await openShare(s.k.ctx, r.token); await listMine(c, student); },
    (s, c) => listMine(c, student), // vide
  ],
  'shares-delete': [
    async (s, c) => { const r = await existing(s); await deleteMine(c, student, r.shareId); },
    (s, c) => swallow(deleteMine(c, student, 'inconnu')),
    async (s, c) => { const r = await existing(s); await swallow(deleteMine(c, otherStudent, r.shareId)); },
  ],
  'shares-parent-list': [
    async (s, c) => { await existing(s); await listForParent(c, parent, 'stu1'); },
    (s, c) => swallow(listForParent(c, otherFamilyParent, 'stu1')),
  ],
  'shares-parent-delete': [
    async (s, c) => { const r = await existing(s); await deleteForParent(c, parent, 'stu1', r.shareId); },
    async (s, c) => { await existing(s); await existing(s); await deleteForParent(c, parent, 'stu1'); await deleteForParent(c, parent, 'stu1'); }, // purge et rejeu
    (s, c) => swallow(deleteForParent(c, otherFamilyParent, 'stu1')),
  ],
  'shares-open': [
    async (s, c) => { const r = await existing(s); await openShare(c, r.token); },
    (s, c) => swallow(openShare(c, 'Z'.repeat(22))), // inconnu
    (s, c) => swallow(openShare(c, 'court')), // mal forme
    async (s, c) => { const r = await existing(s); await s.k.db.put({ ...keys.shareDay(await hashOf(r.token), '2026-12-01'), n: 1000, ttl: 1 }); await swallow(openShare(c, r.token)); }, // plafond du jour
  ],
  'shares-report': [
    async (s, c) => { const r = await existing(s); for (let i = 0; i < 3; i++) await reportShare(c, r.token, 'autre'); await swallow(reportShare(c, r.token, 'autre')); }, // suspension a 3
    (s, c) => swallow(reportShare(c, 'Z'.repeat(22), 'autre')),
  ],
};
const hashOf = async (t: string) => (await import('./ctx.js')).hashToken(t);

describe('droits declares = droits reels (S1 #34)', () => {
  it('chaque handler declare a au moins un scenario, et chaque scenario est un handler declare', () => {
    expect(Object.keys(SCENARIOS).sort()).toEqual(Object.keys(SHARE_HANDLERS).sort());
  });
  for (const [name, scenarios] of Object.entries(SCENARIOS)) {
    it(`${name}: tout ce qu'il touche est declare dans shared/share-access.ts`, async () => {
      const allowed = allowedOf(SHARE_HANDLERS[name].access);
      const seen = new Set<string>();
      for (const run of scenarios) {
        const s = await make();
        await run(s, spyShareCtx(s.k.ctx, seen));
      }
      expect([...seen].filter((x) => !allowed.has(x)).sort(), `${name}: acces non declares`).toEqual([]);
      expect(seen.size, `${name}: aucun acces observe`).toBeGreaterThan(0);
    });
  }

  it('shares-open: seulement GetItem et UpdateItem sur SHARE#; JAMAIS de Query, de PutItem, de suppression ni une autre partition', async () => {
    const seen = new Set<string>();
    for (const run of SCENARIOS['shares-open']) {
      const s = await make();
      await run(s, spyShareCtx(s.k.ctx, seen));
    }
    expect([...seen].sort()).toEqual(['get SHARE#', 'update SHARE#']);
  });
  it('shares-report: GetItem, UpdateItem et PutItem sur SHARE# seulement', async () => {
    const seen = new Set<string>();
    for (const run of SCENARIOS['shares-report']) {
      const s = await make();
      await run(s, spyShareCtx(s.k.ctx, seen));
    }
    expect([...seen].sort()).toEqual(['get SHARE#', 'put SHARE#', 'update SHARE#']);
  });
  it('shares-create ne lit ni JOB#, ni EXO# (partitions), ni de fiche autre que QCM#/GAP# (le code ne lit que ces prefixes)', async () => {
    const s = await make();
    const prefixes = new Set<string>();
    const real = s.k.db.query.bind(s.k.db);
    const get = s.k.db.get.bind(s.k.db);
    s.k.db.query = async (pk: string, sk?: string) => { prefixes.add(`${pk.split('#')[0]}#|${sk ?? ''}`); return real(pk, sk); };
    s.k.db.get = async (key) => { prefixes.add(`${key.PK.split('#')[0]}#|${key.SK.split('#')[0]}`); return get(key); };
    await existing(s);
    const bad = [...prefixes].filter((p) => /^(JOB#|COST#|ACTIVATION#)/.test(p) || /EXO#|CLAIM#|VERDICT#/.test(p));
    expect(bad).toEqual([]);
    expect([...prefixes].filter((p) => p.startsWith('DOC#')).sort()).toEqual(['DOC#|GAP#', 'DOC#|QCM#']);
  });
  it('un enregistreur qui voit une methode de base non prevue (queryGsi1) echoue: aucun handler du partage ne lit un index', async () => {
    const s = await make();
    const c = spyShareCtx(s.k.ctx, new Set());
    expect(() => c.db.queryGsi1('FAMILY#fam1')).toThrow('non prevue');
  });
});
