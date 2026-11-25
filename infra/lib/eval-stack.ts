import { Aws, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { fn, ssmParam, stackName, tableName, type Env } from '../../shared/names.js';
import { EU_REGIONS, SYSTEM_PROFILES } from './models-stack.js';

export interface EvalStackProps extends StackProps {
  envName: Env;
  /** Prefixe du claim `sub` GitHub du depot (forme immuable avec identifiants numeriques si le depot l'utilise), lu par le workflow. */
  subPrefix: string;
}

/** Role d'execution de `eval-run`. Appelle Bedrock: DOIT passer le test M2 (autorise en dev seulement, voir `evalRunRoleNames`). */
export const evalRunRoleName = (env: Env): string => `qcm-${env}-eval-run-role`;
/** Roles d'evaluation qui peuvent ouvrir Bedrock, en plus de `processingRoleNames` (test M2). Vide en prod: la voie d'evaluation n'y existe pas. */
export const evalRunRoleNames = (env: Env): string[] => (env === 'dev' ? [evalRunRoleName(env)] : []);
/** Role GitHub Actions d'evaluation: assumable par OIDC pour le seul `sub` de l'environnement `dev`, ne peut qu'invoquer `eval-run`. */
export const EVAL_INVOKER_ROLE_NAME = 'QCMonster-Eval-dev';
export const evalFnName = (env: Env): string => fn(env, 'eval-run');
export const SUB_PREFIX_RE = /^repo:[A-Za-z0-9._-]+(@\d+)?\/[A-Za-z0-9._-]+(@\d+)?$/;

/**
 * Voie d'evaluation DEV SEULEMENT (`-c evalPath=true`, jamais en prod): une Lambda `eval-run` qui execute le pipeline reel sur une page
 * synthetique du depot, en memoire (aucune ecriture dans la table hors compteur COST#dev), et un role OIDC qui ne peut que l'invoquer.
 * Le role OIDC n'a aucun droit DynamoDB: les compteurs de cout sont lus par l'action `cost` de la Lambda.
 */
export class EvalStack extends Stack {
  constructor(scope: Construct, id: string, props: EvalStackProps) {
    super(scope, id, props);
    const { envName, subPrefix } = props;
    if (envName !== 'dev') throw new Error("la voie d'evaluation n'existe qu'en dev");
    if (!SUB_PREFIX_RE.test(subPrefix)) throw new Error('evalSubPrefix invalide (attendu: repo:<proprietaire>[@id]/<depot>[@id])');
    for (const s of ['models', 'data']) {
      const dep = scope.node.tryFindChild(stackName(envName, s));
      if (dep instanceof Stack) this.addStackDependency(dep);
    }
    const table = tableName(envName);
    const tableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table });
    const arns = { haiku: ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'models/haiku')), sonnet: ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'models/sonnet')) };

    const role = new iam.Role(this, 'Role', { roleName: evalRunRoleName(envName), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), description: 'eval-run (dev): moindre privilege (QCMonster E1)' });
    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    logGroup.grantWrite(role);
    // Compteur de cout seulement (lecture + ajout), pas de partition de famille, d'eleve ni de fiche.
    role.addToPolicy(new iam.PolicyStatement({ sid: 'CostCounterOnly', actions: ['dynamodb:GetItem', 'dynamodb:UpdateItem'], resources: [tableArn], conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`COST#${envName}`] }, Null: { 'dynamodb:LeadingKeys': 'false' } } })); // Null: sans cette clause, ForAllValues laisse passer une requete sans cle (N8)
    // Bedrock: pour chaque modele, le profil d'application (ARN lu dans SSM), et le profil systeme / modele de base seulement a travers ce profil.
    for (const model of ['haiku', 'sonnet'] as const) {
      const systemId = SYSTEM_PROFILES[model];
      const baseModel = systemId.replace(/^[a-z]+\./, '');
      role.addToPolicy(new iam.PolicyStatement({ sid: `InvokeProfile${model}`, actions: ['bedrock:InvokeModel'], resources: [arns[model]] }));
      role.addToPolicy(
        new iam.PolicyStatement({
          sid: `InvokeUnderlying${model}`,
          actions: ['bedrock:InvokeModel'],
          resources: [this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: systemId }), ...EU_REGIONS.map((region) => this.formatArn({ service: 'bedrock', region, account: '', resource: 'foundation-model', resourceName: baseModel }))],
          conditions: { StringLike: { 'bedrock:InferenceProfileArn': arns[model] } },
        }),
      );
    }

    const evalFn = new NodejsFunction(this, 'Fn', {
      functionName: evalFnName(envName),
      entry: fileURLToPath(new URL('../../eval/lambda/handler.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      role,
      memorySize: 512,
      timeout: Duration.minutes(10),
      logGroup,
      environment: { QCM_ENV: envName, TABLE_NAME: table, QCM_MODEL_HAIKU: arns.haiku, QCM_MODEL_SONNET: arns.sonnet },
      bundling: { format: OutputFormat.ESM, target: 'node22', minify: true, sourceMap: false, mainFields: ['module', 'main'], banner: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    });

    // Fournisseur OIDC GitHub existant du compte: reference seulement (jamais cree ni modifie ici). Aucun compte dans le depot: Aws.ACCOUNT_ID.
    const invoker = new iam.Role(this, 'Invoker', {
      roleName: EVAL_INVOKER_ROLE_NAME,
      description: "GitHub Actions (environnement dev) -> invoquer eval-run seulement (QCMonster E1)",
      maxSessionDuration: Duration.hours(3),
      assumedBy: new iam.WebIdentityPrincipal(`arn:${Aws.PARTITION}:iam::${Aws.ACCOUNT_ID}:oidc-provider/token.actions.githubusercontent.com`, {
        StringEquals: { 'token.actions.githubusercontent.com:aud': 'sts.amazonaws.com', 'token.actions.githubusercontent.com:sub': `${subPrefix}:environment:${envName}` },
      }),
    });
    invoker.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeEvalRunOnly', actions: ['lambda:InvokeFunction'], resources: [evalFn.functionArn] }));
  }
}
