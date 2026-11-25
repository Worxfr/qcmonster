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
import { EU_REGIONS, SYSTEM_PROFILES } from './models-stack.js';
import { CONFIRM_TIMEOUT_S, MACHINE_TIMEOUT_MIN_S, MAX_SECTIONS, machineTimeoutNeededS } from '../../shared/scans.js';
import { fn, METRIC_NAMESPACE, SCAN_EVENT_PREFIX, ssmParam, stackName, stateMachineName, tableName, WORKFLOW_HANDLERS, type Env } from '../../shared/names.js';

export interface PipelineStackProps extends StackProps {
  envName: Env;
}

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const CONFIRM_TIMEOUT = Duration.seconds(CONFIRM_TIMEOUT_S); // 12 h, source unique: shared/scans.ts
/** Delai par tache (secondes): chaque etape de traitement a le sien, plus court que le delai global de la machine. */
export const TASK_TIMEOUT_S = { scanCheck: 60, transcribe: 360, sectionsPlan: 60, extract: 180, verify: 960, sectionCost: 60, consume: 60, generate: 240, finalize: 60, fail: 60, expire: 60 } as const;
export const UPLOAD_TIMEOUT_S = 20 * 60;
/** Marge ajoutee au chemin le plus long (transitions, demarrages a froid). */
const MACHINE_MARGIN_S = 3600;
/**
 * Delai global de la machine, derive de `CONFIRM_TIMEOUT_S`: envoi + controle + lecture + confirmation + plan + `MAX_SECTIONS` x (extraction + verification
 * + cout + generation) + quota + fin, plus une marge, et jamais moins de `MACHINE_TIMEOUT_MIN_S` (16 h). Un delai trop court finirait en `TIMED_OUT`, que ni
 * `Catch` ni l'etape `expire` ne rattrapent (job `a_confirmer` jusqu'au TTL, pages non rendues).
 */
