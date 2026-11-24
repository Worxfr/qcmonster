import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction, OutputFormat } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { fn, ssmParam, stackName, tableName, WORKFLOW_HANDLERS, type Env } from '../../shared/names.js';
import { SYSTEM_PROFILES } from './models-stack.js';
import { VERIFY_RESERVED_CONCURRENCY } from '../../api/src/verify/limits.js';

export interface VerifyStackProps extends StackProps {
  envName: Env;
}

/** Nom du role de verification: DOIT figurer dans `processingRoleNames` (action du budget securite-40, test M2). */
export const verifyRoleName = (env: Env): string => `qcm-${env}-verify-role`;

/**
 * Lot L2b: Lambda `verify-run` (etapes 7 a 10). Reference par NOM par la machine d'etats de L2a (`fn(env, 'verify-run')`).
 * Aucun appel entrant d'API; la permission d'invocation est donnee par la stack Pipeline (role de la machine d'etats).
 * Le modele est appele via le profil d'application lu dans SSM `/qcm/<env>/models/sonnet` (stack Models). Pas de VPC.
 */
export class VerifyStack extends Stack {
  readonly fn: NodejsFunction;

  constructor(scope: Construct, id: string, props: VerifyStackProps) {
    super(scope, id, props);
    const { envName } = props;
    // Les parametres SSM lus au deploiement viennent des stacks Models et Data: elles se deploient avant.
    for (const s of ['models', 'data']) {
      const dep = scope.node.tryFindChild(stackName(envName, s));
      if (dep instanceof Stack) this.addStackDependency(dep);
    }
    const profileArn = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'models/sonnet'));
    const uaContact = this.node.tryGetContext('uaContact') as string | undefined; // -c uaContact=...; obligatoire a l'execution en prod
    const table = tableName(envName);
    const tableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table });

    const role = new iam.Role(this, 'Role', { roleName: verifyRoleName(envName), assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), description: 'verify-run: moindre privilege (QCMonster L2b)' });
    const logGroup = new logs.LogGroup(this, 'Logs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    logGroup.grantWrite(role);

    // DynamoDB: seulement les partitions utilisees. Lecture: affirmations, passages, cache, compteur. Ecriture: verdicts (DOC#), passages, cache.
    const leading = (...pks: string[]) => ({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': pks } });
    role.addToPolicy(new iam.PolicyStatement({ sid: 'ReadOwnPartitions', actions: ['dynamodb:GetItem', 'dynamodb:BatchGetItem', 'dynamodb:Query'], resources: [tableArn], conditions: leading('DOC#*', 'PASSAGE#*', 'CLAIMCACHE#*', `COST#${envName}`) }));
    // shortcut: IAM ne separe pas CLAIM# de VERDICT# (LeadingKeys ne filtre que la cle de partition DOC#<docId>, dynamodb:Attributes pas la cle de tri):
    // ce role POURRAIT ecrire CLAIM#. « Jamais CLAIM# » repose sur le code (store.ts, teste), pas sur IAM. A revoir si une table dediee aux verdicts est creee.
    role.addToPolicy(new iam.PolicyStatement({ sid: 'WriteVerdictsPassagesCache', actions: ['dynamodb:PutItem'], resources: [tableArn], conditions: leading('DOC#*', 'PASSAGE#*', 'CLAIMCACHE#*') }));
    role.addToPolicy(new iam.PolicyStatement({ sid: 'AddCost', actions: ['dynamodb:UpdateItem'], resources: [tableArn], conditions: leading(`COST#${envName}`) }));

    // Bedrock: le profil d'application (ARN exact lu dans SSM) et le profil systeme / modele de base qu'il copie, uniquement via ce profil.
    const systemId = SYSTEM_PROFILES.sonnet;
    const baseModel = systemId.replace(/^[a-z]+\./, '');
    role.addToPolicy(new iam.PolicyStatement({ sid: 'InvokeApplicationProfile', actions: ['bedrock:InvokeModel'], resources: [profileArn] }));
    role.addToPolicy(
      new iam.PolicyStatement({
        sid: 'InvokeUnderlyingViaProfile',
        actions: ['bedrock:InvokeModel'],
        resources: [this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: systemId }), `arn:${this.partition}:bedrock:*::foundation-model/${baseModel}`],
        conditions: { StringLike: { 'bedrock:InferenceProfileArn': profileArn } },
      }),
    );

    this.fn = new NodejsFunction(this, 'Fn', {
      functionName: fn(envName, WORKFLOW_HANDLERS.verify),
      entry: fileURLToPath(new URL('../../api/src/verify/handler.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      role,
      memorySize: 512,
      timeout: Duration.minutes(15),
      // Concurrence reservee: avec la limite par instance de api/src/verify/limits.ts, le total reste sous 5 requetes MediaWiki par seconde (revue C7).
      reservedConcurrentExecutions: VERIFY_RESERVED_CONCURRENCY,
      logGroup,
      environment: { QCM_ENV: envName, TABLE_NAME: table, QCM_MODEL_SONNET_ARN: profileArn, ...(uaContact ? { QCM_UA_CONTACT: String(uaContact) } : {}) }, // QCM_BEDROCK absent: faux modele tant que personne ne l'active
      bundling: { format: OutputFormat.ESM, target: 'node22', minify: true, sourceMap: false, mainFields: ['module', 'main'], banner: "import{createRequire}from'module';const require=createRequire(import.meta.url);" },
    });
  }
}
