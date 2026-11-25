// Rendu et consommation du quota, idempotents. Un element `QUOTAOP#<job>#<type>` est ecrit dans la MEME transaction que la mise a
// jour des compteurs (condition: il n'existe pas): une relance apres un arret au milieu ne double jamais l'effet, et ne l'oublie pas
// (le drapeau `quotaState` du job est pose apres, il sert a decider, pas a garantir).
import { keys } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import type { QuotaScope } from '../../../shared/quota.js';
import { DAY_S, jobKey, ttlIn, type Ctx } from './ctx.js';
import type { Item, TxOp } from './ports.js';

/** Plafonds de quota de l'eleve et de la famille (lus dans Eleve / Famille, sinon valeurs par defaut de l'environnement). */
export async function quotaScope(ctx: Ctx, familyId: string, sid: string, month: string): Promise<QuotaScope> {
  const d = quotaDefaults(ctx.env);
  const [student, family] = await Promise.all([ctx.db.get(keys.student(familyId, sid)), ctx.db.get(keys.family(familyId))]);
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : dflt);
  return { familyId, studentId: sid, month, studentLimit: num(student?.quotaPages, d.studentPages), familyLimit: num(family?.quotaPages, d.familyPages) };
}

type Kind = 'release' | 'consume' | 'refund';
const marker = (job: Item, kind: Kind) => ({ PK: `FAMILY#${job.familyId as string}`, SK: `QUOTAOP#${job.SK.slice('JOB#'.length)}#${kind}` });

/**
 * Applique `release` (reserve -> restant), `consume` (reserve -> utilise) ou `refund` (utilise -> restant, apres une consommation) une seule fois
 * pour ce job. Renvoie false si l'operation est refusee (`release`/`consume` sont exclusives; `refund` exige `consume`) ou deja faite.
 */
export async function applyQuotaOnce(ctx: Ctx, job: Item, kind: Kind): Promise<boolean> {
  if (kind === 'refund') {
    if (!(await ctx.db.get(marker(job, 'consume'))) || (await ctx.db.get(marker(job, 'release')))) return false;
  } else if (await ctx.db.get(marker(job, kind === 'release' ? 'consume' : 'release'))) return false; // un job ne rend pas ce qu'il a consomme, ni l'inverse
  const sid = job.studentId as string;
  const pages = job.pages as number;
  const scope = await quotaScope(ctx, job.familyId as string, sid, job.quotaMonth as string);
  const add: Record<string, number> = kind === 'release' ? { reserve: -pages, restant: pages } : kind === 'refund' ? { utilise: -pages, restant: pages } : { reserve: -pages, utilise: pages };
  const ops: TxOp[] = [
    { put: { ...marker(job, kind), ttl: ttlIn(ctx, 30 * DAY_S) }, ifNotExists: true },
    { key: keys.quota(scope.familyId, scope.month, sid), spec: { add, cond: { exists: true } } },
    { key: keys.quotaFamily(scope.familyId, scope.month), spec: { add, cond: { exists: true } } },
  ];
  if (await ctx.db.transact(ops)) return true;
  if (await ctx.db.get(marker(job, kind))) return false; // deja fait par une tentative precedente
  throw new Error('quota: compteur introuvable');
}

/** Rend les pages reservees d'un job (rejet, annulation, expiration, echec avant consommation). Sans effet si elles sont consommees: voir `returnQuotaOnce`. */
export async function releaseQuotaOnce(ctx: Ctx, sid: string, jobId: string): Promise<void> {
  const job = await ctx.db.get(jobKey(sid, jobId));
  if (!job || job.quotaState !== 'reserved') return;
  await applyQuotaOnce(ctx, job, 'release');
  await ctx.db.update(jobKey(sid, jobId), { set: { quotaState: 'released' } });
}

/**
 * Fin d'un job sans fiche: rend les pages quel que soit leur etat, une seule fois. Reservees: rendues. Consommees (echec apres `quotaConsume`):
 * rendues aussi (decision d'Alexis), meme si l'arret est survenu entre l'ecriture du quota et le drapeau `quotaState`. Rejouable sans risque.
 */
export async function returnQuotaOnce(ctx: Ctx, sid: string, jobId: string): Promise<void> {
  const job = await ctx.db.get(jobKey(sid, jobId));
  if (!job || (job.quotaState !== 'reserved' && job.quotaState !== 'consumed')) return;
  if (await ctx.db.get(marker(job, 'consume'))) {
    // `false` = refus (marqueur `release`) ou deja fait. Le drapeau `refunded` n'est pose que si le rendu a eu lieu ou si son marqueur existe deja.
    const done = (await applyQuotaOnce(ctx, job, 'refund')) || !!(await ctx.db.get(marker(job, 'refund')));
    if (done) await ctx.db.update(jobKey(sid, jobId), { set: { quotaState: 'refunded' } });
  } else if (job.quotaState === 'reserved') {
    await releaseQuotaOnce(ctx, sid, jobId);
  }
}

/** Consomme les pages reservees (apres `verify-run`). */
export async function consumeQuotaOnce(ctx: Ctx, sid: string, jobId: string): Promise<void> {
  const job = await ctx.db.get(jobKey(sid, jobId));
  if (!job || job.quotaState !== 'reserved') return;
  await applyQuotaOnce(ctx, job, 'consume');
  await ctx.db.update(jobKey(sid, jobId), { set: { quotaState: 'consumed' } });
}
