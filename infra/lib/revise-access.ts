// Droits DynamoDB des DEUX roles nouveaux de la modification d'un cours (M1 #90), DERIVES de shared/revise-access.ts (source unique, docs/M1-design.md 7).
// Un role a l'union des acces des handlers qui l'utilisent. Aucun S3, aucun Bedrock, aucun joker. Les tests infra/test/m1-roles.test.ts relisent le gabarit synthetise
// et comparent, dans les deux sens, a cette meme source; api/src/revise/access.test.ts verifie que le code ne fait que ce qui est declare.
import * as iam from 'aws-cdk-lib/aws-iam';
import { REVISE_HANDLERS, type Partition, type ReviseAccess, type ReviseRole } from '../../shared/revise-access.js';

export type NewRole = Extract<ReviseRole, 'reviseStart' | 'revise'>;

/** Union des acces des handlers d'un role. */
export function accessOf(role: ReviseRole): Required<Pick<ReviseAccess, 'get' | 'query' | 'put' | 'update' | 'batch'>> & { sfn: boolean } {
  const out = { get: new Set<Partition>(), query: new Set<Partition>(), put: new Set<Partition>(), update: new Set<Partition>(), batch: new Set<Partition>(), sfn: false };
  for (const h of Object.values(REVISE_HANDLERS).filter((x) => x.role === role)) {
    for (const k of ['get', 'query', 'put', 'update', 'batch'] as const) for (const p of h.access[k]) out[k].add(p);
    out.sfn ||= h.access.sfn === true;
  }
  return { get: [...out.get], query: [...out.query], put: [...out.put], update: [...out.update], batch: [...out.batch], sfn: out.sfn };
}

/** Actions DynamoDB de chaque verbe declare (ecriture: transactions comprises). */
export const DDB_ACTIONS = {
  get: ['dynamodb:GetItem'],
  query: ['dynamodb:Query'],
  put: ['dynamodb:PutItem'],
  update: ['dynamodb:UpdateItem'],
  batch: ['dynamodb:BatchWriteItem'],
} as const;

/** Motif de `LeadingKeys` d'une partition: le compteur de cout est limite a l'element de l'environnement. */
export const leadingKey = (p: Partition, env: string): string => (p === 'COST#' ? `COST#${env}` : `${p}*`);

/** Une instruction par verbe: la lecture, l'ecriture et la suppression n'ont pas toujours les memes partitions. `machineArn`: `states:StartExecution` sur CETTE machine seulement. */
export function reviseStatements(role: NewRole, o: { env: string; tableArn: string; machineArn: string }): iam.PolicyStatement[] {
  const a = accessOf(role);
  const out: iam.PolicyStatement[] = [];
  for (const k of ['get', 'query', 'put', 'update', 'batch'] as const) {
    const parts = a[k].filter((p) => p !== 'COST#');
    if (parts.length) out.push(new iam.PolicyStatement({ actions: [...DDB_ACTIONS[k]], resources: [o.tableArn, `${o.tableArn}/index/GSI1`], conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': parts.map((p) => leadingKey(p, o.env)) }, Null: { 'dynamodb:LeadingKeys': 'false' } } }));
    // Compteur de cout: lecture seule de COST#<env> (garde de budget), sans l'index.
    if (a[k].includes('COST#')) out.push(new iam.PolicyStatement({ actions: [...DDB_ACTIONS[k]], resources: [o.tableArn], conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [leadingKey('COST#', o.env)] }, Null: { 'dynamodb:LeadingKeys': 'false' } } }));
  }
  if (a.sfn) out.push(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [o.machineArn] }));
  return out;
}
