import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });

const { buildApp } = await import('../bin/app.js');
const { stackName } = await import('../../shared/names.js');

const clients = (ctx?: Record<string, string>) => {
  if (ctx) process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid', ...ctx });
  const app = buildApp('dev', 'test@example.invalid');
  process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
  const t = Template.fromStack(app.node.findChild(stackName('dev', 'auth')) as never);
  return Object.values(t.findResources('AWS::Cognito::UserPoolClient')).map((r) => (r as { Properties: Record<string, unknown> }).Properties);
};
const named = (cs: Record<string, unknown>[], suffix: string) => cs.find((c) => String(c.ClientName).endsWith(suffix))!;

describe('B1 et B2: clients Cognito', () => {
  it('connexion: ni OAuth (implicite ou code), ni rappel factice, ni portee admin, et aucun attribut en ecriture', () => {
    const web = named(clients(), '-web');
    expect(web.AllowedOAuthFlowsUserPoolClient).toBeFalsy();
    expect(web.AllowedOAuthFlows).toBeUndefined();
    expect(web.AllowedOAuthScopes).toBeUndefined();
    expect(web.CallbackURLs).toBeUndefined();
    expect(web.WriteAttributes).toEqual([]);
    expect(web.ExplicitAuthFlows).toContain('ALLOW_USER_SRP_AUTH');
    expect(JSON.stringify(web)).not.toContain('example.com');
  });
  it('inscription: client separe qui n\'ecrit que l\'e-mail et ne peut pas ouvrir de session', () => {
    const su = named(clients(), '-signup');
    expect(su.WriteAttributes).toEqual(['email']);
    expect(su.ExplicitAuthFlows).toEqual(['ALLOW_REFRESH_TOKEN_AUTH']); // jamais le defaut Cognito (SRP)
    expect(su.AllowedOAuthFlowsUserPoolClient).toBeFalsy();
  });
  it('point d\'extension: oauthCallbackUrls active le flux « code » seul, portee openid seule', () => {
    const web = named(clients({ oauthCallbackUrls: 'https://front.example.invalid/' }), '-web');
    expect(web.AllowedOAuthFlows).toEqual(['code']);
    expect(web.AllowedOAuthScopes).toEqual(['openid']);
    expect(web.CallbackURLs).toEqual(['https://front.example.invalid/']);
  });
});

describe('N1 et N4: pool et declencheur PreSignUp', () => {
  const auth = () => {
    const app = buildApp('dev', 'test@example.invalid');
    return Template.fromStack(app.node.findChild(stackName('dev', 'auth')) as never);
  };
  it('auto-inscription active (AllowAdminCreateUserOnly=false), forcee par un modele de message', () => {
    auth().hasResourceProperties('AWS::Cognito::UserPool', {
      AdminCreateUserConfig: { AllowAdminCreateUserOnly: false, InviteMessageTemplate: { EmailSubject: 'Ton compte QCMonster', EmailMessage: Match.stringLikeRegexp('\\{####\\}') } },
    });
  });
  it('le role du declencheur n\'ecrit que les invitations (LeadingKeys INVITE#*)', () => {
    const policies = Object.values(auth().findResources('AWS::IAM::Policy')) as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }[];
    const ddb = policies.flatMap((p) => p.Properties.PolicyDocument.Statement).filter((st) => JSON.stringify(st.Action).includes('dynamodb:'));
    expect(ddb).toHaveLength(1);
    expect(ddb[0].Action).toBe('dynamodb:UpdateItem');
    expect(ddb[0].Condition).toEqual({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['INVITE#*'] }, Null: { 'dynamodb:LeadingKeys': 'false' } });
  });
});

describe('A1: groupe admin', () => {
  it('le groupe `admin` existe, et aucun utilisateur n\'y est ajoute par le code', () => {
    const app = buildApp('dev', 'test@example.invalid');
    const t = Template.fromStack(app.node.findChild(stackName('dev', 'auth')) as never);
    const names = Object.values(t.findResources('AWS::Cognito::UserPoolGroup')).map((g) => (g as { Properties: { GroupName: string } }).Properties.GroupName);
    expect(names.sort()).toEqual(['admin', 'eleve', 'parent']);
    expect(Object.keys(t.findResources('AWS::Cognito::UserPoolUserToGroupAttachment'))).toEqual([]);
    expect(Object.keys(t.findResources('AWS::Cognito::UserPoolUser'))).toEqual([]);
  });
});
