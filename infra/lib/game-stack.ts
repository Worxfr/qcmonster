import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { webOriginFor } from './data-stack.js';
import { fn, ssmParam, stackName, tableName, type Env } from '../../shared/names.js';

export interface GameStackProps extends StackProps {
  envName: Env;
}

type RoleKey = 'read' | 'play' | 'account' | 'manage' | 'admin' | 'activation' | 'invite';
interface HandlerDef {
  name: string;
  role: RoleKey;
  /** Variables d'environnement en plus de TABLE_NAME et QCM_ENV. */
  needs?: ('USER_POOL_ID' | 'WEB_ORIGIN' | 'SCANS_BUCKET')[];
}

/**
 * Handlers du lot L3 et role de chacun (moindre privilege). Un role par profil d'acces, jamais de `*` sur les ressources.
 * Les noms de roles ne sont PAS ceux de `processingRoleNames` (aucun droit Bedrock ici).
 */
export const GAME_HANDLERS: ReadonlyArray<HandlerDef> = [
  { name: 'me-get', role: 'read' },
  { name: 'family-read', role: 'read' },
  // contract-v1.4 (H1-A): historique des tests de l'eleve. Lecture seule (GetItem, Query), aucun droit d'ecriture ni de suppression.
  { name: 'tests-read', role: 'read' },
  { name: 'session-get', role: 'play' },
  { name: 'answers-post', role: 'play' },
  { name: 'docs-mark-read', role: 'play' },
  { name: 'reports-validate', role: 'play' },
  { name: 'students-create', role: 'account', needs: ['USER_POOL_ID', 'WEB_ORIGIN'] },
  { name: 'family-create', role: 'account', needs: ['USER_POOL_ID'] },
  { name: 'students-link', role: 'manage', needs: ['USER_POOL_ID', 'WEB_ORIGIN'] },
  { name: 'students-update', role: 'manage', needs: ['USER_POOL_ID'] },
  { name: 'students-delete', role: 'admin', needs: ['USER_POOL_ID', 'SCANS_BUCKET'] },
  { name: 'family-admin', role: 'admin', needs: ['USER_POOL_ID', 'SCANS_BUCKET'] },
  { name: 'activation-post', role: 'activation', needs: ['USER_POOL_ID', 'WEB_ORIGIN'] },
  // contract-v1.2 (A1): codes d'invitation parent par un administrateur (groupe Cognito `admin`)
  { name: 'admin-invitations', role: 'invite' },
];

export const gameRoleName = (env: Env, key: RoleKey) => `qcm-${env}-game-${key}-role`;

/**
 * Famille et jeu (L3, design-v2 10.2): comptes parent et eleve, activation, XP, series, badges, classement, anti-triche.
 * Fonctions `qcm-<env>-<handler>` reliees aux routes `owner: 'game'` de la stack Api. Les identifiants du pool Cognito, de l'API et du
 * bucket des scans sont lus dans SSM (publies par les stacks Auth, Api et Data): pas d'import entre stacks. Depend des stacks Auth et Api.
 */
