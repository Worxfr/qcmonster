// Voie d'evaluation (E1): dev seulement, role OIDC etroit, role d'execution limite au compteur de cout et a Bedrock (le test M2 l'audite aussi).
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
import { Stack } from 'aws-cdk-lib';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { EVAL_INVOKER_ROLE_NAME, evalRunRoleName } = await import('../lib/eval-stack.js');
import { missingTags } from './tags.js';

const SUB = 'repo:Exemple@1/depot@2';
const dev = (ctx: Record<string, string> = { evalPath: 'true', evalSubPrefix: SUB }) => buildApp('dev', 'test@example.invalid', ctx);
type Res = { Type: string; Properties?: Record<string, unknown> };
const resources = (app: ReturnType<typeof dev>) => {
  const s = app.node.findChild('qcm-dev-eval') as Stack;
  return (Template.fromStack(s).toJSON() as { Resources: Record<string, Res> }).Resources;
};

describe('stack eval: instanciation', () => {
  it('absente par defaut (dev et prod)', () => {
    expect(dev({}).node.tryFindChild('qcm-dev-eval')).toBeUndefined();
    expect(buildApp('prod', 'test@example.invalid').node.tryFindChild('qcm-prod-eval')).toBeUndefined();
  });
  it('presente en dev avec evalPath=true', () => {
    expect(dev().node.tryFindChild('qcm-dev-eval')).toBeDefined();
  });
  it('refusee en prod, meme avec evalPath=true', () => {
    expect(() => buildApp('prod', 'test@example.invalid', { evalPath: 'true', evalSubPrefix: SUB })).toThrow(/qu'en dev/);
  });
  it('refusee sans prefixe de sub valide', () => {
    expect(() => dev({ evalPath: 'true' })).toThrow(/evalSubPrefix/);
    expect(() => dev({ evalPath: 'true', evalSubPrefix: 'repo:*' })).toThrow(/evalSubPrefix/);
  });
});

describe('stack eval: role OIDC et droits', () => {
  const r = resources(dev());
  const roles = Object.values(r).filter((x) => x.Type === 'AWS::IAM::Role');
  const named = (n: string) => roles.find((x) => x.Properties?.RoleName === n)!;
  it('le role invocateur n\'est assumable que pour le sub exact environment:dev, audience sts', () => {
    const trust = JSON.stringify(named(EVAL_INVOKER_ROLE_NAME).Properties?.AssumeRolePolicyDocument);
    expect(trust).toContain(`${SUB}:environment:dev`);
    expect(trust).toContain('sts.amazonaws.com');
    expect(trust).toContain('AssumeRoleWithWebIdentity');
    expect(trust).not.toContain('*');
    expect(trust).not.toContain('StringLike');
  });
  it('le role invocateur n\'a que lambda:InvokeFunction sur la fonction eval-run', () => {
    const pols = Object.values(r).filter((x) => x.Type === 'AWS::IAM::Policy' && JSON.stringify(x.Properties?.Roles).includes('Invoker'));
    expect(pols).toHaveLength(1);
    const st = (pols[0].Properties?.PolicyDocument as { Statement: { Action: unknown; Resource: unknown }[] }).Statement;
    expect(st).toHaveLength(1);
    expect(st[0].Action).toBe('lambda:InvokeFunction');
    expect(JSON.stringify(st[0].Resource)).toContain('Fn');
    expect(JSON.stringify(st[0].Resource)).not.toContain('*');
  });
  it('le role d\'execution n\'accede a DynamoDB que par COST#dev et ne touche ni S3 ni Step Functions ni Cognito', () => {
    const pols = Object.values(r).filter((x) => x.Type === 'AWS::IAM::Policy' && JSON.stringify(x.Properties?.Roles).includes('Role'));
    const text = JSON.stringify(pols.map((p) => p.Properties?.PolicyDocument));
    expect(text).toContain('COST#dev');
    for (const bad of ['s3:', 'states:', 'cognito', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem', 'dynamodb:Scan']) expect(text).not.toContain(bad);
    // N8: ForAllValues seul laisse passer une requete sans cle de partition: la clause Null est obligatoire.
    const ddb = pols.flatMap((p) => (p.Properties?.PolicyDocument as { Statement: { Action: unknown; Condition?: Record<string, Record<string, unknown>> }[] }).Statement).filter((st) => JSON.stringify(st.Action).includes('dynamodb:'));
    expect(ddb.length).toBeGreaterThan(0);
    for (const st of ddb) {
      expect(st.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']).toEqual(['COST#dev']);
      expect(st.Condition?.Null).toEqual({ 'dynamodb:LeadingKeys': 'false' });
    }
    expect(named(evalRunRoleName('dev')).Properties?.ManagedPolicyArns).toBeUndefined(); // aucune politique geree
  });
  it('la fonction n\'a pas d\'adresse publique ni de permission d\'invocation tierce', () => {
    const types = Object.values(r).map((x) => x.Type);
    expect(types).not.toContain('AWS::Lambda::Url');
    expect(types).not.toContain('AWS::Lambda::Permission');
  });
  it('QCM_ENV=dev et aucune variable de prod', () => {
    const f = Object.values(r).find((x) => x.Type === 'AWS::Lambda::Function')!;
    const env = (f.Properties?.Environment as { Variables: Record<string, unknown> }).Variables;
    expect(env.QCM_ENV).toBe('dev');
  });
  it('toutes les ressources portent les 4 tags', () => {
    const s = dev().node.findChild('qcm-dev-eval') as Stack;
    expect(missingTags(Template.fromStack(s).toJSON())).toEqual([]);
  });
});
