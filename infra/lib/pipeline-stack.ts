import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { ArnFormat, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import { buildSync } from 'esbuild';
import type { Construct } from 'constructs';
import { SYSTEM_PROFILES } from './models-stack.js';
import { fn, SCAN_EVENT_PREFIX, ssmParam, stackName, stateMachineName, tableName, WORKFLOW_HANDLERS, type Env } from '../../shared/names.js';

export interface PipelineStackProps extends StackProps {
  envName: Env;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const UPLOAD_TIMEOUT = Duration.minutes(20);
const CONFIRM_TIMEOUT = Duration.minutes(30);

/** Un seul paquet pour toutes les fonctions (une fonction par export de entry.ts). Sortie deterministe: meme empreinte d'asset a chaque synthese. */
let bundleDir: string | undefined;
function bundle(): string {
  if (bundleDir) return bundleDir;
  const out = join(ROOT, 'node_modules', '.cache', 'qcm-pipeline-bundle');
  buildSync({
    entryPoints: [join(ROOT, 'api/src/pipeline/entry.ts')],
    outfile: join(out, 'index.js'),
    bundle: true,
    platform: 'node',
    target: 'node22',
    format: 'cjs',
    legalComments: 'none',
    logLevel: 'error',
  });
  bundleDir = out;
  return out;
}

/** Fonctions HTTP (routes owner=pipeline dans api-stack) et etapes du workflow: nom de fonction -> export de entry.ts. */
export const API_FUNCTIONS = {
  'scans-create': 'scansCreateHandler',
  'jobs-get': 'jobsGetHandler',
  'jobs-transcription': 'jobsTranscriptionHandler',
  'jobs-confirm': 'jobsConfirmHandler',
  'jobs-cancel': 'jobsCancelHandler',
  'docs-read': 'docsReadHandler',
  'docs-delete': 'docsDeleteHandler',
  'docs-report': 'docsReportHandler',
} as const;
export const STEP_FUNCTIONS = {
  scanStart: ['scan-start', 'scanStartHandler'],
  awaitUpload: ['upload-await', 'awaitUploadHandler'],
  scanCheck: [WORKFLOW_HANDLERS.scanCheck, 'scanCheckHandler'],
  transcribe: ['transcribe', 'transcribeHandler'],
  awaitConfirm: ['confirm-await', 'awaitConfirmHandler'],
  expire: ['expire', 'expireHandler'],
  extract: ['extract', 'extractHandler'],
  consume: [WORKFLOW_HANDLERS.consume, 'quotaConsumeHandler'],
  generate: ['generate', 'generateHandler'],
  fail: ['pipeline-fail', 'failHandler'],
} as const;

/**
 * Pipeline de lecture des cours (L2a, design-v2 4.1): fonctions des routes, etapes, machine d'etats, regle EventBridge des photos.
 * Les autres stacks sont referencees par NOM (SSM, noms de fonctions), jamais par import. Cette stack depend de la stack Api
 * (le nom de fonction `qcm-<env>-<handler>` ne doit pas etre deja pris par le squelette).
 * Appels Bedrock: simules tant que `-c bedrock=real` n'est pas passe (QCM_BEDROCK), voir docs/cost-guard.md.
 */
export class PipelineStack extends Stack {
  constructor(scope: Construct, id: string, props: PipelineStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const n = (s: string) => stackName(envName, s);
    for (const dep of ['data', 'api', 'models']) {
      const s = scope.node.tryFindChild(n(dep));
      if (s instanceof Stack) this.addStackDependency(s);
    }
    const ctxBedrock = this.node.tryGetContext('bedrock') as string | undefined;

    const scansBucket = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'data/scansBucket'));
    const haikuArn = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'models/haiku'));
    const apiId = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'api/id'));
    const tableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: tableName(envName) });
    const bucketArn = `arn:${this.partition}:s3:::${scansBucket}`;
    const smArn = this.formatArn({ service: 'states', resource: 'stateMachine', resourceName: stateMachineName(envName), arnFormat: ArnFormat.COLON_RESOURCE_NAME });

    // --- Roles de moindre privilege. Seul `pipeline-role` appelle Bedrock (liste `processingRoleNames`, action du budget securite-40).
    const mkRole = (name: string) => new iam.Role(this, name, { roleName: `qcm-${envName}-${name}`, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    const apiRole = mkRole('pipeline-api-role');
    const triggerRole = mkRole('pipeline-trigger-role');
    const procRole = mkRole('pipeline-role');
    const ddb = (actions: string[]) => new iam.PolicyStatement({ actions, resources: [tableArn, `${tableArn}/index/GSI1`] });
    const rw = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'];
    const objects = `${bucketArn}/${SCAN_EVENT_PREFIX}*`;
    const listScans = new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucketArn], conditions: { StringLike: { 's3:prefix': [`${SCAN_EVENT_PREFIX}*`] } } });
    const sendTask = new iam.PolicyStatement({ actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'], resources: ['*'] }); // l'API n'accepte pas de ressource
    // API: lit/ecrit la table, signe les POST (PutObject), lit et supprime les photos, demarre et reprend la machine.
    apiRole.addToPolicy(ddb(rw));
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:GetObject', 's3:DeleteObject'], resources: [objects] }));
    apiRole.addToPolicy(listScans);
    apiRole.addToPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [smArn] }));
    apiRole.addToPolicy(sendTask);
    // Declencheur S3: compte les fichiers recus, lit le job, reprend la machine.
    triggerRole.addToPolicy(ddb(['dynamodb:GetItem', 'dynamodb:UpdateItem']));
    triggerRole.addToPolicy(sendTask);
    // Etapes: table, photos, Bedrock (profil d'application Haiku, son profil systeme UE et le modele de base). Sonnet est a L2b.
    procRole.addToPolicy(ddb(rw));
    procRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:DeleteObject'], resources: [objects] }));
    procRole.addToPolicy(listScans);
    procRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: [
          haikuArn,
          this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: SYSTEM_PROFILES.haiku }),
          `arn:aws:bedrock:*::foundation-model/${SYSTEM_PROFILES.haiku.replace(/^eu\./, '')}*`, // a verifier au premier deploiement dev (identifiant exact du modele de base)
        ],
      }),
    );

    // --- Fonctions
    const code = lambda.Code.fromAsset(bundle());
    const baseEnv = {
      QCM_ENV: envName,
      QCM_TABLE: tableName(envName),
      QCM_SCANS_BUCKET: scansBucket,
      QCM_MODEL_HAIKU: haikuArn,
      QCM_STATE_MACHINE_ARN: smArn,
      QCM_BEDROCK: ctxBedrock === 'real' ? 'real' : 'mock',
    };
    const mk = (name: string, exportName: string, role: iam.Role, o: { memory?: number; timeout?: Duration } = {}) => {
      const logGroup = new logs.LogGroup(this, `Logs-${name}`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
      logGroup.grantWrite(role);
      return new lambda.Function(this, `Fn-${name}`, {
        functionName: fn(envName, name),
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        handler: `index.${exportName}`,
        code,
        role,
        memorySize: o.memory ?? 256,
        timeout: o.timeout ?? Duration.seconds(15),
        environment: baseEnv,
        logGroup,
      });
    };

    const apiFns = Object.entries(API_FUNCTIONS).map(([name, exp]) => mk(name, exp, apiRole));
    for (const f of apiFns) {
      f.addPermission('ApiGateway', { principal: new iam.ServicePrincipal('apigateway.amazonaws.com'), sourceArn: this.formatArn({ service: 'execute-api', resource: apiId, resourceName: '*/*' }) });
    }
    const S = STEP_FUNCTIONS;
    const fns = {
      scanStart: mk(...S.scanStart, triggerRole),
      awaitUpload: mk(...S.awaitUpload, procRole),
      scanCheck: mk(...S.scanCheck, procRole),
      transcribe: mk(...S.transcribe, procRole, { memory: 512, timeout: Duration.minutes(5) }),
      awaitConfirm: mk(...S.awaitConfirm, procRole),
      expire: mk(...S.expire, procRole),
      extract: mk(...S.extract, procRole, { timeout: Duration.minutes(2) }),
      consume: mk(...S.consume, procRole),
      generate: mk(...S.generate, procRole, { timeout: Duration.minutes(3) }),
      fail: mk(...S.fail, procRole),
    };
    // Les etapes qui reprennent la machine (attente d'envoi, de confirmation) ont besoin de SendTask*.
    procRole.addToPolicy(sendTask);

    // --- Machine d'etats (Standard). Etat = jobId, sid, compteurs; aucun texte de cours (design 4.1, 4.9).
    const call = (id: string, f: lambda.IFunction, payload: Record<string, unknown>, resultPath: string | undefined) =>
      new tasks.LambdaInvoke(this, id, { lambdaFunction: f, payload: sfn.TaskInput.fromObject(payload), payloadResponseOnly: true, resultPath: resultPath ?? sfn.JsonPath.DISCARD, retryOnServiceExceptions: true });
    const waitToken = (id: string, f: lambda.IFunction, timeout: Duration) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: f,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({ jobId: sfn.JsonPath.stringAt('$.jobId'), sid: sfn.JsonPath.stringAt('$.sid'), token: sfn.JsonPath.taskToken }),
        taskTimeout: sfn.Timeout.duration(timeout),
        resultPath: sfn.JsonPath.DISCARD,
      });
    const ids = { jobId: sfn.JsonPath.stringAt('$.jobId'), sid: sfn.JsonPath.stringAt('$.sid') };

    const failed = new sfn.Fail(this, 'Echec', { error: 'PipelineFailed' });
    const markFailed = call('MarquerEchec', fns.fail, { ...ids, error: sfn.JsonPath.objectAt('$.error') }, undefined).next(failed);
    const cancelled = new sfn.Succeed(this, 'Termine-sans-fiche');
    const expired = (id: string, phase: string) => call(id, fns.expire, { ...ids, phase }, undefined).next(cancelled);

    const awaitUpload = waitToken('AttenteEnvoi', fns.awaitUpload, UPLOAD_TIMEOUT);
    const scanCheck = call('ControleFichier', fns.scanCheck, ids, '$.check');
    const transcribe = call('Transcription', fns.transcribe, ids, '$.tr');
    const awaitConfirm = waitToken('AttenteConfirmation', fns.awaitConfirm, CONFIRM_TIMEOUT);
    const extract = call('Extraction', fns.extract, ids, '$.ex');
    const verifyFn = lambda.Function.fromFunctionArn(this, 'VerifyRun', this.formatArn({ service: 'lambda', resource: 'function', resourceName: fn(envName, WORKFLOW_HANDLERS.verify), arnFormat: ArnFormat.COLON_RESOURCE_NAME }));
    const verify = call(
      'Verification',
      verifyFn,
      { jobId: ids.jobId, docId: sfn.JsonPath.stringAt('$.ex.docId'), budgetRestantCentimes: sfn.JsonPath.numberAt('$.ex.budgetRestantCentimes') },
      '$.verify',
    );
    const consume = call('ConsommationQuota', fns.consume, { ...ids, verify: sfn.JsonPath.objectAt('$.verify') }, undefined);
    const generate = call('Generation', fns.generate, ids, undefined);

    // Toute erreur d'etape (hors annulation et delais prevus) finit par le filet `pipeline-fail`; jamais de Retry sur un appel de modele.
    for (const t of [scanCheck, transcribe, extract, verify, consume, generate]) t.addCatch(markFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    awaitUpload.addCatch(expired('ExpirationEnvoi', 'upload'), { errors: ['States.Timeout'], resultPath: sfn.JsonPath.DISCARD });
    awaitUpload.addCatch(cancelled, { errors: ['Cancelled'], resultPath: sfn.JsonPath.DISCARD });
    awaitUpload.addCatch(markFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    awaitConfirm.addCatch(expired('ExpirationConfirmation', 'confirm'), { errors: ['States.Timeout'], resultPath: sfn.JsonPath.DISCARD });
    awaitConfirm.addCatch(cancelled, { errors: ['Cancelled'], resultPath: sfn.JsonPath.DISCARD });
    awaitConfirm.addCatch(markFailed, { errors: ['States.ALL'], resultPath: '$.error' });

    const ok = (path: string) => sfn.Condition.booleanEquals(path, true);
    const definition = awaitUpload
      .next(scanCheck)
      .next(new sfn.Choice(this, 'FichierValide').when(ok('$.check.ok'), transcribe).otherwise(cancelled));
    transcribe.next(new sfn.Choice(this, 'CoursAccepte').when(ok('$.tr.ok'), awaitConfirm.next(extract)).otherwise(cancelled));
    extract.next(new sfn.Choice(this, 'AffirmationsTrouvees').when(ok('$.ex.ok'), verify.next(consume).next(generate).next(new sfn.Succeed(this, 'Fiche-publiee'))).otherwise(cancelled));

    const smLogs = new logs.LogGroup(this, 'SmLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    // L'ARN de la machine est reconstruit par nom (smArn) pour les fonctions: pas de dependance circulaire.
    new sfn.StateMachine(this, 'Process', {
      stateMachineName: stateMachineName(envName),
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.hours(1),
      // Niveau ERROR sans donnees d'execution (design 4.9).
      logs: { destination: smLogs, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });


    // --- Photos deposees (prefixe scans/): l'evenement S3 passe par EventBridge (active par la stack Data).
    new events.Rule(this, 'ScanUploaded', {
      ruleName: `qcm-${envName}-scan-uploaded`,
      eventPattern: { source: ['aws.s3'], detailType: ['Object Created'], detail: { bucket: { name: [scansBucket] }, object: { key: [{ prefix: SCAN_EVENT_PREFIX }] } } },
      targets: [new targets.LambdaFunction(fns.scanStart, { retryAttempts: 2 })],
    });
  }
}
