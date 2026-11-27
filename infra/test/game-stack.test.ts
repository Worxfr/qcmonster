import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { ROUTES, HANDLER_LOT } = await import('../lib/api-stack.js');
const { GAME_HANDLERS } = await import('../lib/game-stack.js');
import { processingRoleNames, stackName, type Env } from '../../shared/names.js';

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown };
const tpl = (env: Env) => Template.fromStack(buildApp(env, 'test@example.invalid').node.findChild(stackName(env, 'game')) as never);
const actions = (s: Stmt) => ([] as string[]).concat(s.Action);

/** Instructions IAM par role (role -> instructions). */
function statementsByRole(t: Template): Record<string, Stmt[]> {
  const out: Record<string, Stmt[]> = {};
  const roleNames: Record<string, string> = {};
  for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role'))) roleNames[id] = (r as { Properties: { RoleName: string } }).Properties.RoleName;
  for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as { Properties: { Roles?: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } }[]) {
    const name = roleNames[p.Properties.Roles?.[0]?.Ref as string];
    (out[name] ??= []).push(...p.Properties.PolicyDocument.Statement);
  }
  return out;
}

describe.each(['dev', 'prod'] as Env[])('GameStack (%s)', (env) => {
  const t = tpl(env);
  const fns = Object.values(t.findResources('AWS::Lambda::Function')) as { Properties: Record<string, unknown> }[];

  it('une fonction par handler du lot L3, nommee comme le veut la stack Api', () => {
    const names = fns.map((f) => f.Properties.FunctionName as string).sort();
    expect(names).toEqual(GAME_HANDLERS.map((h) => `qcm-${env}-${h.name}`).sort());
    // Les handlers du lot sont exactement ceux que la table ROUTES attribue a L3 et a E1 (les fonctions `exo-gen`, `copie-correct` et `copie-fail` sont dans la stack Exo).
    const l3 = [...new Set(ROUTES.map((r) => r.handler).filter((h) => HANDLER_LOT[h] === 'L3' || HANDLER_LOT[h] === 'E1'))].sort();
    expect(GAME_HANDLERS.map((h) => h.name).sort()).toEqual(l3);
    for (const f of fns) {
      expect(f.Properties).toMatchObject({ Runtime: 'nodejs22.x', Architectures: ['arm64'] });
      expect((f.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ QCM_ENV: env, TABLE_NAME: `qcm-${env}` });
    }
  });

  it('invocation par l\'API de l\'environnement seulement (identifiant lu dans SSM)', () => {
    const perms = Object.values(t.findResources('AWS::Lambda::Permission')) as { Properties: { Principal: string; SourceArn: unknown } }[];
    expect(perms).toHaveLength(GAME_HANDLERS.length);
    for (const p of perms) {
      expect(p.Properties.Principal).toBe('apigateway.amazonaws.com');
      expect(JSON.stringify(p.Properties.SourceArn)).toContain('SsmParameterValue'); // l'identifiant d'API vient du parametre SSM
    }
    const params = JSON.stringify(t.toJSON().Parameters);
    expect(params).toContain(`/qcm/${env}/api/id`);
    expect(params).toContain(`/qcm/${env}/auth/userPoolId`);
  });

  it('l\'identifiant du pool et du bucket viennent de SSM, jamais ecrits en dur', () => {
    const json = JSON.stringify(t.toJSON());
    expect(json).toContain(`/qcm/${env}/data/scansBucket`);
    expect(json).not.toMatch(/eu-west-3_[A-Za-z0-9]{9}/);
  });

  it('moindre privilege: ressources nommees, jamais de joker, rien sur Bedrock, roles distincts du traitement', () => {
    const byRole = statementsByRole(t);
    expect(Object.keys(byRole).sort()).toEqual(['account', 'activation', 'admin', 'archive', 'copieDelete', 'copieStart', 'invite', 'loginId', 'manage', 'play', 'progress', 'read', 'readDocs'].map((k) => `qcm-${env}-game-${k}-role`).sort());
    for (const [role, stmts] of Object.entries(byRole)) {
      expect(processingRoleNames(env)).not.toContain(role);
      for (const s of stmts) {
        expect(s.Effect).toBe('Allow');
        for (const a of actions(s)) {
          expect(a, role).not.toMatch(/\*/);
          expect(a, role).not.toMatch(/^bedrock/);
        }
        expect(JSON.stringify(s.Resource), role).not.toBe('"*"');
        expect(JSON.stringify(s.Resource), role).not.toContain('"*"');
      }
    }
  });

  it('DynamoDB: chaque instruction est limitee a des partitions (dynamodb:LeadingKeys)', () => {
    const byRole = statementsByRole(t);
    const leading = (k: string) => (byRole[`qcm-${env}-game-${k}-role`] ?? []).filter((s) => actions(s).some((a) => a.startsWith('dynamodb:'))).map((s) => (s as unknown as { Condition?: Record<string, Record<string, string[]>> }).Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']);
    for (const k of ['read', 'readDocs', 'progress', 'archive', 'play', 'account', 'manage', 'admin', 'activation', 'invite', 'loginId', 'copieStart', 'copieDelete']) for (const l of leading(k)) expect(l, k).toBeDefined();
    // La route publique n'atteint que les liens d'activation et la famille (lecture de l'eleve).
    expect(leading('activation').flat().sort()).toEqual(['ACTIVATION#*', 'FAMILY#*']);
    expect(leading('read').flat()).not.toContain('ACTIVATION#*');
    expect(leading('play').flat()).not.toContain('ACTIVATION#*');
    expect(leading('play').flat()).not.toContain('JOB#*');
  });

  it('droits Cognito: mot de passe seulement pour l\'activation; creation seulement pour les comptes; lecture seule n\'a rien', () => {
    const byRole = statementsByRole(t);
    const cog = (k: string) => (byRole[`qcm-${env}-game-${k}-role`] ?? []).flatMap(actions).filter((a) => a.startsWith('cognito-idp:'));
    expect(cog('activation')).toEqual(['cognito-idp:AdminSetUserPassword']);
    expect(cog('read')).toEqual([]);
    expect(cog('play')).toEqual([]);
    expect(cog('account')).toEqual(expect.arrayContaining(['cognito-idp:AdminCreateUser', 'cognito-idp:AdminAddUserToGroup', 'cognito-idp:AdminUpdateUserAttributes']));
    expect(cog('manage')).toEqual(['cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminUserGlobalSignOut']);
    expect(cog('admin')).toEqual(['cognito-idp:AdminDeleteUser']);
    const all = Object.entries(byRole).flatMap(([r, s]) => s.flatMap(actions).filter((a) => a === 'cognito-idp:AdminSetUserPassword').map(() => r));
    expect(all).toEqual([`qcm-${env}-game-activation-role`]);
  });

  it('DynamoDB: la lecture seule ne peut pas ecrire; seule la suppression peut supprimer en lot', () => {
    const byRole = statementsByRole(t);
    const ddb = (k: string) => (byRole[`qcm-${env}-game-${k}-role`] ?? []).flatMap(actions).filter((a) => a.startsWith('dynamodb:'));
    expect(ddb('read')).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(ddb('play')).not.toContain('dynamodb:DeleteItem');
    expect(ddb('admin')).toContain('dynamodb:BatchWriteItem');
    expect(ddb('admin')).not.toContain('dynamodb:PutItem');
    for (const k of ['read', 'play', 'account', 'manage', 'activation']) expect(ddb(k)).not.toContain('dynamodb:BatchWriteItem');
  });

  it('A1: le role des invitations n\'a que dynamodb:PutItem sur INVITE#*, ni Cognito, ni lecture, ni autre partition', () => {
    const st = statementsByRole(t)[`qcm-${env}-game-invite-role`] ?? [];
    const ddb = st.filter((s) => actions(s).some((a) => a.startsWith('dynamodb:')));
    expect(ddb).toHaveLength(1);
    expect(actions(ddb[0])).toEqual(['dynamodb:PutItem']);
    expect((ddb[0] as unknown as { Condition: Record<string, Record<string, string[]>> }).Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys']).toEqual(['INVITE#*']);
    expect(st.flatMap(actions).filter((a) => !a.startsWith('dynamodb:') && !a.startsWith('logs:'))).toEqual([]);
    const fn = (Object.values(t.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; Environment: { Variables: Record<string, unknown> } } }[]).find((f) => f.Properties.FunctionName === `qcm-${env}-admin-invitations`);
    expect(Object.keys(fn?.Properties.Environment.Variables ?? {}).sort()).toEqual(['QCM_ENV', 'TABLE_NAME']);
  });

  it('photos: le role de suppression ne liste et n\'efface que sous scans/', () => {
    const s3 = (statementsByRole(t)[`qcm-${env}-game-admin-role`] ?? []).filter((s) => actions(s).some((a) => a.startsWith('s3:')));
    // R1-B: + figures/ (liste du prefixe et suppression), jamais de lecture. E1: copies/ s'ajoute aux instructions de scans/ (liste avec condition de prefixe, suppression).
    expect(s3.flatMap(actions).sort()).toEqual(['s3:DeleteObject', 's3:DeleteObject', 's3:ListBucket', 's3:ListBucket']);
    expect(JSON.stringify(s3)).toContain('scans/*');
    expect(JSON.stringify(s3)).toContain('copies/*');
    expect(JSON.stringify(s3)).toContain('figures/*');
  });

  it('depend des stacks Auth, Api et Data', () => {
    const app = buildApp(env, 'test@example.invalid');
    const game = app.node.findChild(stackName(env, 'game')) as unknown as { dependencies: { stackName: string }[] };
    expect(game.dependencies.map((d) => d.stackName).sort()).toEqual(['auth', 'api', 'data'].map((s) => stackName(env, s)).sort());
  });
});

describe('Api: les routes du lot L3 pointent vers les fonctions de la stack Game', () => {
  it('les handlers en owner game: aucun squelette, une integration par handler, route d\'activation sans JWT', () => {
    const api = Template.fromStack(buildApp('dev', 'test@example.invalid').node.findChild(stackName('dev', 'api')) as never);
    const mine = new Set(GAME_HANDLERS.map((h) => h.name));
    expect(ROUTES.filter((r) => mine.has(r.handler)).every((r) => r.owner === 'game')).toBe(true);
    const skeletons = (Object.values(api.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string } }[]).map((f) => f.Properties.FunctionName);
    for (const h of mine) expect(skeletons).not.toContain(`qcm-dev-${h}`);
    const integrations = JSON.stringify(api.findResources('AWS::ApiGatewayV2::Integration'));
    for (const h of mine) expect(integrations).toContain(`qcm-dev-${h}`);
    const routes = Object.values(api.findResources('AWS::ApiGatewayV2::Route')) as { Properties: { RouteKey: string; AuthorizationType?: string } }[];
    expect(routes.find((r) => r.Properties.RouteKey === 'POST /activation')?.Properties.AuthorizationType).toBe('NONE');
    // S1 (#34): deux routes publiques de plus (ouverture et signalement d'un partage), voir infra/test/stacks.test.ts
    expect(routes.filter((r) => r.Properties.AuthorizationType === 'NONE').map((r) => r.Properties.RouteKey).sort()).toEqual(['POST /activation', 'POST /shares/open', 'POST /shares/report']);
  });
});

describe('variables d\'environnement des handlers', () => {
  it('un handler qui construit familyDeps() recoit USER_POOL_ID; ceux qui creent un lien recoivent WEB_ORIGIN; ceux qui suppriment SCANS_BUCKET', () => {
    for (const h of GAME_HANDLERS) {
      const src = readFileSync(new URL(`../../api/src/handlers/${h.name}.ts`, import.meta.url), 'utf8');
      const needs = h.needs ?? [];
      if (/familyDeps\(/.test(src)) expect(needs, h.name).toContain('USER_POOL_ID');
      if (/createStudent|createLink/.test(src)) expect(needs, h.name).toContain('WEB_ORIGIN');
      if (/deleteStudent|deleteFamily/.test(src)) expect(needs, h.name).toContain('SCANS_BUCKET');
    }
  });
});
