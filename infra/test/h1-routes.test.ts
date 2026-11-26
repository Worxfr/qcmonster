// H1-A: les 6 routes du contrat 1.4 existent; `tests-read` est une vraie fonction en lecture seule; les deux autres lots restent en 501.
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
  it('family-progress et family-export-archive: squelettes 501 non_implemente; tests-read: pas de squelette', () => {
    const fns = Object.values(api.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; Code: { ZipFile: string } } }[];
    for (const h of ['family-progress', 'family-export-archive']) {
      const f = fns.find((x) => x.Properties.FunctionName === `qcm-dev-${h}`);
      expect(f, h).toBeDefined();
      expect(f?.Properties.Code.ZipFile).toContain('non_implemente');
    }
    expect(fns.map((f) => f.Properties.FunctionName)).not.toContain('qcm-dev-tests-read');
  });
  it('tests-read: lecture seule (GetItem, Query) limitee a STUDENT# et FAMILY#, ni ecriture, ni suppression, ni S3, ni Cognito, ni Bedrock', () => {
    const fn = (Object.values(game.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; Role: { 'Fn::GetAtt': string[] } } }[]).find((f) => f.Properties.FunctionName === 'qcm-dev-tests-read');
    expect(fn).toBeDefined();
    const roleId = fn?.Properties.Role['Fn::GetAtt'][0] as string;
    const policies = Object.values(game.findResources('AWS::IAM::Policy')) as { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: { Action: string | string[]; Condition?: Record<string, Record<string, string[]>> }[] } } }[];
    const stmts = policies.filter((p) => p.Properties.Roles.some((r) => r.Ref === roleId)).flatMap((p) => p.Properties.PolicyDocument.Statement);
    const ddb = stmts.filter((s) => ([] as string[]).concat(s.Action).some((a) => a.startsWith('dynamodb:')));
    expect(ddb.flatMap((s) => ([] as string[]).concat(s.Action)).sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(ddb.flatMap((s) => s.Condition?.['ForAllValues:StringLike']['dynamodb:LeadingKeys'] ?? []).sort()).toEqual(['FAMILY#*', 'STUDENT#*']);
    expect(stmts.flatMap((s) => ([] as string[]).concat(s.Action)).filter((a) => !a.startsWith('dynamodb:') && !a.startsWith('logs:'))).toEqual([]);
  });
});
