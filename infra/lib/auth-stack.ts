import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { NodejsFunction } from 'aws-cdk-lib/aws-lambda-nodejs';
import type { Construct } from 'constructs';
import { fileURLToPath } from 'node:url';
import { fn, ssmParam, tableName, type Env } from '../../shared/names.js';

export interface AuthStackProps extends StackProps {
  envName: Env;
}

/**
 * Auth (design-v2 4.7, 4.8): Cognito, groupes parent/eleve, attribut famille_id, MFA TOTP proposee,
 * declencheur PreSignUp qui exige un code d'invitation a usage unique.
 */
export class AuthStack extends Stack {
  readonly userPool: cognito.UserPool;
  readonly webClient: cognito.UserPoolClient;
  /** Client reserve a l'inscription du parent (sans connexion possible). */
  readonly signupClient: cognito.UserPoolClient;

  constructor(scope: Construct, id: string, props: AuthStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const prod = envName === 'prod';
    const table = tableName(envName);

    const preSignUp = new NodejsFunction(this, 'PreSignUp', {
      functionName: fn(envName, 'auth-presignup'),
      entry: fileURLToPath(new URL('../../api/src/auth/pre-signup.ts', import.meta.url)),
      handler: 'handler',
      runtime: lambda.Runtime.NODEJS_22_X,
      architecture: lambda.Architecture.ARM_64,
      memorySize: 256,
      timeout: Duration.seconds(5),
      environment: { TABLE_NAME: table },
      logGroup: new logs.LogGroup(this, 'PreSignUpLogs', {
        retention: logs.RetentionDays.TWO_WEEKS,
        removalPolicy: RemovalPolicy.DESTROY,
      }),
      bundling: { minify: true, sourceMap: false, target: 'node22' },
    });
    // Table cree par la stack Data (lot 1 suite): reference par NOM, pas d'import entre stacks.
    preSignUp.addToRolePolicy(
      new iam.PolicyStatement({
        actions: ['dynamodb:UpdateItem'],
        resources: [this.formatArn({ service: 'dynamodb', resource: 'table', resourceName: table })],
      }),
    );

    this.userPool = new cognito.UserPool(this, 'UserPool', {
      userPoolName: `qcm-${envName}`,
      selfSignUpEnabled: true, // inscription parent, filtree par le declencheur PreSignUp (invitation obligatoire)
      signInAliases: { username: true, email: true, preferredUsername: true },
      autoVerify: { email: true },
      keepOriginal: { email: true },
      standardAttributes: { email: { required: true, mutable: true } },
      customAttributes: {
        famille_id: new cognito.StringAttribute({ minLen: 1, maxLen: 64, mutable: true }),
      },
      mfa: cognito.Mfa.OPTIONAL, // proposee et recommandee, pas imposee
      mfaSecondFactor: { otp: true, sms: false }, // TOTP seulement, pas de SMS
      passwordPolicy: { minLength: 12, requireLowercase: true, requireUppercase: true, requireDigits: true, requireSymbols: false },
      accountRecovery: cognito.AccountRecovery.EMAIL_ONLY,
      deletionProtection: prod,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      lambdaTriggers: { preSignUp },
    });

    new cognito.CfnUserPoolGroup(this, 'GroupParent', { userPoolId: this.userPool.userPoolId, groupName: 'parent' });
    new cognito.CfnUserPoolGroup(this, 'GroupEleve', { userPoolId: this.userPool.userPoolId, groupName: 'eleve' });

    // famille_id n'est jamais modifiable par le client: seul le serveur l'ecrit.
    const readAttrs = new cognito.ClientAttributes().withStandardAttributes({ email: true, emailVerified: true }).withCustomAttributes('famille_id');

    // B1: pas d'OAuth par defaut (ni flux implicite, ni rappel factice, ni Hosted UI). L'application se connecte par SRP (amazon-cognito-identity-js).
    // Point d'extension: `-c oauthCallbackUrls=<url,url>` active le flux « code » (jamais implicite) avec la portee `openid` seule, pour ces URL exactes.
    const callbacks = String(this.node.tryGetContext('oauthCallbackUrls') ?? '').split(',').map((u) => u.trim()).filter(Boolean);
    if (callbacks.some((u) => !u.startsWith('https://'))) throw new Error('oauthCallbackUrls: https uniquement');
    const oAuth = callbacks.length
      ? { oAuth: { flows: { authorizationCodeGrant: true, implicitCodeGrant: false, clientCredentials: false }, scopes: [cognito.OAuthScope.OPENID], callbackUrls: callbacks } }
      : { disableOAuth: true };

    // B2: ce client sert a la connexion de TOUS (parents et eleves): il n'ecrit AUCUN attribut. Un eleve ne peut donc ni mettre un e-mail reel
    // (recuperation de mot de passe sans le parent, adresse d'enfant stockee) ni changer son alias de connexion.
    this.webClient = this.userPool.addClient('Web', {
      userPoolClientName: `qcm-${envName}-web`,
      generateSecret: false, // client public (PWA)
      authFlows: { userSrp: true },
      preventUserExistenceErrors: true,
      enableTokenRevocation: true,
      accessTokenValidity: Duration.hours(1),
      idTokenValidity: Duration.hours(1),
      refreshTokenValidity: Duration.days(30),
      readAttributes: readAttrs,
      writeAttributes: new cognito.ClientAttributes(),
      ...oAuth,
    });

    // Identifiants publics (client sans secret), lus par le build du front dans deploy.yml via --outputs-file.
    new CfnOutput(this, 'UserPoolId', { value: this.userPool.userPoolId });
    new CfnOutput(this, 'WebClientId', { value: this.webClient.userPoolClientId });

    // Inscription du parent (SignUp exige que le client puisse ecrire l'e-mail): client DISTINCT, sans aucun flux de connexion.
    // Les jetons ne viennent jamais de lui (l'API n'accepte que ceux du client Web), donc un eleve ne peut pas s'en servir pour ecrire son e-mail.
    this.signupClient = this.userPool.addClient('Signup', {
      userPoolClientName: `qcm-${envName}-signup`,
      generateSecret: false,
      authFlows: {}, // vide = Cognito appliquerait ses flux par defaut (SRP): force ci-dessous
      preventUserExistenceErrors: true,
      readAttributes: new cognito.ClientAttributes(),
      writeAttributes: new cognito.ClientAttributes().withStandardAttributes({ email: true }),
      disableOAuth: true,
    });

    (this.signupClient.node.defaultChild as cognito.CfnUserPoolClient).explicitAuthFlows = ['ALLOW_REFRESH_TOKEN_AUTH']; // aucun flux de connexion

    new CfnOutput(this, 'SignupClientId', { value: this.signupClient.userPoolClientId }); // public, lu par scripts/front-env.mjs

    new ssm.StringParameter(this, 'ParamUserPoolId', { parameterName: ssmParam(envName, 'auth/userPoolId'), stringValue: this.userPool.userPoolId });
    new ssm.StringParameter(this, 'ParamClientId', { parameterName: ssmParam(envName, 'auth/webClientId'), stringValue: this.webClient.userPoolClientId });
    new ssm.StringParameter(this, 'ParamSignupClientId', { parameterName: ssmParam(envName, 'auth/signupClientId'), stringValue: this.signupClient.userPoolClientId });
  }
}