export function machineTimeoutS(confirmS: number = CONFIRM_TIMEOUT_S): number {
  const T = TASK_TIMEOUT_S;
  const needed = machineTimeoutNeededS({
    uploadS: UPLOAD_TIMEOUT_S,
    transcribeS: T.scanCheck + T.transcribe + T.sectionsPlan + T.consume + T.finalize,
    confirmS,
    sections: MAX_SECTIONS,
    perSectionS: T.extract + T.verify + T.sectionCost + T.generate,
  });
  return Math.max(MACHINE_TIMEOUT_MIN_S, needed + MACHINE_MARGIN_S);
}
export const MACHINE_TIMEOUT = Duration.seconds(machineTimeoutS());

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
  // FEAT-A (lot I). Exports de entry.ts: scansListHandler, docsPatchHandler, foldersHandler, coursHandler (PR B2). Un test (pipeline.test.ts) les compare au fichier.
  'scans-list': 'scansListHandler',
  'docs-patch': 'docsPatchHandler',
  'folders-api': 'foldersHandler',
  'cours-api': 'coursHandler',
  // Meme export `coursHandler`, autre fonction: seule la route DELETE /cours/{coursId} y passe, avec le seul role qui peut supprimer (GET reste en lecture seule).
  'cours-delete': 'coursHandler',
} as const;
export const STEP_FUNCTIONS = {
  scanStart: ['scan-start', 'scanStartHandler'],
  awaitUpload: ['upload-await', 'awaitUploadHandler'],
  scanCheck: [WORKFLOW_HANDLERS.scanCheck, 'scanCheckHandler'],
  transcribe: ['transcribe', 'transcribeHandler'],
  awaitConfirm: ['confirm-await', 'awaitConfirmHandler'],
  expire: ['expire', 'expireHandler'],
  sectionsPlan: ['sections-plan', 'sectionsPlanHandler'],
  extract: ['extract', 'extractHandler'],
  sectionCost: ['section-cost', 'sectionCostHandler'],
  consume: [WORKFLOW_HANDLERS.consume, 'quotaConsumeHandler'],
  generate: ['generate', 'generateHandler'],
  finalize: ['finalize', 'finalizeHandler'],
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
    // C2: trois roles pour les 8 fonctions HTTP (lecture, ecriture, suppression), comme game-stack.
    const readRole = mkRole('pipeline-api-read-role');
    const writeRole = mkRole('pipeline-api-write-role');
    const confirmRole = mkRole('pipeline-api-confirm-role');
    const listRole = mkRole('pipeline-api-list-role');
    const deleteRole = mkRole('pipeline-api-delete-role');
    // FEAT-A: roles etroits (un role par fonction qui n'a pas besoin des droits des trois roles ci-dessus).
    const patchRole = mkRole('pipeline-api-patch-role');
    const foldersRole = mkRole('pipeline-api-folders-role');
    const coursReadRole = mkRole('pipeline-api-cours-read-role');
    const coursRole = mkRole('pipeline-api-cours-role');
    const triggerRole = mkRole('pipeline-trigger-role');
    const procRole = mkRole('pipeline-role');
    const ddb = (actions: string[]) => new iam.PolicyStatement({ actions, resources: [tableArn, `${tableArn}/index/GSI1`] });
    const rw = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:DeleteItem', 'dynamodb:Query', 'dynamodb:BatchWriteItem'];
    // Les fonctions HTTP ne touchent que ces partitions (famille, eleve, fiche, job): `dynamodb:LeadingKeys` ecarte COST#, INVITE#, ACTIVATION#, PASSAGE#...
    // shortcut: IAM filtre la cle de partition, pas la cle de tri; le code et ses tests restent la garde des types d'elements. A resserrer si les partitions changent.
    const ddbApi = (actions: string[]) =>
      new iam.PolicyStatement({ actions, resources: [tableArn, `${tableArn}/index/GSI1`], conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['FAMILY#*', 'STUDENT#*', 'DOC#*', 'JOB#*'] } } });
    const objects = `${bucketArn}/${SCAN_EVENT_PREFIX}*`;
    const listScans = new iam.PolicyStatement({ actions: ['s3:ListBucket'], resources: [bucketArn], conditions: { StringLike: { 's3:prefix': [`${SCAN_EVENT_PREFIX}*`] } } });
    const sendTask = new iam.PolicyStatement({ actions: ['states:SendTaskSuccess', 'states:SendTaskFailure'], resources: ['*'] }); // l'API n'accepte pas de ressource
    // API: lit/ecrit la table, signe les POST (PutObject), lit et supprime les photos, demarre et reprend la machine.
    // Lecture (jobs-get, jobs-transcription, docs-read): lit la table, liste et signe la lecture des photos. Rien d'autre.
    readRole.addToPolicy(ddbApi(['dynamodb:GetItem', 'dynamodb:Query']));
    readRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject'], resources: [objects] }));
    readRole.addToPolicy(listScans);
    // Ecriture (scans-create, jobs-confirm, jobs-cancel, docs-report): ecrit des elements, signe le depot (PutObject), efface les photos d'un job annule, pilote la machine.
    const grantWrite = (role: iam.Role) => {
      role.addToPolicy(ddbApi(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem']));
      // scans-create lit le compteur de cout (garde de budget): lecture seule de COST#<env>, aucune ecriture. Sans cela, POST /v1/scans repond 500 (AccessDenied).
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['dynamodb:GetItem'],
          resources: [tableArn],
          conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`COST#${envName}`] }, Null: { 'dynamodb:LeadingKeys': 'false' } },
        }),
      );
      role.addToPolicy(new iam.PolicyStatement({ actions: ['s3:PutObject', 's3:DeleteObject'], resources: [objects] }));
      role.addToPolicy(listScans);
      role.addToPolicy(new iam.PolicyStatement({ actions: ['states:StartExecution'], resources: [smArn] }));
      role.addToPolicy(sendTask);
    };
    grantWrite(writeRole);
    // jobs-confirm: memes droits que l'ecriture, plus la suppression du cours durable et de la copie de travail (`deleteCoursTree`: COURS#<id>, COURS#<id>#Tnn sous STUDENT#, TEXT#nn sous JOB#),
    // pour nettoyer si la confirmation perd la course contre l'annulation ou l'expiration. BatchWriteItem seulement: le code n'appelle jamais DeleteItem.
    // shortcut: IAM ne filtre pas la cle de tri; ce role peut donc supprimer tout element des partitions STUDENT# et JOB#. Le code et ses tests restent la garde. A resserrer si ces elements changent de partition.
    grantWrite(confirmRole);
    // Suppression (docs-delete): lit pour verifier l'appartenance, supprime la fiche et le texte lu. Aucune photo, aucune ecriture.
    deleteRole.addToPolicy(ddbApi(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:DeleteItem', 'dynamodb:BatchWriteItem']));
    // FEAT-A. Toutes les conditions portent sur la cle de partition (IAM ne filtre pas la cle de tri: le code et ses tests gardent les types d'elements).
    const leading = (actions: string[], ...pks: string[]) =>
      new iam.PolicyStatement({ actions, resources: [tableArn, `${tableArn}/index/GSI1`], conditions: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': pks } } });
    confirmRole.addToPolicy(leading(['dynamodb:BatchWriteItem'], 'STUDENT#*', 'JOB#*'));
    // `callerOf` (api/src/pipeline/http.ts) lit FAMILY#<fid> (Query, prefixe STUDENT#) a chaque requete d'un eleve pour retrouver son identifiant: toute fonction ouverte a l'eleve a ce droit.
    // shortcut: IAM ne filtre pas la cle de tri, donc cette Query donne aussi acces a FAMILY#/META, REPORT#, QUOTA#. Le code ne lit que STUDENT#; a resserrer si l'identite de l'eleve passe par le jeton.
    const familyQuery = () => leading(['dynamodb:Query'], 'FAMILY#*');
    // scans-list: lecture des elements DynamoDB seulement (ni S3, ni ecriture).
    listRole.addToPolicy(leading(['dynamodb:GetItem', 'dynamodb:Query'], 'FAMILY#*', 'STUDENT#*'));
    // docs-patch (PATCH /docs/{docId}): eleve seulement. `callerOf` + un seul UpdateItem conditionnel `attribute_exists(PK)` sur STUDENT#. Pas de GetItem, ni PutItem (creerait ou ecraserait une fiche), pas de S3.
    patchRole.addToPolicy(familyQuery());
    patchRole.addToPolicy(leading(['dynamodb:UpdateItem'], 'STUDENT#*'));
    // folders-api (5 routes): dossiers FOLDER# et fiches rangees, sous FAMILY#/STUDENT#. Ni S3, ni Bedrock, ni Step Functions.
    // La suppression passe par `ctx.db.remove` = BatchWriteItem (ports.ts), jamais DeleteItem.
    foldersRole.addToPolicy(leading(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'], 'FAMILY#*', 'STUDENT#*'));
    // cours-api GET: lecture seule de COURS# (partition STUDENT#). Le parent n'a aucun droit.
    coursReadRole.addToPolicy(familyQuery());
    coursReadRole.addToPolicy(leading(['dynamodb:GetItem', 'dynamodb:Query'], 'STUDENT#*'));
    // cours-delete: supprime le cours (STUDENT#), l'arbre de chaque fiche (DOC#), la copie de travail (JOB#), retire coursId (UpdateItem) et supprime les signalements (FAMILY#: Query + BatchWriteItem). Pas de PutItem, S3, Bedrock.
    coursRole.addToPolicy(leading(['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', 'dynamodb:BatchWriteItem'], 'STUDENT#*', 'DOC#*', 'JOB#*'));
    coursRole.addToPolicy(leading(['dynamodb:Query', 'dynamodb:BatchWriteItem'], 'FAMILY#*'));
    // Declencheur S3: compte les fichiers recus, lit le job, reprend la machine.
    triggerRole.addToPolicy(ddb(['dynamodb:GetItem', 'dynamodb:UpdateItem']));
    triggerRole.addToPolicy(sendTask);
    // Etapes: table, photos, Bedrock (profil d'application Haiku, son profil systeme UE et le modele de base). Sonnet est a L2b.
    procRole.addToPolicy(ddb(rw));
    procRole.addToPolicy(new iam.PolicyStatement({ actions: ['s3:GetObject', 's3:DeleteObject'], resources: [objects] }));
    procRole.addToPolicy(listScans);
    // Alarme de cout de 10 EUR (budget-stack): `costStoreFromDynamo` publie le total du mois. PutMetricData n'accepte pas de ressource: la condition fixe l'espace de noms.
    // Seuls les deux roles qui ecrivent le compteur de cout (celui-ci et verify-run) l'ont.
    procRole.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } } }));
    // Bedrock: profil d'application Haiku + son profil systeme UE; modele de base seulement dans les regions UE du profil et
    // seulement quand l'appel passe par ce profil (condition bedrock:InferenceProfileArn). Identifiant du modele: exact, tire du profil.
    // A verifier au premier deploiement dev (identifiant exact du modele de base, regions du profil `eu.`).
    const systemProfileArn = this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: SYSTEM_PROFILES.haiku });
    const baseModelId = SYSTEM_PROFILES.haiku.replace(/^eu\./, '');
    procRole.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [haikuArn, systemProfileArn] }));
    procRole.addToPolicy(
      new iam.PolicyStatement({
        actions: ['bedrock:InvokeModel'],
        resources: EU_REGIONS.map((region) => this.formatArn({ service: 'bedrock', region, account: '', resource: 'foundation-model', resourceName: baseModelId })),
        conditions: { StringEquals: { 'bedrock:InferenceProfileArn': [haikuArn, systemProfileArn] } },
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

    const apiRoleOf: Record<keyof typeof API_FUNCTIONS, iam.Role> = {
      'scans-create': writeRole, 'jobs-confirm': confirmRole, 'jobs-cancel': writeRole, 'docs-report': writeRole,
      'jobs-get': readRole, 'jobs-transcription': readRole, 'docs-read': readRole,
      'docs-delete': deleteRole,
      'scans-list': listRole,
      'docs-patch': patchRole,
      'folders-api': foldersRole,
      'cours-api': coursReadRole,
      'cours-delete': coursRole,
    };
    // Delais propres: dossiers et suppression de cours (lots de 25, reprenable par un second DELETE) 30 s.
    const apiTimeout: Partial<Record<keyof typeof API_FUNCTIONS, Duration>> = { 'folders-api': Duration.seconds(30), 'cours-api': Duration.seconds(30), 'cours-delete': Duration.seconds(30) };
    const apiFns = (Object.entries(API_FUNCTIONS) as [keyof typeof API_FUNCTIONS, string][]).map(([name, exp]) => mk(name, exp, apiRoleOf[name], { timeout: apiTimeout[name] }));
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
      expire: mk(...S.expire, procRole, { timeout: Duration.seconds(60) }),
      sectionsPlan: mk(...S.sectionsPlan, procRole, { timeout: Duration.seconds(60) }),
      extract: mk(...S.extract, procRole, { timeout: Duration.minutes(2) }),
      consume: mk(...S.consume, procRole, { timeout: Duration.seconds(60) }),
      sectionCost: mk(...S.sectionCost, procRole, { timeout: Duration.seconds(60) }),
      generate: mk(...S.generate, procRole, { timeout: Duration.minutes(3) }),
      finalize: mk(...S.finalize, procRole, { timeout: Duration.seconds(60) }),
      fail: mk(...S.fail, procRole, { timeout: Duration.seconds(60) }),
    };
    // Les etapes qui reprennent la machine (attente d'envoi, de confirmation) ont besoin de SendTask*.
    procRole.addToPolicy(sendTask);

    // --- Machine d'etats (Standard). Etat = jobId, sid, compteurs; aucun texte de cours (design 4.1, 4.9).
    // `retry`: seulement pour les etapes qui rejouees ne coutent rien et ne changent rien (voir steps.ts). Jamais sur un appel de modele.
    const call = (id: string, f: lambda.IFunction, payload: Record<string, unknown>, resultPath: string | undefined, timeoutS: number, retry = false) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: f,
        payload: sfn.TaskInput.fromObject(payload),
        payloadResponseOnly: true,
        resultPath: resultPath ?? sfn.JsonPath.DISCARD,
        retryOnServiceExceptions: retry,
        taskTimeout: sfn.Timeout.duration(Duration.seconds(timeoutS)),
      });
    const waitToken = (id: string, f: lambda.IFunction, timeout: Duration) =>
      new tasks.LambdaInvoke(this, id, {
        lambdaFunction: f,
        integrationPattern: sfn.IntegrationPattern.WAIT_FOR_TASK_TOKEN,
        payload: sfn.TaskInput.fromObject({ jobId: sfn.JsonPath.stringAt('$.jobId'), sid: sfn.JsonPath.stringAt('$.sid'), token: sfn.JsonPath.taskToken }),
        taskTimeout: sfn.Timeout.duration(timeout),
        resultPath: sfn.JsonPath.DISCARD,
        retryOnServiceExceptions: false,
      });
    const ok = (path: string) => sfn.Condition.booleanEquals(path, true);
    const ids = { jobId: sfn.JsonPath.stringAt('$.jobId'), sid: sfn.JsonPath.stringAt('$.sid') };

    const failed = new sfn.Fail(this, 'Echec', { error: 'PipelineFailed' });
    const markFailed = call('MarquerEchec', fns.fail, { ...ids, error: sfn.JsonPath.objectAt('$.error') }, undefined, TASK_TIMEOUT_S.fail, true).next(failed);
    const cancelled = new sfn.Succeed(this, 'Termine-sans-fiche');
    const expired = (id: string, phase: string) => call(id, fns.expire, { ...ids, phase }, undefined, TASK_TIMEOUT_S.expire, true).next(cancelled);

    const awaitUpload = waitToken('AttenteEnvoi', fns.awaitUpload, Duration.seconds(UPLOAD_TIMEOUT_S));
    const scanCheck = call('ControleFichier', fns.scanCheck, ids, '$.check', TASK_TIMEOUT_S.scanCheck, true);
    const transcribe = call('Transcription', fns.transcribe, ids, '$.tr', TASK_TIMEOUT_S.transcribe);
    const awaitConfirm = waitToken('AttenteConfirmation', fns.awaitConfirm, CONFIRM_TIMEOUT);
    // Sections (FEAT-A): `sectionsPlan` liste les sections gardees; un premier `Map` (une a la fois, pour que le plafond de cout s'additionne dans l'ordre)
    // extrait, verifie et compte le cout; apres le quota (une seule fois), un second `Map` genere une fiche par section; `finalize` ferme le job.
    const withIndex = { ...ids, index: sfn.JsonPath.numberAt('$.index') };
    const verifyFn = lambda.Function.fromFunctionArn(this, 'VerifyRun', this.formatArn({ service: 'lambda', resource: 'function', resourceName: fn(envName, WORKFLOW_HANDLERS.verify), arnFormat: ArnFormat.COLON_RESOURCE_NAME }));
    const sectionsPlan = call('PlanSections', fns.sectionsPlan, ids, '$.plan', TASK_TIMEOUT_S.sectionsPlan, true);
    const extract = call('Extraction', fns.extract, withIndex, '$.ex', TASK_TIMEOUT_S.extract);
    const verify = call(
      'Verification',
      verifyFn,
      { jobId: ids.jobId, docId: sfn.JsonPath.stringAt('$.ex.docId'), budgetRestantCentimes: sfn.JsonPath.numberAt('$.ex.budgetRestantCentimes') },
      '$.verify',
      TASK_TIMEOUT_S.verify,
    );
    // Ajoute le cout de verify-run au job, une seule fois par docId (idempotent: reprenable).
    const sectionCost = call('CoutSection', fns.sectionCost, { ...withIndex, docId: sfn.JsonPath.stringAt('$.ex.docId'), verify: sfn.JsonPath.objectAt('$.verify') }, '$.cost', TASK_TIMEOUT_S.sectionCost, true);
    const sectionDone = new sfn.Pass(this, 'SectionTraitee', { parameters: { index: sfn.JsonPath.numberAt('$.index'), ok: true } });
    const sectionEmpty = new sfn.Pass(this, 'SectionSansFiche', { parameters: { index: sfn.JsonPath.numberAt('$.index'), ok: false } });
    const sectionChain = extract.next(new sfn.Choice(this, 'AffirmationsTrouvees').when(sfn.Condition.and(ok('$.ex.ok'), sfn.Condition.numberGreaterThan('$.ex.claims', 0)), verify.next(sectionCost).next(sectionDone)).otherwise(sectionEmpty));
    const eachSection = (id: string, resultPath: string) => new sfn.Map(this, id, { itemsPath: '$.plan.indices', maxConcurrency: 1, itemSelector: { ...ids, index: sfn.JsonPath.objectAt('$$.Map.Item.Value') }, resultPath });
    const extractAll = eachSection('Sections-extraction', '$.sections').itemProcessor(sectionChain);
    // Quota consomme une seule fois pour tout le scan. `ok: false` = aucune section avec fiche: le job est rejete et le quota rendu par le pas, la machine s'arrete.
    const consume = call('ConsommationQuota', fns.consume, ids, '$.consume', TASK_TIMEOUT_S.consume, true);
    const generate = call('Generation', fns.generate, withIndex, undefined, TASK_TIMEOUT_S.generate);
    const generateAll = eachSection('Sections-generation', sfn.JsonPath.DISCARD).itemProcessor(generate);
    const finalize = call('Finalisation', fns.finalize, ids, undefined, TASK_TIMEOUT_S.finalize, true);

    // Toute erreur d'etape (hors annulation et delais prevus) finit par le filet `pipeline-fail`; pas de Retry sur un appel de modele.
    // Les etapes des deux Map sont couvertes par le Catch du Map lui-meme (un Catch ne sort pas d'un Map).
    for (const t of [scanCheck, transcribe, sectionsPlan, extractAll, consume, generateAll, finalize]) t.addCatch(markFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    awaitUpload.addCatch(expired('ExpirationEnvoi', 'upload'), { errors: ['States.Timeout'], resultPath: sfn.JsonPath.DISCARD });
    awaitUpload.addCatch(cancelled, { errors: ['Cancelled'], resultPath: sfn.JsonPath.DISCARD });
    awaitUpload.addCatch(markFailed, { errors: ['States.ALL'], resultPath: '$.error' });
    awaitConfirm.addCatch(expired('ExpirationConfirmation', 'confirm'), { errors: ['States.Timeout'], resultPath: sfn.JsonPath.DISCARD });
    awaitConfirm.addCatch(cancelled, { errors: ['Cancelled'], resultPath: sfn.JsonPath.DISCARD });
    awaitConfirm.addCatch(markFailed, { errors: ['States.ALL'], resultPath: '$.error' });

    const definition = awaitUpload
      .next(scanCheck)
      .next(new sfn.Choice(this, 'FichierValide').when(ok('$.check.ok'), transcribe).otherwise(cancelled));
    transcribe.next(new sfn.Choice(this, 'CoursAccepte').when(ok('$.tr.ok'), awaitConfirm.next(sectionsPlan).next(extractAll).next(consume)).otherwise(cancelled));
    consume.next(new sfn.Choice(this, 'FichesAPublier').when(sfn.Condition.and(sfn.Condition.isPresent('$.consume.ok'), ok('$.consume.ok')), generateAll.next(finalize).next(new sfn.Succeed(this, 'Fiche-publiee'))).otherwise(cancelled));

    const smLogs = new logs.LogGroup(this, 'SmLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    // L'ARN de la machine est reconstruit par nom (smArn) pour les fonctions: pas de dependance circulaire.
    new sfn.StateMachine(this, 'Process', {
      stateMachineName: stateMachineName(envName),
      definitionBody: sfn.DefinitionBody.fromChainable(definition),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: MACHINE_TIMEOUT,
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
