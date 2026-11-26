// Reglement du cout d'une modification (M1 #90, docs/M1-design.md 6): la reserve de 0,10 EUR prise a la creation est REMPLACEE par le cout reel, UNE SEULE FOIS
// (marqueur `settledAt` pose dans la meme transaction que le reglement des compteurs mensuels de l'eleve et de la famille). Rejouable sans effet.
import { keys } from '../../../shared/ddb/keys.js';
import { iso, jobKey, ttlIn, type Ctx } from '../pipeline/ctx.js';
import type { Item, TxOp } from '../pipeline/ports.js';

export async function settleCost(ctx: Ctx, job: Item): Promise<void> {
  const sid = job.studentId as string;
  const revisionId = job.SK.slice('JOB#'.length);
  const cur = await ctx.db.get(jobKey(sid, revisionId));
  if (!cur || typeof cur.settledAt === 'string') return;
  const reserve = (cur.reserveMicros as number | undefined) ?? 0;
  const delta = ((cur.coutMicros as number | undefined) ?? 0) - reserve; // negatif: la difference est rendue aux compteurs mensuels
  const ops: TxOp[] = [{ key: jobKey(sid, revisionId), spec: { set: { settledAt: iso(ctx) }, cond: { exists: true, absent: ['settledAt'] } } }];
  if (reserve > 0) {
    const month = cur.quotaMonth as string;
    ops.push(
      { key: keys.revMonth(sid, month), spec: { add: { coutMicros: delta }, set: { ttl: ttlIn(ctx, 40 * 86_400) } } },
      { key: keys.revFamily(cur.familyId as string, month), spec: { add: { coutMicros: delta }, set: { ttl: ttlIn(ctx, 40 * 86_400) } } },
    );
  }
  await ctx.db.transact(ops); // false: deja regle par un autre appel
}
