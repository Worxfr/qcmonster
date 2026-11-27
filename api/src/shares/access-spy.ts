// Enregistreur d'acces du partage (S1 #34, design 11): enrobe le port DynamoDB et note chaque appel `(verbe, partition)`.
// La correspondance port -> IAM est ecrite UNE fois ici: get -> GetItem, query -> Query, put -> PutItem, update -> UpdateItem, remove -> BatchWriteItem,
// transact -> l'action de CHAQUE element (put: PutItem, mise a jour: UpdateItem, verification: ConditionCheckItem). Jamais charge par une fonction deployee.
import type { ShareAccess } from '../../../shared/share-access.js';
import type { Db } from '../pipeline/ports.js';
import type { ShareCtx } from './ctx.js';

type Any = Record<string, unknown>;
const part = (pk: unknown): string => `${String(pk).split('#')[0]}#`;
const VERBS = ['get', 'query', 'put', 'update', 'check', 'batch'] as const;

export function spyShareCtx(ctx: ShareCtx, log: Set<string>): ShareCtx {
  const db = new Proxy(ctx.db, {
    get(t, p) {
      const v = (t as unknown as Record<string | symbol, unknown>)[p];
      if (typeof v !== 'function') return v;
      return (...a: unknown[]) => {
        const m = String(p);
        const a0 = a[0];
        if (m === 'get') log.add(`get ${part((a0 as Any).PK)}`);
        else if (m === 'query') log.add(`query ${part(a0)}`);
        else if (m === 'put') log.add(`put ${part((a0 as Any).PK)}`);
        else if (m === 'update') log.add(`update ${part((a0 as Any).PK)}`);
        else if (m === 'remove') for (const k of a0 as Any[]) log.add(`batch ${part(k.PK)}`);
        else if (m === 'transact') for (const o of a0 as Any[]) log.add('check' in o ? `check ${part((o.check as Any).PK)}` : 'put' in o ? `put ${part((o.put as Any).PK)}` : `update ${part((o.key as Any).PK)}`);
        else throw new Error(`methode de base non prevue: ${m}`); // queryGsi1 n'est autorise a aucun handler du partage
        return (v as (...x: unknown[]) => unknown).apply(t, a);
      };
    },
  }) as Db;
  return { ...ctx, db };
}

export const allowedOf = (a: ShareAccess): Set<string> => new Set(VERBS.flatMap((v) => a[v].map((p) => `${v} ${p}`)));
