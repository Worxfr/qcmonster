import { fileURLToPath } from 'node:url';
import { Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as sfn from 'aws-cdk-lib/aws-stepfunctions';
import * as tasks from 'aws-cdk-lib/aws-stepfunctions-tasks';
import type { Construct } from 'constructs';
import { e1Statements } from './e1-access.js';
import { COPIE_INPUT_KEYS } from '../../shared/exo-access.js';
import { EU_REGIONS, SYSTEM_PROFILES } from './models-stack.js';
import { SHARP_LAYER_PARAM } from './pipeline-stack.js';
import { copieRoleName, copieStateMachineName, EXO_FUNCTIONS, exoRoleName, fn, METRIC_NAMESPACE, ssmParam, stackName, tableName, type Env, type ModelKey } from '../../shared/names.js';

export interface ExoStackProps extends StackProps {
  envName: Env;
}

/** Delai de `copie-correct` et de `copie-fail` (secondes) et marge de la tache de la machine. */
export const COPIE_FN_TIMEOUT_S = 120;
export const COPIE_TASK_TIMEOUT_S = 150;
/** Delai global de la machine `copie`: une correction, une reprise, le nettoyage, et une marge. */
export const COPIE_MACHINE_TIMEOUT_MIN = 15;

/**
 * Exercices de raisonnement et correction de copie (E1, docs/E1-design.md sections 5.3, 5.4 et 11).
 * Roles `exo-role` (Haiku seulement) et `copie-role` (Haiku et Sonnet): tous deux appellent Bedrock, donc dans `processingRoleNames`
 * (action du budget securite-40). Droits DynamoDB et S3 DERIVES de shared/exo-access.ts (e1Statements). Les fonctions des routes
 * (`exo-*`, `copie*`, `copies-*`) sont dans la stack Game.
 * Les autres stacks sont referencees par NOM ou par SSM, jamais par import. Depend de Data, Models et Pipeline (couche `sharp`).
 */
export class ExoStack extends Stack {
  constructor(scope: Construct, id: string, props: ExoStackProps) {
    super(scope, id, props);
    const { envName } = props;
    for (const dep of ['data', 'models', 'pipeline']) {
      const s = scope.node.tryFindChild(stackName(envName, dep));
      if (s instanceof Stack) this.addStackDependency(s);
    }
    const bedrockMode = this.node.tryGetContext('bedrock') === 'real' ? 'real' : 'mock'; // meme regle que Pipeline et Verify (-c bedrock=real)
    const table = tableName(envName);
    const tableArn = this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table });
    const scansBucket = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'data/scansBucket'));
    const bucketArn = `arn:${this.partition}:s3:::${scansBucket}`;
    const profile = (m: ModelKey) => ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, `models/${m}`));

    const mkRole = (roleName: string, description: string) => new iam.Role(this, roleName, { roleName, assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com'), description });
    const exoRole = mkRole(exoRoleName(envName), 'exo-gen: generation d\'un exercice, Haiku seulement (QCMonster E1)');
    const copieRole = mkRole(copieRoleName(envName), 'copie-correct et copie-fail: correction d\'une copie, Haiku et Sonnet (QCMonster E1)');

    // DynamoDB et S3 (copies/) selon shared/exo-access.ts. exo-role: aucun S3. copie-role: GetObject et DeleteObject sur copies/*, ni liste ni PutObject.
    for (const [role, key] of [[exoRole, 'exoRole'], [copieRole, 'copieRole']] as const) for (const st of e1Statements(key, { env: envName, tableArn, bucketArn })) role.addToPolicy(st);

    // Alarme de cout de 10 EUR: PutMetricData n'accepte pas de ressource; la condition fixe l'espace de noms (comme verify-role).
    for (const role of [exoRole, copieRole]) role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:PutMetricData'], resources: ['*'], conditions: { StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } } }));

    // Bedrock, MEME construction que pipeline-role: profil d'application, profil systeme UE, et modele de base de chaque region UE du profil
    // seulement quand l'appel passe par ce profil (condition bedrock:InferenceProfileArn).
    const grantModel = (role: iam.Role, m: ModelKey) => {
      const appArn = profile(m);
      const systemArn = this.formatArn({ service: 'bedrock', resource: 'inference-profile', resourceName: SYSTEM_PROFILES[m] });
      const baseId = SYSTEM_PROFILES[m].replace(/^eu\./, '');
      role.addToPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [appArn, systemArn] }));
      role.addToPolicy(
        new iam.PolicyStatement({
          actions: ['bedrock:InvokeModel'],
          resources: EU_REGIONS.map((region) => this.formatArn({ service: 'bedrock', region, account: '', resource: 'foundation-model', resourceName: baseId })),
          conditions: { StringEquals: { 'bedrock:InferenceProfileArn': [appArn, systemArn] } },
        }),
      );
    };
    grantModel(exoRole, 'haiku');
    grantModel(copieRole, 'haiku');
    grantModel(copieRole, 'sonnet'); // la correction de la copie seulement (design 5.4)

    // Fonctions: un fichier par handler (api/src/handlers/<nom>.ts). Journaux de CHAQUE fonction accordes a son role seulement.
    const baseEnv = { TABLE_NAME: table, QCM_ENV: envName, SCANS_BUCKET: scansBucket, QCM_BEDROCK: bedrockMode, QCM_MODEL_HAIKU: profile('haiku') };
    const mk = (name: string, role: iam.Role, o: { memoryMb: number; env?: Record<string, string>; layers?: lambda.ILayerVersion[]; external?: string[] }) => {
      const logGroup = new logs.LogGroup(this, `Logs-${name}`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
      logGroup.grantWrite(role);
      return new NodejsFunction(this, `Fn-${name}`, {
        functionName: fn(envName, name),
        entry: fileURLToPath(new URL(`../../api/src/handlers/${name}.ts`, import.meta.url)),
        handler: 'handler',
        runtime: lambda.Runtime.NODEJS_22_X,
        architecture: lambda.Architecture.ARM_64,
        memorySize: o.memoryMb,
        timeout: Duration.seconds(COPIE_FN_TIMEOUT_S),
        role,
        environment: { ...baseEnv, ...o.env },
        layers: o.layers,
        logGroup,
        bundling: { minify: true, sourceMap: false, target: 'node22', externalModules: o.external ?? [] },
      });
    };
    const sonnetEnv = { QCM_MODEL_SONNET: profile('sonnet') };
    // Couche `sharp` de R1-B (publiee par la stack Pipeline): re-encodage JPEG sans EXIF avant l'appel du modele (design 5.4). Binaire natif: hors du paquet.
    const sharpLayer = lambda.LayerVersion.fromLayerVersionArn(this, 'SharpLayer', ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, SHARP_LAYER_PARAM)));
    const exoGen = mk(EXO_FUNCTIONS.gen, exoRole, { memoryMb: 512 });
    // Appelee en asynchrone par exo-post: pas de reprise automatique de Lambda (un appel de modele rejoue couterait deux fois; le plafond de cout reste a l'appelant).
    exoGen.configureAsyncInvoke({ retryAttempts: 0 });
    const correct = mk(EXO_FUNCTIONS.correct, copieRole, { memoryMb: 1024, env: sonnetEnv, layers: [sharpLayer], external: ['sharp'] });
    const fail = mk(EXO_FUNCTIONS.fail, copieRole, { memoryMb: 256, env: sonnetEnv });

    // --- Machine d'etats Standard `copie` (design 5.3). Entree {copieId, sid, fid, exoRef, pages}: identifiants et nombre de pages, JAMAIS de contenu.
    // Les charges ne reprennent que ces quatre champs; l'erreur n'est pas gardee dans l'etat (resultPath DISCARD): l'historique Step Functions n'a aucun texte d'eleve.
    // Cles derivees de COPIE_INPUT_KEYS (shared/exo-access.ts): une cle de CopieInput ne peut plus etre oubliee (revue #100 B1, `fid`).
    const input = Object.fromEntries(Object.entries(COPIE_INPUT_KEYS).map(([k, t]) => [k, t === 'number' ? sfn.JsonPath.numberAt(`$.${k}`) : sfn.JsonPath.stringAt(`$.${k}`)]));
    const task = (idName: string, f: lambda.IFunction) =>
      new tasks.LambdaInvoke(this, idName, {
        lambdaFunction: f,
        payload: sfn.TaskInput.fromObject(input),
        payloadResponseOnly: true,
        resultPath: sfn.JsonPath.DISCARD,
        retryOnServiceExceptions: false, // reprise explicite ci-dessous: une seule, sinon le cout serait compte plusieurs fois
        taskTimeout: sfn.Timeout.duration(Duration.seconds(COPIE_TASK_TIMEOUT_S)),
      });
    const echec = task('echec', fail).next(new sfn.Fail(this, 'Echec', { error: 'CopieFailed' }));
    const corriger = task('corriger', correct);
    // Une reprise sur erreur de service Lambda ou limitation de debit Bedrock; ni delai (States.Timeout) ni autre erreur: le cout est compte a chaque appel.
    corriger.addRetry({ errors: ['Lambda.ServiceException', 'Lambda.AWSLambdaException', 'Lambda.SdkClientException', 'Lambda.TooManyRequestsException', 'ThrottlingException'], maxAttempts: 1, interval: Duration.seconds(5), backoffRate: 2 });
    corriger.addCatch(echec, { errors: ['States.ALL'], resultPath: sfn.JsonPath.DISCARD });
    const smLogs = new logs.LogGroup(this, 'SmLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    new sfn.StateMachine(this, 'Copie', {
      stateMachineName: copieStateMachineName(envName),
      definitionBody: sfn.DefinitionBody.fromChainable(corriger.next(new sfn.Succeed(this, 'Corrigee'))),
      stateMachineType: sfn.StateMachineType.STANDARD,
      timeout: Duration.minutes(COPIE_MACHINE_TIMEOUT_MIN),
      // Niveau ERROR sans donnees d'execution (design 4.9).
      logs: { destination: smLogs, level: sfn.LogLevel.ERROR, includeExecutionData: false },
    });
  }
}
