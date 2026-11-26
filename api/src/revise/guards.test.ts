// Chaque garde de la transaction est testee SEULE (mutations): la lecture qui precede la transaction est masquee (course), la transaction doit refuser toute seule.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { revCommit } from './machine.js';
import { settleCost } from './settle.js';
import { bodyOf, correction, COURS, create, DOC, runMachine, setup } from './testkit.js';

type K = Awaited<ReturnType<typeof setup>>;
const ids = (revisionId: string) => ({ revisionId, sid: 's1', fid: 'f1', coursId: COURS });

/** Contexte dont les lectures de ces cles renvoient « rien » (ou une vue modifiee), comme si l'etat avait change APRES la lecture. */
const blind = (k: K, hide: (sk: string) => boolean, view?: (it: Record<string, unknown>) => Record<string, unknown>, firstReads = Infinity) => {
  const db = k.ctx.db;
  let n = 0;
  const get = async (key: { PK: string; SK: string }) => {
    const it = await db.get(key);
    return hide(key.SK) && ++n <= firstReads ? (view && it ? (view(it) as typeof it) : undefined) : it;
  };
  return { ...k.ctx, db: { ...db, get } as typeof db };
};

describe('gardes de la transaction, une par une', () => {
  it('verrou: un cours verrouille apres la lecture est refuse par la transaction (409), rien n\'est cree', async () => {
    const k = await setup();
    await k.db.update(keys.cours('s1', COURS), { set: { appendJobId: 'AUTRE' } });
    await k.db.put({ PK: 'STUDENT#s1', SK: 'JOB#AUTRE', state: 'a_confirmer' });
    const ctx = blind(k, (sk) => sk === `COURS#${COURS}`, ({ appendJobId: _a, ...rest }) => { void _a; return rest; }, 2);
    expect((await create(ctx, correction)).statusCode).toBe(409);
    expect([...k.db.items.values()].filter((i) => i.kind === 'revision')).toEqual([]);
    expect(await k.db.get(keys.revDay('s1', '2026-12-01'))).toBeUndefined();
  });
  it('plafond du jour: la transaction refuse seule (429), sans reserve', async () => {
    const k = await setup();
    await k.db.put({ ...keys.revDay('s1', '2026-12-01'), n: 2 });
    expect((await create(blind(k, (sk) => sk.startsWith('REVJ#')), correction)).statusCode).toBe(429);
    expect(await k.db.get(keys.revMonth('s1', '2026-12'))).toBeUndefined();
  });
  it('plafond du mois (eleve, puis famille): la transaction refuse seule, aucun compteur ne bouge', async () => {
    const k = await setup();
    await k.db.put({ ...keys.revMonth('s1', '2026-12'), coutMicros: 450_000 });
    expect((await create(blind(k, (sk) => sk.startsWith('REVM#')), correction)).statusCode).toBe(429);
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(450_000);
    expect(await k.db.get(keys.revDay('s1', '2026-12-01'))).toBeUndefined(); // tout ou rien
    await k.db.put({ ...keys.revMonth('s1', '2026-12'), coutMicros: 0 });
    await k.db.put({ ...keys.revFamily('f1', '2026-12'), coutMicros: 1_450_000 });
    expect((await create(blind(k, (sk) => sk.startsWith('REVQ#')), correction)).statusCode).toBe(429);
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(0);
  });
  it('reglement concurrent: la reserve n\'est reglee qu\'UNE fois (marqueur settledAt dans la transaction)', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await k.db.update(keys.job('s1', b.revisionId), { set: { coutMicros: 30_000 } });
    const j = (await k.db.get(keys.job('s1', b.revisionId)))!;
    await Promise.all([settleCost(k.ctx, j), settleCost(k.ctx, j)]);
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(30_000);
  });
  it('promotion: un element deja present dans la fiche n\'est JAMAIS remplace (attribute_not_exists)', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId, { stopAfter: 'generate' });
    await k.db.put({ ...keys.claim(DOC, 5), texte: 'DEJA LA', origine: { page: 1, phraseId: 'p1-s2', extrait: 'a b' }, type: 'factuelle', aRisque: false });
    await revCommit(k.ctx, ids(b.revisionId));
    expect((await k.db.get(keys.claim(DOC, 5)))?.texte).toBe('DEJA LA');
  });
  it('ecriture du cours: la transaction exige le verrou (verrou perdu apres la lecture = rien n\'est ecrit, la validation echoue)', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId, { stopAfter: 'generate' });
    const before = JSON.stringify(await k.db.get(keys.coursText('s1', COURS, 1)));
    await k.db.update(keys.cours('s1', COURS), { remove: ['appendJobId'] });
    const ctx = blind(k, (sk) => sk === `COURS#${COURS}`, (h) => ({ ...h, appendJobId: b.revisionId }));
    await expect(revCommit(ctx, ids(b.revisionId))).rejects.toThrow();
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', COURS, 1)))).toBe(before);
    expect((await k.db.get(keys.job('s1', b.revisionId)))?.committedAt).toBeUndefined();
  });
});
