import { describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
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

  it('Lambda verify-run: concurrence reservee, 15 min, mode simule par defaut (QCM_BEDROCK=mock)', () => {
    t.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: `qcm-${env}-verify-run`,
      ReservedConcurrentExecutions: VERIFY_RESERVED_CONCURRENCY,
      Timeout: 900,
      Environment: { Variables: Match.objectLike({ QCM_ENV: env, TABLE_NAME: `qcm-${env}` }) },
    });
    const fns = Object.values(t.findResources('AWS::Lambda::Function', { Properties: { FunctionName: `qcm-${env}-verify-run` } }));
    expect(JSON.stringify(fns)).toContain('"QCM_BEDROCK":"mock"');
  });
  // F7 / T3 B1: le deploy passe -c bedrock=real; sans cette variable la verification tournait avec le FAUX modele (1 jeton, aucun verdict).
  it('avec -c bedrock=real, verify-run recoit QCM_BEDROCK=real', () => {
    const app = buildApp(env, 'test@example.invalid', { bedrock: 'real' });
    const s = app.node.children.find((c) => c.node.id === stackName(env, 'verify'))!;
    Template.fromStack(s as never).hasResourceProperties('AWS::Lambda::Function', { FunctionName: `qcm-${env}-verify-run`, Environment: { Variables: Match.objectLike({ QCM_BEDROCK: 'real' }) } });
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
// y compris celles que d'autres lots ajouteront: ce test les couvrira sans modification. Lit les politiques en ligne, les politiques jointes (Policy,
// ManagedPolicy) et les `ManagedPolicyArns`: aucune politique gerée Bedrock, AdministratorAccess ou PowerUserAccess n'est permise, meme sur un role de traitement.
const FORBIDDEN_MANAGED = /Bedrock|AdministratorAccess|PowerUserAccess/;

/** Roles fautifs d'un ensemble de templates, et nombre de declarations qui accordent bedrock:Invoke* (pour verifier que le test voit quelque chose). */
function scanBedrock(env: (typeof ENVS)[number], tpls: { name: string; t: Template }[]): { offenders: string[]; granting: number } {
  const offenders: string[] = [];
  let granting = 0;
  for (const { name, t } of tpls) {
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
    for (const type of ['AWS::IAM::Policy', 'AWS::IAM::ManagedPolicy']) {
      for (const p of Object.values(t.findResources(type)) as { Properties: { Roles?: unknown[]; Users?: unknown[]; Groups?: unknown[]; PolicyDocument?: never } }[]) {
        const principals = [...(p.Properties.Roles ?? []).map(roleName), ...(p.Properties.Users ?? []).map((u) => `${name}:user:${JSON.stringify(u)}`), ...(p.Properties.Groups ?? []).map((g) => `${name}:group:${JSON.stringify(g)}`)];
        check(statementsOf(p.Properties), principals);
      }
    }
    for (const [id, r] of Object.entries(roles) as [string, { Properties?: { RoleName?: string; Policies?: { PolicyDocument: never }[]; ManagedPolicyArns?: unknown[] } }][]) {
      const rn = r.Properties?.RoleName ?? `${name}:${id}`;
      for (const pol of r.Properties?.Policies ?? []) check(statementsOf(pol), [rn]);
      for (const arn of r.Properties?.ManagedPolicyArns ?? []) if (FORBIDDEN_MANAGED.test(JSON.stringify(arn))) offenders.push(`${rn} (politique geree ${FORBIDDEN_MANAGED.exec(JSON.stringify(arn))![0]})`);
    }
    for (const type of ['AWS::IAM::User', 'AWS::IAM::Group']) {
      for (const [id, r] of Object.entries(t.findResources(type)) as [string, { Properties?: { Policies?: { PolicyDocument: never }[]; ManagedPolicyArns?: unknown[] } }][]) {
        for (const pol of r.Properties?.Policies ?? []) check(statementsOf(pol), [`${name}:${id}`]);
        for (const arn of r.Properties?.ManagedPolicyArns ?? []) if (FORBIDDEN_MANAGED.test(JSON.stringify(arn))) offenders.push(`${name}:${id} (politique geree)`);
      }
    }
  }
  return { offenders, granting };
}

describe.each(ENVS)('M2: seuls les roles de traitement appellent Bedrock (%s)', (env) => {
  it('tout role avec bedrock:Invoke* figure dans processingRoleNames; aucune politique geree Bedrock/Admin/PowerUser', () => {
    const { offenders, granting } = scanBedrock(env, templates(env));
    expect(offenders).toEqual([]);
    expect(granting).toBeGreaterThan(0); // le test voit bien au moins le role de verification
  });
  it('test negatif sur de vrais templates: politique geree Bedrock, role hors liste, politique jointe, utilisateur', () => {
    const synth = (build: (s: Stack) => void) => {
      const app = new App();
      const s = new Stack(app, 'Neg');
      build(s);
      return [{ name: 'Neg', t: Template.fromStack(s) }];
    };
    const lambdaPrincipal = new iam.ServicePrincipal('lambda.amazonaws.com');
    // 1. politique geree AWS Bedrock sur le role de verification (mutation relevee par la relecture)
    const m1 = scanBedrock(env, synth((s) => void new iam.Role(s, 'R', { roleName: processingRoleNames(env)[1], assumedBy: lambdaPrincipal, managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonBedrockFullAccess')] })));
    expect(m1.offenders.join()).toContain('politique geree Bedrock');
    // 2. AdministratorAccess et PowerUserAccess sur un role quelconque
    for (const name of ['AdministratorAccess', 'PowerUserAccess']) {
      const m = scanBedrock(env, synth((s) => void new iam.Role(s, 'R', { assumedBy: lambdaPrincipal, managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(name)] })));
      expect(m.offenders.join(), name).toContain(name);
    }
    // 3. role hors liste avec bedrock:InvokeModel en ligne ou par politique jointe
    const m3 = scanBedrock(env, synth((s) => void new iam.Role(s, 'R', { roleName: 'autre-role', assumedBy: lambdaPrincipal, inlinePolicies: { p: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: ['*'] })] }) } })));
    expect(m3.offenders).toEqual(['autre-role']);
    const m4 = scanBedrock(env, synth((s) => new iam.Role(s, 'R', { roleName: 'autre-role', assumedBy: lambdaPrincipal }).addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModelWithResponseStream'], resources: ['*'] }))));
    expect(m4.offenders).toEqual(['autre-role']);
    // 4. utilisateur avec bedrock:*
    const m5 = scanBedrock(env, synth((s) => new iam.User(s, 'U').addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['bedrock:*'], resources: ['*'] }))));
    expect(m5.offenders.length).toBe(1);
    // 5. un role de traitement avec seulement des politiques gerees autorisees reste accepte
    const ok = scanBedrock(env, synth((s) => void new iam.Role(s, 'R', { roleName: processingRoleNames(env)[1], assumedBy: lambdaPrincipal, managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')] })));
    expect(ok.offenders).toEqual([]);
  });
  it('le detecteur reconnait les actions Bedrock', () => {
    expect(grantsBedrockInvoke({ Effect: 'Allow', Action: ['bedrock:InvokeModelWithResponseStream'] })).toBe(true);
    expect(grantsBedrockInvoke({ Effect: 'Allow', Action: 'bedrock:*' })).toBe(true);
    expect(grantsBedrockInvoke({ Effect: 'Allow', Action: 'bedrock:GetInferenceProfile' })).toBe(false);
  });
});

// FEAT-A (lot I), alarme de 10 EUR: les deux roles qui ecrivent le compteur de cout publient la metrique, aucun autre role n'a cloudwatch:*.
describe.each(ENVS)('Metrique de cout (%s)', (env) => {
  it("PutMetricData limite a l'espace de noms QCMonster, sur pipeline-role et verify-role seulement", () => {
    const holders: string[] = [];
    for (const { t } of templates(env)) {
      const names = new Map(Object.entries(t.findResources('AWS::IAM::Role')).map(([id, r]) => [id, (r as { Properties: { RoleName?: string } }).Properties.RoleName ?? id]));
      for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } }[]) {
        for (const st of statementsOf(p.Properties)) {
          if (!actions(st).some((a) => /^cloudwatch:/i.test(a))) continue;
          expect(actions(st)).toEqual(['cloudwatch:PutMetricData']);
          expect(st.Resource).toBe('*');
          expect(JSON.stringify(st.Condition)).toBe(JSON.stringify({ StringEquals: { 'cloudwatch:namespace': 'QCMonster' } }));
          holders.push(...p.Properties.Roles.map((r) => names.get(r.Ref)!));
        }
      }
    }
    expect(holders.sort()).toEqual([`qcm-${env}-pipeline-role`, `qcm-${env}-verify-role`]);
  });
});
