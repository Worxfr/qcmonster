import { Duration, Fn, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as apigwv2 from 'aws-cdk-lib/aws-apigatewayv2';
import { HttpJwtAuthorizer } from 'aws-cdk-lib/aws-apigatewayv2-authorizers';
import { HttpLambdaIntegration } from 'aws-cdk-lib/aws-apigatewayv2-integrations';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { webOriginFor } from './data-stack.js';
import { fn, REGION, ssmParam, stackName, type Env } from '../../shared/names.js';

export interface ApiStackProps extends StackProps {
  envName: Env;
}

type Throttle = { rate: number; burst: number };

/**
 * Routes du contrat (design-v2 6): route -> handler, limitation par route (requetes/s, rafale).
 * Un test verifie que cette table couvre exactement les routes de shared/contract/openapi.yaml.
 * Les handlers sont des squelettes qui repondent 501; un lot qui implemente un handler remplace le squelette
 * par une PR vers le proprietaire du lot 1 (ou cree la route lui-meme sur l'API importee, SSM /qcm/<env>/api/id).
 */
export const ROUTES: ReadonlyArray<{ route: string; handler: string; throttle?: Throttle }> = [
  { route: 'POST /scans', handler: 'scans-create', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /jobs/{jobId}', handler: 'jobs-get', throttle: { rate: 10, burst: 20 } },
  { route: 'GET /jobs/{jobId}/transcription', handler: 'jobs-transcription' },
  { route: 'POST /jobs/{jobId}/confirm', handler: 'jobs-confirm', throttle: { rate: 2, burst: 5 } },
  { route: 'POST /jobs/{jobId}/cancel', handler: 'jobs-cancel', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /docs', handler: 'docs-read' },
  { route: 'GET /docs/{docId}', handler: 'docs-read' },
  { route: 'DELETE /docs/{docId}', handler: 'docs-delete', throttle: { rate: 2, burst: 5 } },
  { route: 'POST /docs/{docId}/report', handler: 'docs-report', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /docs/{docId}/session', handler: 'session-get' },
  { route: 'POST /answers', handler: 'answers-post', throttle: { rate: 10, burst: 20 } },
  { route: 'GET /me', handler: 'me-get' },
  { route: 'GET /me/progress', handler: 'me-get' },
  { route: 'POST /students', handler: 'students-create', throttle: { rate: 1, burst: 3 } },
  { route: 'POST /students/{sid}/activation-link', handler: 'students-link', throttle: { rate: 1, burst: 3 } },
  { route: 'PATCH /students/{sid}', handler: 'students-update', throttle: { rate: 2, burst: 5 } },
  { route: 'DELETE /students/{sid}', handler: 'students-delete', throttle: { rate: 1, burst: 3 } },
  { route: 'GET /family/dashboard', handler: 'family-read' },
  { route: 'GET /family/leaderboard', handler: 'family-read' },
  { route: 'POST /reports/{id}/validate', handler: 'reports-validate', throttle: { rate: 2, burst: 5 } },
  { route: 'GET /family/export', handler: 'family-admin', throttle: { rate: 1, burst: 2 } },
  { route: 'DELETE /family', handler: 'family-admin', throttle: { rate: 1, burst: 2 } },
];

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
    for (const { handler } of ROUTES) {
      if (handlers.has(handler)) continue;
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
    for (const { route, handler } of ROUTES) {
      const [method, path] = route.split(' ') as [keyof typeof apigwv2.HttpMethod, string];
      this.api.addRoutes({
        path,
        methods: [apigwv2.HttpMethod[method]],
        integration: new HttpLambdaIntegration(`Int-${handler}`, handlers.get(handler)!),
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
    const cfnStage = stage.node.defaultChild as apigwv2.CfnStage;
    cfnStage.accessLogSettings = {
      destinationArn: accessLogs.logGroupArn,
      format: JSON.stringify({ requestId: '$context.requestId', routeKey: '$context.routeKey', status: '$context.status', requestTime: '$context.requestTime', responseLatency: '$context.responseLatency' }),
    };
    cfnStage.routeSettings = Object.fromEntries(
      ROUTES.map(({ route, throttle }) => [route, { throttlingRateLimit: (throttle ?? DEFAULT_THROTTLE).rate, throttlingBurstLimit: (throttle ?? DEFAULT_THROTTLE).burst }]),
    );

    new ssm.StringParameter(this, 'ParamApiId', { parameterName: ssmParam(envName, 'api/id'), stringValue: this.api.apiId });
    new ssm.StringParameter(this, 'ParamApiUrl', { parameterName: ssmParam(envName, 'api/url'), stringValue: stage.url });
  }
}
