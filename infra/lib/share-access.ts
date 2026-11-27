// Droits DynamoDB du PARTAGE DE QCM (S1 #34), DERIVES de shared/share-access.ts (source unique, docs/S1-design.md section 11).
// Un role nouveau a l'union des acces des handlers qui l'utilisent; les roles existants recoivent UNE instruction `SHARE#*` separee. Aucun joker d'action ni de ressource.
import * as iam from 'aws-cdk-lib/aws-iam';
import { DELETE_SHARES_ADDED, SHARE_HANDLERS, type Partition, type ShareAccess, type ShareRole } from '../../shared/share-access.js';

type Verb = 'get' | 'query' | 'put' | 'update' | 'check' | 'batch';
export const VERBS: readonly Verb[] = ['get', 'query', 'put', 'update', 'check', 'batch'];
/** Action DynamoDB de chaque verbe declare. */
export const SHARE_DDB_ACTIONS: Record<Verb, string> = {
  get: 'dynamodb:GetItem',
  query: 'dynamodb:Query',
  put: 'dynamodb:PutItem',
  update: 'dynamodb:UpdateItem',
  check: 'dynamodb:ConditionCheckItem',
  batch: 'dynamodb:BatchWriteItem',
};

/** Union des acces des handlers d'un role nouveau. */
export function shareAccessOf(role: ShareRole): ShareAccess {
  const out: Record<Verb, Set<Partition>> = { get: new Set(), query: new Set(), put: new Set(), update: new Set(), check: new Set(), batch: new Set() };
  for (const h of Object.values(SHARE_HANDLERS).filter((x) => x.role === role)) for (const v of VERBS) for (const p of h.access[v]) out[v].add(p);
  return Object.fromEntries(VERBS.map((v) => [v, [...out[v]]])) as unknown as ShareAccess;
}

const statement = (tableArn: string, actions: string[], parts: Partition[]) =>
  new iam.PolicyStatement({ actions, resources: [tableArn], conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': parts.map((p) => `${p}*`) }, Null: { 'dynamodb:LeadingKeys': 'false' } } });

/** Une instruction par verbe (les partitions different d'un verbe a l'autre). Pas d'index GSI1: aucun handler de partage ne l'interroge. */
export function shareStatements(role: ShareRole, tableArn: string): iam.PolicyStatement[] {
  const a = shareAccessOf(role);
  return VERBS.filter((v) => a[v].length).map((v) => statement(tableArn, [SHARE_DDB_ACTIONS[v]], a[v]));
}

/**
 * Instruction SEPAREE des roles existants qui appellent la suppression avec l'option `deleteShares` (`deleteRole`, `coursRole`, `admin`): `SHARE#*` seulement,
 * Query et BatchWriteItem. Jamais dans `ddbApi` (partage par `readRole`, `writeRole`, `confirmRole`): l'y mettre l'ouvrirait a tous.
 */
export function deleteSharesStatement(tableArn: string): iam.PolicyStatement {
  const a = DELETE_SHARES_ADDED;
  return statement(tableArn, VERBS.filter((v) => a[v].length).map((v) => SHARE_DDB_ACTIONS[v]), ['SHARE#']);
}
