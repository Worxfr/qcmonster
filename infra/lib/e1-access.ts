// Droits des roles E1, DERIVES de shared/exo-access.ts (source unique, docs/E1-design.md section 11).
// Un role a l'union des acces des handlers qui l'utilisent: DynamoDB par partition (dynamodb:LeadingKeys), S3 sur le seul prefixe `copies/`.
// Le test infra/test/e1-access.test.ts relit le gabarit synthetise et compare, dans les deux sens, a cette meme source.
import * as iam from 'aws-cdk-lib/aws-iam';
import { COPIES_PREFIX } from '../../shared/names.js';
import { E1_HANDLERS, type E1Role, type HandlerAccess, type Partition } from '../../shared/exo-access.js';

/** Union des acces des handlers d'un role. */
export function accessOf(role: E1Role): Required<Omit<HandlerAccess, 's3'>> & { s3: NonNullable<HandlerAccess['s3']> } {
  const out = { get: new Set<Partition>(), query: new Set<Partition>(), write: new Set<Partition>(), delete: new Set<Partition>(), s3: {} as NonNullable<HandlerAccess['s3']> };
  for (const h of Object.values(E1_HANDLERS).filter((x) => x.role === role)) {
    for (const k of ['get', 'query', 'write', 'delete'] as const) for (const p of h.access[k]) out[k].add(p);
    Object.assign(out.s3, h.access.s3);
  }
  return { get: [...out.get], query: [...out.query], write: [...out.write], delete: [...out.delete], s3: out.s3 };
}

/** Actions DynamoDB de chaque verbe declare (ecriture: transactions comprises, comme `WRITE` de game-stack). */
export const DDB_ACTIONS = {
  get: ['dynamodb:GetItem'],
  query: ['dynamodb:Query'],
  write: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'],
  delete: ['dynamodb:DeleteItem'],
} as const;

/** Motif de `LeadingKeys` d'une partition: le compteur de cout est limite a l'element de l'environnement. */
export const leadingKey = (p: Partition, env: string): string => (p === 'COST#' ? `COST#${env}` : `${p}*`);

/**
 * Instructions DynamoDB et S3 d'un role E1. `bucketArn` est l'ARN du bucket des scans (lu dans SSM, jamais ecrit en dur).
 * Une instruction par verbe: l'ecriture et la lecture n'ont pas toujours les memes partitions.
 */
export function e1Statements(role: E1Role, o: { env: string; tableArn: string; bucketArn: string }): iam.PolicyStatement[] {
  const a = accessOf(role);
  const out: iam.PolicyStatement[] = [];
  for (const k of ['get', 'query', 'write', 'delete'] as const) {
    if (a[k].length === 0) continue;
    out.push(
      new iam.PolicyStatement({
        actions: [...DDB_ACTIONS[k]],
        resources: [o.tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': a[k].map((p) => leadingKey(p, o.env)) } },
      }),
    );
  }
  const objects = `${o.bucketArn}/${COPIES_PREFIX}*`;
  if (a.s3.get) out.push(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [objects] }));
  if (a.s3.put) out.push(new iam.PolicyStatement({ actions: ['s3:PutObject'], resources: [objects] }));
  if (a.s3.delete) out.push(new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: [objects] }));
  if (a.s3.list) out.push(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [o.bucketArn], conditions: { StringLike: { 's3:prefix': [`${COPIES_PREFIX}*`] } } }));
  return out;
}
