// H1-A et H1-B: les 6 routes du contrat 1.4 existent, servies par de vraies fonctions de game-stack (plus aucun squelette 501), avec des droits etroits.
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { ROUTES } = await import('../lib/api-stack.js');
import { stackName } from '../../shared/names.js';

const H1_ROUTES = ['GET /me/tests', 'GET /me/tests/{testId}', 'GET /students/{sid}/progress', 'GET /students/{sid}/tests', 'GET /students/{sid}/tests/{testId}', 'POST /family/export/archive'];

describe('H1-A: routes et droits', () => {
  const app = buildApp('dev', 'test@example.invalid');
  const api = Template.fromStack(app.node.findChild(stackName('dev', 'api')) as never);
  const game = Template.fromStack(app.node.findChild(stackName('dev', 'game')) as never);

  it('les 6 routes sont dans ROUTES, avec JWT', () => {
    for (const r of H1_ROUTES) expect(ROUTES.find((x) => x.route === r), r).toBeDefined();
    expect(ROUTES.filter((x) => H1_ROUTES.includes(x.route)).some((x) => x.public)).toBe(false);
  });
  it('aucun squelette 501 pour les 6 routes: les fonctions sont dans game-stack, pas dans api-stack', () => {
    const apiFns = (Object.values(api.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string } }[]).map((f) => f.Properties.FunctionName);
    const gameFns = (Object.values(game.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string } }[]).map((f) => f.Properties.FunctionName);
    for (const h of ['tests-read', 'family-progress', 'family-export-archive']) {
      expect(apiFns, h).not.toContain(`qcm-dev-${h}`);
      expect(gameFns, h).toContain(`qcm-dev-${h}`);
    }
    expect(ROUTES.filter((x) => H1_ROUTES.includes(x.route)).every((x) => x.owner === 'game')).toBe(true);
  });
  it('tests-read: role dedie readDocs (GetItem+Query sur STUDENT#/FAMILY#, GetItem seul sur DOC#), aucune ecriture, suppression, S3, Cognito ni Bedrock; le role read partage ne gagne pas DOC#', () => {
    type St = { Action: string | string[]; Condition?: Record<string, Record<string, string[]>> };
    const fns = Object.values(game.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; Role: { 'Fn::GetAtt': string[] } } }[];
    const policies = Object.values(game.findResources('AWS::IAM::Policy')) as { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: St[] } } }[];
    const stmtsOf = (name: string) => {
      const roleId = fns.find((f) => f.Properties.FunctionName === name)?.Properties.Role['Fn::GetAtt'][0] as string;
      expect(roleId, name).toBeDefined();
      return policies.filter((p) => p.Properties.Roles.some((r) => r.Ref === roleId)).flatMap((p) => p.Properties.PolicyDocument.Statement);
    };
    const acts = (s: St) => ([] as string[]).concat(s.Action);
    const lead = (s: St) => s.Condition?.['ForAllValues:StringLike']['dynamodb:LeadingKeys'] ?? [];
    const stmts = stmtsOf('qcm-dev-tests-read');
    const ddb = stmts.filter((s) => acts(s).some((a) => a.startsWith('dynamodb:')));
    expect(ddb.map((s) => [acts(s).sort(), lead(s).sort()]).sort()).toEqual([
      [['dynamodb:GetItem', 'dynamodb:Query'], ['FAMILY#*', 'STUDENT#*']],
      [['dynamodb:GetItem'], ['DOC#*']],
    ].sort());
    expect(stmts.flatMap(acts).filter((a) => !a.startsWith('dynamodb:') && !a.startsWith('logs:'))).toEqual([]);
    // me-get (role read partage) n'a pas DOC#*.
    expect(stmtsOf('qcm-dev-me-get').flatMap(lead)).not.toContain('DOC#*');
  });

  type St = { Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, unknown>> };
  const fns = Object.values(game.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; MemorySize: number; Timeout: number; Environment: { Variables: Record<string, unknown> }; Role: { 'Fn::GetAtt': string[] } } }[];
  const policies = Object.values(game.findResources('AWS::IAM::Policy')) as { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: St[] } } }[];
  const stmtsOf = (name: string): St[] => {
    const roleId = fns.find((f) => f.Properties.FunctionName === name)?.Properties.Role['Fn::GetAtt'][0] as string;
    expect(roleId, name).toBeDefined();
    return policies.filter((p) => p.Properties.Roles.some((r) => r.Ref === roleId)).flatMap((p) => p.Properties.PolicyDocument.Statement);
  };
  const acts = (s: St) => ([] as string[]).concat(s.Action);
  const lead = (s: St) => (s.Condition?.['ForAllValues:StringLike']['dynamodb:LeadingKeys'] ?? []) as string[];

  it('family-progress: role dedie, GetItem+Query sur STUDENT#/FAMILY# seulement, jamais DOC#, aucune ecriture, rien hors DynamoDB', () => {
    const stmts = stmtsOf('qcm-dev-family-progress');
    const ddb = stmts.filter((s) => acts(s).some((a) => a.startsWith('dynamodb:')));
    expect(ddb.map((s) => [acts(s).sort(), lead(s).sort()])).toEqual([[['dynamodb:GetItem', 'dynamodb:Query'], ['FAMILY#*', 'STUDENT#*']]]);
    expect(stmts.flatMap(acts).filter((a) => !a.startsWith('dynamodb:') && !a.startsWith('logs:'))).toEqual([]);
    const role = (n: string) => fns.find((f) => f.Properties.FunctionName === n)?.Properties.Role['Fn::GetAtt'][0];
    expect(role('qcm-dev-family-progress')).not.toBe(role('qcm-dev-me-get'));
  });

  it('family-export-archive: lecture DynamoDB seule, S3 limite a exports/ (Put, Get, liste), jamais scans/, 29 s et 1 Go, bucket par SSM', () => {
    const stmts = stmtsOf('qcm-dev-family-export-archive');
    const ddb = stmts.filter((s) => acts(s).some((a) => a.startsWith('dynamodb:')));
    expect(ddb).toHaveLength(1);
    expect(acts(ddb[0]).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(lead(ddb[0]).sort()).toEqual(['DOC#*', 'FAMILY#*', 'STUDENT#*']);
    const s3 = stmts.filter((s) => acts(s).some((a) => a.startsWith('s3:')));
    expect(s3.flatMap(acts).sort()).toEqual(['s3:GetObject', 's3:ListBucket', 's3:PutObject']);
    const text = JSON.stringify(s3);
    expect(text).toContain('/exports/*');
    expect(text).not.toContain('scans/');
    expect(JSON.stringify(s3.find((s) => acts(s).includes('s3:ListBucket'))?.Condition)).toContain('exports/*');
    expect(stmts.flatMap(acts).filter((a) => !/^(dynamodb|s3|logs):/.test(a))).toEqual([]);
    const f = fns.find((x) => x.Properties.FunctionName === 'qcm-dev-family-export-archive')?.Properties;
    expect(f).toMatchObject({ MemorySize: 1024, Timeout: 29 });
    expect(Object.keys(f?.Environment.Variables ?? {}).sort()).toEqual(['QCM_ENV', 'SCANS_BUCKET', 'TABLE_NAME']);
  });

  it('suppression de la famille: le role admin supprime aussi sous exports/ seulement (plus scans/)', () => {
    const s3 = stmtsOf('qcm-dev-family-admin').filter((s) => acts(s).some((a) => a.startsWith('s3:')));
    expect(s3.flatMap(acts).sort()).toEqual(['s3:DeleteObject', 's3:DeleteObject', 's3:ListBucket', 's3:ListBucket']); // scans/ + exports/ (photos) et figures/ (R1-B)
    const text = JSON.stringify(s3);
    expect(text).toContain('/exports/*');
    expect(text).toContain('/scans/*');
  });

  it('exports/: le bucket expire tout objet apres 1 jour (suppression effective sous 2 jours), sans filtre qui exclurait ce prefixe', () => {
    const data = Template.fromStack(app.node.findChild(stackName('dev', 'data')) as never);
    const buckets = Object.values(data.findResources('AWS::S3::Bucket')) as { Properties: { LifecycleConfiguration?: { Rules: { Id: string; Status: string; ExpirationInDays?: number; Prefix?: string; Filter?: unknown }[] } } }[];
    const rule = buckets.flatMap((b) => b.Properties.LifecycleConfiguration?.Rules ?? []).find((r) => r.Id === 'expire-1-day');
    expect(rule).toMatchObject({ Status: 'Enabled', ExpirationInDays: 1 });
    expect(rule?.Prefix).toBeUndefined();
    expect(rule?.Filter).toBeUndefined();
  });
});
