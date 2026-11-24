import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });

const { buildApp } = await import('../bin/app.js');
import { ENVS, processingRoleNames, stackName } from '../../shared/names.js';
import { VERIFY_RESERVED_CONCURRENCY } from '../../api/src/verify/limits.js';

const templates = (env: (typeof ENVS)[number]) => {
  const app = buildApp(env, 'test@example.invalid');
  return app.node.children.filter((c) => c.node.id.startsWith(`qcm-${env}-`)).map((s) => ({ name: s.node.id, t: Template.fromStack(s as never) }));
};

type Stmt = { Effect?: string; Action?: string | string[]; Resource?: unknown; Condition?: unknown; Sid?: string };
const actions = (s: Stmt) => ([] as string[]).concat(s.Action ?? []);
const statementsOf = (props: { PolicyDocument?: { Statement?: Stmt[] } }) => props.PolicyDocument?.Statement ?? [];
const grantsBedrockInvoke = (s: Stmt) => s.Effect !== 'Deny' && actions(s).some((a) => /^(bedrock:(Invoke|\*)|\*$)/i.test(a) || /^bedrock:Invoke/i.test(a));

describe.each(ENVS)('Verify (%s)', (env) => {
  const all = templates(env);
  const t = all.find((x) => x.name === stackName(env, 'verify'))!.t;

  it('Lambda verify-run: concurrence reservee, 15 min, mode simule (QCM_BEDROCK absent)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `qcm-${env}-verify-run`,
      ReservedConcurrentExecutions: VERIFY_RESERVED_CONCURRENCY,
      Timeout: 900,
      Environment: { Variables: Match.objectLike({ QCM_ENV: env, TABLE_NAME: `qcm-${env}` }) },
    });
    const fns = Object.values(t.findResources('AWS::Lambda::Function', { Properties: { FunctionName: `qcm-${env}-verify-run` } }));
    expect(JSON.stringify(fns)).not.toContain('QCM_BEDROCK');
  });
  it('le role porte le nom exact de processingRoleNames (cible de l\'action du budget securite-40)', () => {
    t.hasResourceProperties('AWS::IAM::Role', { RoleName: `qcm-${env}-verify-role` });
    expect(processingRoleNames(env)).toContain(`qcm-${env}-verify-role`);
  });
  it('moindre privilege: pas de joker sur les actions, DynamoDB limite aux partitions utilisees, pas de suppression', () => {
    const pol = Object.values(t.findResources('AWS::IAM::Policy')).flatMap((p) => statementsOf((p as { Properties: never }).Properties));
    for (const s of pol) {
      expect(actions(s).some((a) => a === '*' || a.endsWith(':*'))).toBe(false);
    }
    const ddb = pol.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')));
    expect(ddb.length).toBeGreaterThan(0);
    for (const s of ddb) {
      expect(JSON.stringify(s.Condition)).toContain('dynamodb:LeadingKeys');
      expect(actions(s).some((a) => /Delete|Scan|BatchWrite|TransactWrite/.test(a))).toBe(false);
    }
    expect(JSON.stringify(ddb.filter((s) => actions(s).includes('dynamodb:PutItem')))).not.toContain('COST#');
    const bedrock = pol.filter(grantsBedrockInvoke);
    expect(bedrock.length).toBeGreaterThan(0);
    expect(bedrock.every((s) => actions(s).every((a) => a === 'bedrock:InvokeModel'))).toBe(true);
    expect(JSON.stringify(bedrock)).not.toContain('"*"');
  });
});

// Test M2 (revue du plan de la vague 3): AUCUN role hors processingRoleNames ne peut recevoir bedrock:Invoke*. Parcourt toutes les stacks de l'application,
// y compris celles que d'autres lots ajouteront: ce test les couvrira sans modification.
describe.each(ENVS)('M2: seuls les roles de traitement appellent Bedrock (%s)', (env) => {
  it('tout role avec bedrock:Invoke* figure dans processingRoleNames', () => {
    const offenders: string[] = [];
    let granting = 0;
    for (const { name, t } of templates(env)) {
      const roles = t.findResources('AWS::IAM::Role');
      const roleName = (ref: unknown): string => {
        const id = (ref as { Ref?: string })?.Ref;
        const r = id ? (roles[id] as { Properties?: { RoleName?: string } } | undefined) : undefined;
        return r?.Properties?.RoleName ?? `${name}:${id ?? JSON.stringify(ref)}`; // role sans nom fixe: ne peut pas figurer dans la liste
      };
      const check = (stmts: Stmt[], roleNames: string[]) => {
        if (!stmts.some(grantsBedrockInvoke)) return;
        granting++;
        for (const rn of roleNames) if (!processingRoleNames(env).includes(rn)) offenders.push(rn);
      };
      for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as { Properties: { Roles?: unknown[]; PolicyDocument?: never } }[]) {
        check(statementsOf(p.Properties), (p.Properties.Roles ?? []).map(roleName));
      }
      for (const p of Object.values(t.findResources('AWS::IAM::ManagedPolicy')) as { Properties: { Roles?: unknown[]; PolicyDocument?: never } }[]) {
        check(statementsOf(p.Properties), (p.Properties.Roles ?? []).map(roleName));
      }
      for (const [id, r] of Object.entries(roles) as [string, { Properties?: { RoleName?: string; Policies?: { PolicyDocument: never }[] } }][]) {
        for (const pol of r.Properties?.Policies ?? []) check(statementsOf(pol), [r.Properties?.RoleName ?? `${name}:${id}`]);
      }
    }
    expect(offenders).toEqual([]);
    expect(granting).toBeGreaterThan(0); // le test voit bien au moins le role de verification
  });
  it("le detecteur reconnait un role fautif (test negatif)", () => {
    const s: Stmt = { Effect: 'Allow', Action: ['bedrock:InvokeModelWithResponseStream'] };
    expect(grantsBedrockInvoke(s)).toBe(true);
    expect(grantsBedrockInvoke({ Effect: 'Allow', Action: 'bedrock:*' })).toBe(true);
    expect(grantsBedrockInvoke({ Effect: 'Allow', Action: 'bedrock:GetInferenceProfile' })).toBe(false);
  });
});
