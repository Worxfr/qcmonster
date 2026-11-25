import { ArnFormat, CfnOutput, Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { webOriginFor } from './data-stack.js';
import { fn, REGION, ssmParam, stackName, type Env } from '../../shared/names.js';

export type Owner = 'skeleton' | 'pipeline' | 'game';
export interface RouteDef {
  route: string;
  handler: string;
  /**
   * Qui fournit la Lambda. `skeleton` (defaut): cette stack cree un squelette 501. `pipeline` (L2a, pipeline-stack) ou
   * `game` (L3, game-stack): le lot cree la fonction `fn(env, handler)` et la permission d'invocation; cette stack garde
   * la route, l'autorisateur et la limitation. Un lot change SEULEMENT l'`owner` de ses lignes, dans sa PR.
   */
  owner?: Owner;
  /** Route sans JWT (activation de l'eleve). */
  public?: boolean;
  throttle?: Throttle;
}

export interface ApiStackProps extends StackProps {
  envName: Env;
  /** Pour les tests; defaut: ROUTES. */
  routes?: ReadonlyArray<RouteDef>;
}

type Throttle = { rate: number; burst: number };

/**
 * Routes du contrat (design-v2 6): route -> handler, limitation par route (requetes/s, rafale).
 * Un test verifie que cette table couvre exactement les routes de shared/contract/openapi.yaml.
 * Les handlers sont des squelettes qui repondent 501 tant que `owner` n'est pas change. Un lot qui implemente un handler
 * met `owner: 'pipeline' | 'game'` sur SA ligne (seul changement dans ce fichier), cree la fonction `fn(env, handler)` dans sa stack,
 * depend de la stack Api, et ajoute la permission d'invocation (principal apigateway, source = API de SSM /qcm/<env>/api/id).
 * Les routes, l'autorisateur et la limitation restent ici (un reglage de limitation pour une route absente ferait echouer le deploiement).
 */
export const ROUTES: ReadonlyArray<RouteDef> = [
  { route: 'POST /scans', handler: 'scans-create', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /jobs/{jobId}', handler: 'jobs-get', owner: 'pipeline', throttle: { rate: 10, burst: 20 } },
  { route: 'GET /jobs/{jobId}/transcription', handler: 'jobs-transcription', owner: 'pipeline' },
  { route: 'POST /jobs/{jobId}/confirm', handler: 'jobs-confirm', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'POST /jobs/{jobId}/cancel', handler: 'jobs-cancel', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /docs', handler: 'docs-read', owner: 'pipeline' },
  { route: 'GET /docs/{docId}', handler: 'docs-read', owner: 'pipeline' },
  { route: 'DELETE /docs/{docId}', handler: 'docs-delete', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'POST /docs/{docId}/report', handler: 'docs-report', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /docs/{docId}/session', handler: 'session-get', owner: 'game' },
  { route: 'POST /answers', handler: 'answers-post', owner: 'game', throttle: { rate: 10, burst: 20 } },
  { route: 'GET /me', handler: 'me-get', owner: 'game' },
  { route: 'GET /me/progress', handler: 'me-get', owner: 'game' },
  { route: 'POST /students', handler: 'students-create', owner: 'game', throttle: { rate: 1, burst: 3 } },
  { route: 'POST /students/{sid}/activation-link', handler: 'students-link', owner: 'game', throttle: { rate: 1, burst: 3 } },
  { route: 'PATCH /students/{sid}', handler: 'students-update', owner: 'game', throttle: { rate: 2, burst: 5 } },
  { route: 'DELETE /students/{sid}', handler: 'students-delete', owner: 'game', throttle: { rate: 1, burst: 3 } },
  { route: 'GET /family/dashboard', handler: 'family-read', owner: 'game' },
  { route: 'GET /family/leaderboard', handler: 'family-read', owner: 'game' },
  { route: 'POST /reports/{id}/validate', handler: 'reports-validate', owner: 'game', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /family/export', handler: 'family-admin', owner: 'game', throttle: { rate: 1, burst: 2 } },
  { route: 'DELETE /family', handler: 'family-admin', owner: 'game', throttle: { rate: 1, burst: 2 } },
  // contract-v1.1 (L1c)
  { route: 'POST /activation', handler: 'activation-post', owner: 'game', public: true, throttle: { rate: 1, burst: 3 } },
  { route: 'POST /docs/{docId}/read', handler: 'docs-mark-read', owner: 'game', throttle: { rate: 5, burst: 10 } },
  { route: 'POST /family', handler: 'family-create', owner: 'game', throttle: { rate: 1, burst: 2 } },
  // contract-v1.2 (A1): reserve au groupe Cognito `admin`, verifie par le handler
  { route: 'POST /admin/invitations', handler: 'admin-invitations', owner: 'game', throttle: { rate: 1, burst: 3 } },
  // contract-v1.3 (FEAT-A): lot I: `owner: 'pipeline'` (fonctions dans pipeline-stack)
  { route: 'GET /scans', handler: 'scans-list', owner: 'pipeline', throttle: { rate: 10, burst: 20 } },
  { route: 'PATCH /docs/{docId}', handler: 'docs-patch', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /folders', handler: 'folders-api', owner: 'pipeline' },
  { route: 'POST /folders', handler: 'folders-api', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'PATCH /folders/{folderId}', handler: 'folders-api', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'DELETE /folders/{folderId}', handler: 'folders-api', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'POST /folders/{folderId}/scans', handler: 'folders-api', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'DELETE /folders/{folderId}/scans/{docId}', handler: 'folders-api', owner: 'pipeline', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /cours/{coursId}', handler: 'cours-api', owner: 'pipeline', throttle: { rate: 5, burst: 10 } },
  { route: 'DELETE /cours/{coursId}', handler: 'cours-delete', owner: 'pipeline', throttle: { rate: 1, burst: 3 } },
];

/** Lot qui fournira chaque handler (information; `owner` reste `skeleton` tant que le lot n'a pas fusionne). */
export const HANDLER_LOT: Record<string, 'L2a' | 'L3' | 'FEAT-A'> = {
  'scans-create': 'L2a', 'jobs-get': 'L2a', 'jobs-transcription': 'L2a', 'jobs-confirm': 'L2a', 'jobs-cancel': 'L2a',
  'docs-read': 'L2a', 'docs-delete': 'L2a', 'docs-report': 'L2a',
  'session-get': 'L3', 'answers-post': 'L3', 'me-get': 'L3', 'students-create': 'L3', 'students-link': 'L3', 'students-update': 'L3',
  'students-delete': 'L3', 'family-read': 'L3', 'reports-validate': 'L3', 'family-admin': 'L3', 'activation-post': 'L3', 'docs-mark-read': 'L3', 'family-create': 'L3', 'admin-invitations': 'L3',
  'scans-list': 'FEAT-A', 'docs-patch': 'FEAT-A', 'folders-api': 'FEAT-A', 'cours-api': 'FEAT-A', 'cours-delete': 'FEAT-A',
};

/** Limite par defaut (par route) pour une route sans limite propre. Pas de plafond global ni par utilisateur: le quota de pages s'en charge (design 4.8). */
export const DEFAULT_THROTTLE: Throttle = { rate: 5, burst: 10 };

// Limite: 'non_implemente' n'est pas dans l'enum Error du contrat; disparait avec les squelettes.
const SKELETON_CODE = `exports.handler = async () => ({
  statusCode: 501,
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify({ code: 'non_implemente', message: 'Route pas encore implementee' }),
});`;

/** API HTTP (design-v2 4.8, 6): autorisateur JWT Cognito, CORS restreint, limitation par route. */
export class ApiStack extends Stack {
  readonly api: apigwv2.HttpApi;

  constructor(scope: Construct, id: string, props: ApiStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const routes = props.routes ?? ROUTES;

    // Auth publie ses identifiants dans SSM: lecture au deploiement, pas d'import entre stacks.
    const userPoolId = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'auth/userPoolId'));
    const clientId = ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, 'auth/webClientId'));
    const auth = scope.node.tryFindChild(stackName(envName, 'auth'));
    if (auth instanceof Stack) this.addStackDependency(auth);

    const webOrigin = webOriginFor(this, envName);

    const authorizer = new HttpJwtAuthorizer('Cognito', Fn.join('', [`https://cognito-idp.${REGION}.amazonaws.com/`, userPoolId]), {
      jwtAudience: [clientId],
      identitySource: ['$request.header.Authorization'],
    });

    this.api = new apigwv2.HttpApi(this, 'Api', {
      apiName: `qcm-${envName}`,
      createDefaultStage: false,
      defaultAuthorizer: authorizer,
      corsPreflight: {
        allowOrigins: [webOrigin],
        allowMethods: [apigwv2.CorsHttpMethod.GET, apigwv2.CorsHttpMethod.POST, apigwv2.CorsHttpMethod.PATCH, apigwv2.CorsHttpMethod.DELETE],
        allowHeaders: ['authorization', 'content-type'],
        maxAge: Duration.hours(1),
      },
    });

    const handlers = new Map<string, lambda.Function>();
    for (const { handler, owner } of routes) {
      if ((owner ?? 'skeleton') !== 'skeleton' || handlers.has(handler)) continue;
      handlers.set(
        handler,
        new lambda.Function(this, `Fn-${handler}`, {
          functionName: fn(envName, handler),
          runtime: lambda.Runtime.NODEJS_22_X,
          architecture: lambda.Architecture.ARM_64,
          handler: 'index.handler',
          code: lambda.Code.fromInline(SKELETON_CODE),
          memorySize: 128,
          timeout: Duration.seconds(10),
          logGroup: new logs.LogGroup(this, `Logs-${handler}`, { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY }),
        }),
      );
    }
    // Fonction d'un lot: referencee par son NOM (pas d'import entre stacks), sans permission ici (le lot l'ajoute,
    // car la fonction n'existe pas encore quand cette stack se deploie). Les stacks de lot dependent de cette stack.
    const externals = new Map<string, lambda.IFunction>(); // une fonction par handler (docs-read sert deux routes)
    const external = (handler: string): lambda.IFunction =>
      externals.get(handler) ??
      externals
        .set(
          handler,
          lambda.Function.fromFunctionAttributes(this, `Ext-${handler}`, {
        functionArn: this.formatArn({ service: 'lambda', resource: 'function', resourceName: fn(envName, handler), arnFormat: ArnFormat.COLON_RESOURCE_NAME }),
        skipPermissions: true,
      }),
        )
        .get(handler)!;
    for (const { route, handler, owner, public: isPublic } of routes) {
      const [method, path] = route.split(' ') as [keyof typeof apigwv2.HttpMethod, string];
      const target = (owner ?? 'skeleton') === 'skeleton' ? handlers.get(handler)! : external(handler);
      this.api.addRoutes({
        path,
        methods: [apigwv2.HttpMethod[method]],
        integration: new HttpLambdaIntegration(`Int-${handler}`, target),
        authorizer: isPublic ? new apigwv2.HttpNoneAuthorizer() : undefined,
      });
    }

    // Journal d'acces SANS corps ni parametres de requete (design 4.9): route, statut, duree seulement.
    const accessLogs = new logs.LogGroup(this, 'AccessLogs', { retention: logs.RetentionDays.TWO_WEEKS, removalPolicy: RemovalPolicy.DESTROY });
    const stage = new apigwv2.HttpStage(this, 'Stage', {
      httpApi: this.api,
      stageName: 'v1',
      autoDeploy: true,
      throttle: { rateLimit: DEFAULT_THROTTLE.rate, burstLimit: DEFAULT_THROTTLE.burst }, // reglage par defaut de chaque route
    });
    // Les reglages par route exigent que les routes existent deja: l'etape attend toute l'API (routes comprises).
    stage.node.addDependency(this.api);
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({ requestId: '$context.requestId', routeKey: '$context.routeKey', status: '$context.status', requestTime: '$context.requestTime', responseLatency: '$context.responseLatency' }),
    };
    cfnStage.routeSettings = Object.fromEntries(
      routes.map(({ route, throttle }) => [route, { ThrottlingRateLimit: (throttle ?? DEFAULT_THROTTLE).rate, ThrottlingBurstLimit: (throttle ?? DEFAULT_THROTTLE).burst }]),
    );

    new CfnOutput(this, 'ApiUrl', { value: stage.url! });

    new ssm.StringParameter(this, 'ParamApiId', { parameterName: ssmParam(envName, 'api/id'), stringValue: this.api.apiId });
    new ssm.StringParameter(this, 'ParamApiUrl', { parameterName: ssmParam(envName, 'api/url'), stringValue: stage.url });
  }
}
