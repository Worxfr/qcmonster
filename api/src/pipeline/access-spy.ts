// Enregistreur d'acces (M1 #90, docs/M1-design.md 7.3): enrobe les ports d'un contexte et note chaque appel `(verbe, partition)` ou `port.methode`.
// La correspondance Db -> IAM est ecrite UNE fois ici: get -> GetItem, query -> Query, put/update/transact -> PutItem/UpdateItem/ConditionCheckItem, remove -> BatchWriteItem.
// Sert au test « droits declares = droits reels » (api/src/revise/access.test.ts); jamais charge par une fonction deployee.
import type { Ctx } from './ctx.js';
import type { Partition, ReviseAccess } from '../../../shared/revise-access.js';

const VERB: Record<string, 'get' | 'query' | 'put' | 'update' | 'transact' | 'batch'> = { get: 'get', query: 'query', queryGsi1: 'query', put: 'put', update: 'update', transact: 'transact', remove: 'batch' };
const part = (pk: unknown): string => `${String(pk).split('#')[0]}#`;

type Any = Record<string, unknown>;
function wrap<T extends object>(target: T, name: string, log: Set<string>): T {
  return new Proxy(target, {
    get(t, p) {
      const v = (t as Record<string | symbol, unknown>)[p];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        const m = String(p);
        if (name === 'db') {
          const verb = VERB[m];
          if (!verb) throw new Error(`methode de base non prevue: ${m}`);
          const a0 = a[0];
          if (m === 'transact') {
            // une transaction demande l'action de CHAQUE element: PutItem pour un `put`, UpdateItem pour une mise a jour
            for (const o of a0 as Any[]) log.add(`${o.put ? 'put' : 'update'} ${part((o.put as Any | undefined)?.PK ?? (o.key as Any).PK)}`);
          } else {
            const pks: unknown[] = m === 'remove' ? (a0 as Any[]).map((k) => k.PK) : [typeof a0 === 'string' ? a0 : (a0 as Any).PK];
            for (const pk of pks) log.add(`${verb} ${part(pk)}`);
          }
        } else if (name === 'cost') log.add(`${m === 'read' ? 'get' : 'update'} COST#`); // compteur de cout: GetItem / UpdateItem sur COST#<env>
        else log.add(`${name}.${m}`);
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  });
}

/** Contexte dont chaque port est enregistre dans `log`. `model`: appel du modele ou du compteur de cout. */
export function spyCtx(ctx: Ctx, log: Set<string>): Ctx {
  return { ...ctx, db: wrap(ctx.db, 'db', log), s3: wrap(ctx.s3, 's3', log), figures: wrap(ctx.figures, 'figures', log), sfn: wrap(ctx.sfn, 'sfn', log), port: wrap(ctx.port, 'model', log), costStore: wrap(ctx.costStore, 'cost', log) };
}

/** Acces autorises par une declaration, dans la meme ecriture que le journal de `spyCtx`. */
export function allowedOf(a: ReviseAccess): Set<string> {
  const out = new Set<string>();
  const add = (verb: string, ps: Partition[]) => ps.forEach((p) => out.add(`${verb} ${p}`));
  add('get', a.get);
  add('query', a.query);
  add('put', a.put);
  add('update', a.update);
  add('batch', a.batch);
  if (a.sfn) out.add('sfn.start');
  if (a.model) out.add('model.converse');
  return out;
}