export class GameStack extends Stack {
  constructor(scope: Construct, id: string, props: GameStackProps) {
    super(scope, id, props);
    const { envName } = props;
    for (const s of ['auth', 'api', 'data']) {
      const dep = scope.node.tryFindChild(stackName(envName, s));
      if (dep instanceof Stack) this.addStackDependency(dep);
    }

    const table = tableName(envName);
    const tableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table });
    const userPoolId = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'auth/userPoolId'));
    const apiId = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'api/id'));
    const scansBucket = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'data/scansBucket'));
    const poolArn = this.formatArn({ service: 'cognito-idp', resource: 'userpool', resourceName: userPoolId });
    const webOrigin = webOriginFor(this, envName);

    // DynamoDB: chaque instruction est limitee aux partitions que le role utilise (dynamodb:LeadingKeys), comme verify-stack.
    // shortcut: IAM filtre la cle de partition, pas la cle de tri: `play` pourrait ecrire n'importe quel element STUDENT#/FAMILY#
    // (par exemple FAMILY#<fid>/META); « chaque type a un seul ecrivain » repose sur le code et ses tests pour ces partitions.
    const ddb = (actions: string[], leading: string[], index = false) =>
      new iam.PolicyStatement({
        actions: actions.map((a) => `dynamodb:${a}`),
        resources: index ? [tableArn, `${tableArn}/index/GSI1`] : [tableArn],
        conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': leading } },
      });
    // Risque accepte: IAM ne filtre pas les utilisateurs Cognito par groupe. Les actions ci-dessous valent pour TOUT le pool; en particulier
    // `AdminSetUserPassword` (role `activation`, route publique) permettrait de changer le mot de passe d'un parent si le code etait contourne.
    // Mitigation: le jeton d'activation (256 bits, usage unique, 24 h) et le nom d'utilisateur lu en base, jamais dans la requete.
    const cognito = (actions: string[]) => new iam.PolicyStatement({ actions: actions.map((a) => `cognito-idp:${a}`), resources: [poolArn] });
    const READ = ['GetItem', 'Query'];
    // TransactWriteItems exige les droits de chaque action de la transaction (ici Put pour nos elements, Update pour les quotas).
    const WRITE = ['PutItem', 'UpdateItem', 'ConditionCheckItem'];
    const FAM = ['FAMILY#*'];
    const STU = ['STUDENT#*'];

    const policies: Record<RoleKey, iam.PolicyStatement[]> = {
      // Lectures seules (profil, tableau de bord, classement).
      read: [ddb(READ, [...FAM, ...STU])],
      // Jeu: lit fiches/questions/verdicts (DOC#), ecrit PROFILE, DAY, ATT (STUDENT#), WEEK, quotas, bonus, signalements (FAMILY#).
      play: [ddb(READ, [...FAM, ...STU, 'DOC#*']), ddb(WRITE, [...FAM, ...STU])],
      // Creation: famille (groupe parent, famille_id) et eleve (utilisateur Cognito sans message), lien d'activation.
      account: [ddb([...READ, ...WRITE, 'DeleteItem'], [...FAM, 'ACTIVATION#*']), cognito(['AdminCreateUser', 'AdminAddUserToGroup', 'AdminUpdateUserAttributes', 'AdminGetUser', 'AdminDeleteUser'])],
      // Gestion: nouveau lien, suspension (desactive le compte et revoque ses jetons), quota.
      manage: [ddb([...READ, ...WRITE, 'DeleteItem'], [...FAM, 'ACTIVATION#*']), cognito(['AdminDisableUser', 'AdminEnableUser', 'AdminUserGlobalSignOut'])],
      // Suppression et export: efface tout, y compris l'utilisateur Cognito et les photos en cours.
      admin: [
        ddb([...READ, 'DeleteItem', 'BatchWriteItem'], [...FAM, ...STU, 'DOC#*', 'JOB#*', 'ACTIVATION#*'], true),
        cognito(['AdminDeleteUser']),
        new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [`arn:${this.partition}:s3:::${scansBucket}`], conditions: { StringLike: { 's3:prefix': ['scans/*'] } } }),
        new iam.PolicyStatement({ actions: ['s3:DeleteObject'], resources: [`arn:${this.partition}:s3:::${scansBucket}/scans/*`] }),
      ],
      // Route publique: lit l'eleve et le jeton (hache), consomme le jeton, pose le mot de passe. Rien d'autre.
      activation: [ddb([...READ, 'PutItem', 'DeleteItem'], ['ACTIVATION#*', ...FAM]), cognito(['AdminSetUserPassword'])],
      // Codes d'invitation: PutItem sur INVITE#* seulement (code et audit). Ni lecture, ni Cognito, ni autre partition (audit securite 2).
      invite: [ddb(['PutItem'], ['INVITE#*'])],
    };

    const roles = {} as Record<RoleKey, iam.Role>;
    for (const key of Object.keys(policies) as RoleKey[]) {
      roles[key] = new iam.Role(this, `Role-${key}`, {
        roleName: gameRoleName(envName, key),
        assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'),
      });
      for (const st of policies[key]) roles[key].addToPolicy(st);
    }

    const extra = { USER_POOL_ID: userPoolId, WEB_ORIGIN: webOrigin, SCANS_BUCKET: scansBucket };
    for (const h of GAME_HANDLERS) {
      const logGroup = new logs.LogGroup(this, `Logs-${h.name}`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
      logGroup.grantWrite(roles[h.role]); // journaux de CETTE fonction seulement
      const f = new NodejsFunction(this, `Fn-${h.name}`, {
        functionName: fn(envName, h.name),
        entry: fileURLToPath(new URL(`../../api/src/handlers/${h.name}.ts`, import.meta.url)),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: 256,
        timeout: Duration.seconds(h.role === 'admin' ? 30 : 10),
        role: roles[h.role],
        environment: { TABLE_NAME: table, QCM_ENV: envName, ...Object.fromEntries((h.needs ?? []).map((n) => [n, extra[n]])) },
        logGroup,
        bundling: { minify: true, sourceMap: false, target: 'node22' },
      });
      // Invocation par l'API de cet environnement seulement (identifiant lu dans SSM), jamais par un autre principal.
      f.addPermission('InvokeFromApi', {
        principal: new iam.ServicePrincipal('apigateway.amazonaws.com'),
        sourceArn: this.formatArn({ service: 'execute-api', resource: apiId, resourceName: '*/*' }),
      });
    }
  }
}
