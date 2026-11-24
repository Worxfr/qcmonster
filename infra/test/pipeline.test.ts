import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { API_FUNCTIONS, STEP_FUNCTIONS } = await import('../lib/pipeline-stack.js');
import { ENVS, processingRoleNames, stackName } from '../../shared/names.js';

const stack = (env: (typeof ENVS)[number]) => Template.fromStack(buildApp(env, 'test@example.invalid').node.findChild(stackName(env, 'pipeline')) as never);

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown };
type Pol = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } };
const statements = (t: Template, roleLogical: RegExp): Stmt[] =>
  (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => (p.Properties.Roles.some((r) => roleLogical.test(r.Ref)) ? p.Properties.PolicyDocument.Statement : []));
const actions = (s: Stmt[]) => s.flatMap((x) => (Array.isArray(x.Action) ? x.Action : [x.Action]));

describe('Pipeline (L2a)', () => {
  for (const env of ENVS) {
    describe(env, () => {
      const t = stack(env);
      it('une fonction par route et par etape, nommees qcm-<env>-<handler>', () => {
        const names = Object.values(t.findResources('AWS::Lambda::Function')).map((f) => (f as { Properties: { FunctionName: string } }).Properties.FunctionName);
        const expected = [...Object.keys(API_FUNCTIONS), ...Object.values(STEP_FUNCTIONS).map((s) => s[0])].map((h) => `qcm-${env}-${h}`);
        expect(names.sort()).toEqual(expected.sort());
        expect(names).toContain(`qcm-${env}-quota-consume`);
        expect(names).toContain(`qcm-${env}-scan-check`);
      });
      it('Bedrock simule par defaut et QCM_ENV pose', () => {
        t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ QCM_ENV: env, QCM_BEDROCK: 'mock' }) } });
      });
      it('seul le role de traitement peut appeler Bedrock, et il est dans processingRoleNames', () => {
        expect(processingRoleNames(env)).toContain(`qcm-${env}-pipeline-role`);
        const roles = Object.values(t.findResources('AWS::IAM::Role')).map((r) => (r as { Properties: { RoleName?: string } }).Properties.RoleName).filter(Boolean); // la machine d'etats a son role genere (sans Bedrock)
        expect(roles.sort()).toEqual([`qcm-${env}-pipeline-api-role`, `qcm-${env}-pipeline-role`, `qcm-${env}-pipeline-trigger-role`].sort());
        const bedrock = (re: RegExp) => actions(statements(t, re)).filter((a) => a.startsWith('bedrock:'));
        expect(bedrock(/pipelineapirole/i)).toEqual([]);
        expect(bedrock(/pipelinetriggerrole/i)).toEqual([]);
        expect(bedrock(/^pipelinerole/i)).toEqual(['bedrock:InvokeModel']);
      });
      it('aucune action avec joker, pas de s3:PutObject hors role API', () => {
        const all = (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
        expect(actions(all).filter((a) => a.includes('*'))).toEqual([]);
        expect(actions(statements(t, /^pipelinerole/i)).filter((a) => a === 's3:PutObject')).toEqual([]);
      });
      it("machine Standard: journal ERROR sans donnees d'execution, attentes de 20 et 30 minutes, verify puis quota", () => {
        t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          StateMachineName: `qcm-${env}-process`,
          StateMachineType: 'STANDARD',
          LoggingConfiguration: Match.objectLike({ Level: 'ERROR', IncludeExecutionData: false }),
        });
        const def = JSON.stringify(Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0]);
        expect(def).toContain('waitForTaskToken');
        expect(def).toContain('TimeoutSeconds\\":1800');
        expect(def).toContain('TimeoutSeconds\\":1200');
        expect(def).toContain(`qcm-${env}-verify-run`);
        expect(def.indexOf('Verification')).toBeLessThan(def.indexOf('ConsommationQuota'));
      });
      it('regle EventBridge: photos du prefixe scans/ seulement', () => {
        t.hasResourceProperties('AWS::Events::Rule', {
          EventPattern: Match.objectLike({ source: ['aws.s3'], 'detail-type': ['Object Created'], detail: Match.objectLike({ object: { key: [{ prefix: 'scans/' }] } }) }),
        });
      });
      it("API Gateway peut invoquer les fonctions de route, limitee a l'API", () => {
        const perms = Object.values(t.findResources('AWS::Lambda::Permission')).filter((p) => (p as { Properties: { Principal: string } }).Properties.Principal === 'apigateway.amazonaws.com');
        expect(perms).toHaveLength(Object.keys(API_FUNCTIONS).length);
      });
    });
  }
});
