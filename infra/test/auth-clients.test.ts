import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
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
