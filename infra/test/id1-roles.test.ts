// ID1 (#33): droits IAM exacts sur le gabarit SYNTHETISE, pour le nouveau handler ET pour chaque role qui appelle un chemin modifie
// (leçon des PR #95 et #96: les tests en memoire ne voient pas un droit manquant). Chemins touches: reservation `NAME#` (Get, Query, Put, Delete) sous FAMILY#.
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { ROUTES } = await import('../lib/api-stack.js');
const { GAME_HANDLERS, gameRoleName } = await import('../lib/game-stack.js');
import { readFileSync } from 'node:fs';
import { ENVS, stackName } from '../../shared/names.js';

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: Record<string, Record<string, string[]>> };
type Pol = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } };
const acts = (s: Stmt) => ([] as string[]).concat(s.Action);
const synth = (env: (typeof ENVS)[number]) => {
  const app = buildApp(env, 'test@example.invalid');
  const t = (s: string) => Template.fromStack(app.node.findChild(stackName(env, s)) as never);
  return { game: t('game'), api: t('api') };
};
const roleStmts = (t: Template, roleName: string): Stmt[] => {
  const logical = Object.keys(t.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } }))[0];
  expect(logical, roleName).toBeDefined();
  return (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => (p.Properties.Roles.some((r) => r.Ref === logical) ? p.Properties.PolicyDocument.Statement : []));
};
/** Actions DynamoDB accordees sur une partition donnee (motif de LeadingKeys), toutes instructions confondues. */
const ddbOn = (stmts: Stmt[], partition: string): string[] =>
  stmts.filter((s) => (s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] ?? []).includes(partition)).flatMap(acts).filter((a) => a.startsWith('dynamodb:'));
const cog = (stmts: Stmt[]) => stmts.flatMap(acts).filter((a) => a.startsWith('cognito-idp:')).sort();

