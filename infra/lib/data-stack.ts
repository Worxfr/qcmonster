import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { DEPLOY_ROLE_NAME, evalRoleName, ssmParam, tableName, type Env } from '../../shared/names.js';

export interface DataStackProps extends StackProps {
  envName: Env;
}

/** Nom de l'attribut TTL DynamoDB (docs/data-model.md). */
export const TTL_ATTRIBUTE = 'ttl';

/** Origine du front (CORS). Obligatoire en prod (`-c webOrigin=https://...`), localhost par defaut en dev. */
export function webOriginFor(scope: Construct, env: Env): string {
  const v = scope.node.tryGetContext('webOrigin') as string | undefined;
  if (v) return v;
  if (env === 'prod') throw new Error('prod: contexte webOrigin obligatoire (cdk ... -c webOrigin=https://<front>)');
  return 'http://localhost:5173';
}

/**
 * Donnees (design-v2 4.8, 5, 10.3 L1): table unique, bucket des scans temporaires, coffre du jeu cache.
 * Pas de PITR (suppression effective immediatement). Les autres stacks referencent la table par NOM
 * et les buckets par parametre SSM (/qcm/<env>/data/...), jamais par import entre stacks.
 */
export class DataStack extends Stack {
  readonly table: dynamodb.Table;
  readonly scansBucket: s3.Bucket;
  readonly vaultBucket: s3.Bucket;
  readonly evalRole: iam.Role;

  constructor(scope: Construct, id: string, props: DataStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const prod = envName === 'prod';

    this.table = new dynamodb.Table(this, 'Table', {
      tableName: tableName(envName),
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      timeToLiveAttribute: TTL_ATTRIBUTE,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: false }, // decision: pas de PITR
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
    });
    this.table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'GSI1PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'GSI1SK', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    const common: s3.BucketProps = {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
    };

    // Photos de cours: gardees 30 min par le workflow, 1 jour au plus par cycle de vie (design 4.1 etape 4).
    // Le POST pre-signe vient du navigateur: CORS limite a l'origine du front (contexte webOrigin).
    const webOrigin = webOriginFor(this, envName);
    this.scansBucket = new s3.Bucket(this, 'Scans', {
      ...common,
      removalPolicy: RemovalPolicy.DESTROY,
      lifecycleRules: [{ id: 'expire-1-day', enabled: true, expiration: Duration.days(1), abortIncompleteMultipartUploadAfter: Duration.days(1) }],
      cors: [{ allowedMethods: [s3.HttpMethods.POST], allowedOrigins: [webOrigin], allowedHeaders: ['*'], maxAge: 600 }],
    });

    // Coffre du jeu cache: jamais supprime avec la stack, lecture par le seul role d'evaluation.
    this.vaultBucket = new s3.Bucket(this, 'Vault', { ...common, removalPolicy: RemovalPolicy.RETAIN });

    this.evalRole = new iam.Role(this, 'EvalRole', {
      roleName: evalRoleName(envName),
      description: 'Lecture du coffre du jeu cache (eval/). Assumable par le seul role de deploiement OIDC, ou par le principal du contexte evalPrincipalArn.',
      // Pas de confiance au root du compte: un principal precis seulement.
      assumedBy: new iam.ArnPrincipal((this.node.tryGetContext('evalPrincipalArn') as string | undefined) ?? this.formatArn({ service: 'iam', region: '', resource: 'role', resourceName: DEPLOY_ROLE_NAME })),
      maxSessionDuration: Duration.hours(1),
    });
    this.evalRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [this.vaultBucket.bucketArn] }));
    this.evalRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [this.vaultBucket.arnForObjects('*')] }));

    // Refus explicite de la lecture pour toute autre identite (meme administrateur): seul le role d'evaluation lit.
    const notEval = { ArnNotLike: { 'aws:PrincipalArn': [this.evalRole.roleArn, this.formatArn({ service: 'sts', resource: 'assumed-role', resourceName: `${evalRoleName(envName)}/*`, region: '' })] } };
    this.vaultBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        sid: 'OnlyEvalRoleReads',
        effect: iam.Effect.DENY,
        principals: [new iam.AnyPrincipal()],
        actions: ['s3:GetObject*', 's3:ListBucket'],
        resources: [this.vaultBucket.bucketArn, this.vaultBucket.arnForObjects('*')],
        conditions: notEval,
      }),
    );

    new ssm.StringParameter(this, 'ParamTable', { parameterName: ssmParam(envName, 'data/tableName'), stringValue: this.table.tableName });
    new ssm.StringParameter(this, 'ParamScans', { parameterName: ssmParam(envName, 'data/scansBucket'), stringValue: this.scansBucket.bucketName });
    new ssm.StringParameter(this, 'ParamVault', { parameterName: ssmParam(envName, 'data/vaultBucket'), stringValue: this.vaultBucket.bucketName });
  }
}