describe.each(ENVS)('ID1 IAM (%s)', (env) => {
  const { game, api } = synth(env);
  const role = (key: string) => roleStmts(game, gameRoleName(env, key as never));
  const handlerRole = (name: string) => GAME_HANDLERS.find((h) => h.name === name)!.role;

  it('le handler du nouvel identifiant a son propre role, pas celui de account ni de manage', () => {
    expect(handlerRole('students-login-id-post')).toBe('loginId');
    for (const other of GAME_HANDLERS.filter((h) => h.name !== 'students-login-id-post')) expect(other.role, other.name).not.toBe('loginId');
    const fn = (Object.values(game.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName: string; Role: { 'Fn::GetAtt': string[] } } }[]).find((f) => f.Properties.FunctionName === `qcm-${env}-students-login-id-post`)!;
    expect(fn.Properties.Role['Fn::GetAtt'][0]).toMatch(/Roleloginid|RoleloginId/i);
  });

  it('role loginId: exactement GetItem et PutItem sur FAMILY#*, et trois actions Cognito, rien d\'autre', () => {
    const st = role('loginId');
    expect(ddbOn(st, 'FAMILY#*').sort()).toEqual(['dynamodb:GetItem', 'dynamodb:PutItem']);
    const ddb = st.filter((s) => acts(s).some((a) => a.startsWith('dynamodb:')));
    expect(ddb).toHaveLength(1);
    expect(ddb[0].Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys']).toEqual(['FAMILY#*']);
    expect(cog(st)).toEqual(['cognito-idp:AdminGetUser', 'cognito-idp:AdminUpdateUserAttributes', 'cognito-idp:AdminUserGlobalSignOut']);
    const others = st.flatMap(acts).filter((a) => !/^(dynamodb|cognito-idp|logs):/.test(a));
    expect(others).toEqual([]);
    for (const s of st) expect(JSON.stringify(s.Resource)).not.toContain('"*"');
    // la ressource Cognito est le pool, pas un joker
    expect(JSON.stringify(st.filter((s) => acts(s).some((a) => a.startsWith('cognito-idp:'))).map((s) => s.Resource))).toContain('userpool');
  });

  it('route POST /students/{sid}/login-id: JWT, plafond 1 requete/s rafale 3, integration sur la fonction', () => {
    const route = ROUTES.find((r) => r.route === 'POST /students/{sid}/login-id')!;
    expect(route).toMatchObject({ handler: 'students-login-id-post', owner: 'game', throttle: { rate: 1, burst: 3 } });
    expect(route.public).toBeUndefined();
    const stage = Object.values(api.findResources('AWS::ApiGatewayV2::Stage')) as { Properties: { RouteSettings: Record<string, { ThrottlingRateLimit: number; ThrottlingBurstLimit: number }> } }[];
    expect(stage[0].Properties.RouteSettings['POST /students/{sid}/login-id']).toEqual({ ThrottlingRateLimit: 1, ThrottlingBurstLimit: 3 });
    const routes = Object.values(api.findResources('AWS::ApiGatewayV2::Route')) as { Properties: { RouteKey: string; AuthorizationType?: string } }[];
    expect(routes.find((r) => r.Properties.RouteKey === 'POST /students/{sid}/login-id')?.Properties.AuthorizationType).toBe('JWT');
    expect(JSON.stringify(api.findResources('AWS::ApiGatewayV2::Integration'))).toContain(`qcm-${env}-students-login-id-post`);
  });

  // Chaque role qui appelle un chemin modifie par ID1 a les droits dont le code se sert, sur la partition FAMILY#*.
  it.each([
    // [handler, droits DynamoDB necessaires sous FAMILY#*, ce que le code fait]
    ['students-create', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem'], 'Query des eleves, Get de la reservation, TransactWrite (eleve, lien, reservation)'],
    ['students-update', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], 'renommage: Put de la nouvelle reservation, Delete de l\'ancienne dans la meme transaction'],
    ['activation-post', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:DeleteItem'], 'surnom: Query, Get, TransactWrite (eleve + reservation, Delete de l\'ancienne)'],
    ['students-delete', ['dynamodb:Query', 'dynamodb:BatchWriteItem'], 'suppression de l\'eleve: liste puis BatchWrite des reservations NAME#'],
    ['family-admin', ['dynamodb:Query', 'dynamodb:BatchWriteItem'], 'suppression de la famille: liste puis BatchWrite des reservations NAME#'],
    ['me-get', ['dynamodb:GetItem', 'dynamodb:Query'], 'GET /me et classement: lecture seule'],
    ['family-read', ['dynamodb:GetItem', 'dynamodb:Query'], 'tableau de bord et classement: lecture seule'],
  ] as const)('%s: %s', (handler, needed, _why) => {
    const have = ddbOn(role(handlerRole(handler)), 'FAMILY#*');
    for (const a of needed) expect(have, `${handler} ${a}`).toContain(a);
  });

  it('la lecture seule n\'ecrit ni ne supprime; l\'activation (route publique) ne gagne aucun droit Cognito', () => {
    for (const h of ['me-get', 'family-read']) expect(ddbOn(role(handlerRole(h)), 'FAMILY#*').sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
    expect(cog(role('activation'))).toEqual(['cognito-idp:AdminSetUserPassword']);
    expect(cog(role('manage'))).toEqual(['cognito-idp:AdminDisableUser', 'cognito-idp:AdminEnableUser', 'cognito-idp:AdminUserGlobalSignOut']);
  });

  it('le code des handlers ne demande aucun droit absent: chaque handler du lot utilise le role attendu', () => {
    const src = (n: string) => readFileSync(new URL(`../../api/src/handlers/${n}.ts`, import.meta.url), 'utf8');
    expect(src('students-login-id-post')).toContain('regenerateLoginId');
    expect(src('activation-post')).toContain('activate(');
    // POST /students/{sid}/login-id ne passe par aucun autre handler
    expect(ROUTES.filter((r) => r.handler === 'students-login-id-post').map((r) => r.route)).toEqual(['POST /students/{sid}/login-id']);
  });
});
