import { CfnOutput, Duration, RemovalPolicy, Stack, type StackProps } from 'aws-cdk-lib';
import * as cloudfront from 'aws-cdk-lib/aws-cloudfront';
import * as origins from 'aws-cdk-lib/aws-cloudfront-origins';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as s3deploy from 'aws-cdk-lib/aws-s3-deployment';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import type { Construct } from 'constructs';
import { REGION, ssmParam, type Env } from '../../shared/names.js';

export interface WebStackProps extends StackProps {
  envName: Env;
}

/**
 * En-tetes de securite du site. Memes directives que la CSP posee en <meta> par web/vite.config.ts, avec des jokers pour
 * l'API et le stockage des scans: l'adresse exacte de l'API n'est pas connue de cette stack (qui ne depend pas de l'API,
 * c'est l'API qui depend de son origine). La CSP du <meta> reste la plus stricte; les deux s'appliquent.
 */
export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  `connect-src 'self' https://*.execute-api.${REGION}.amazonaws.com https://cognito-idp.${REGION}.amazonaws.com https://*.s3.${REGION}.amazonaws.com`,
  `img-src 'self' data: blob: https://*.s3.${REGION}.amazonaws.com`,
  `form-action 'self' https://*.s3.${REGION}.amazonaws.com`,
  "worker-src 'self'",
  "manifest-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
].join('; ');

/**
 * Hebergement du front (L5): bucket S3 prive, CloudFront avec OAC, adresse CloudFront par defaut (pas de domaine).
 * L'origine publiee en SSM (/qcm/<env>/web/origin) est lue par les stacks Data, Api et Game (CORS, lien d'activation).
 */
export class WebStack extends Stack {
  readonly bucket: s3.Bucket;
  readonly distribution: cloudfront.Distribution;

  constructor(scope: Construct, id: string, props: WebStackProps) {
    super(scope, id, props);
    const { envName } = props;
    const prod = envName === 'prod';

    this.bucket = new s3.Bucket(this, 'Site', {
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      enforceSSL: true,
      versioned: false,
      removalPolicy: prod ? RemovalPolicy.RETAIN : RemovalPolicy.DESTROY,
      // shortcut: pas d'autoDeleteObjects (sa fonction d'appui CDK ne se tague pas); detruire la stack dev demande de vider le bucket.
    });

    const headers = new cloudfront.ResponseHeadersPolicy(this, 'Headers', {
      securityHeadersBehavior: {
        contentSecurityPolicy: { contentSecurityPolicy: CSP, override: true },
        strictTransportSecurity: { accessControlMaxAge: Duration.days(365), includeSubdomains: true, override: true },
        contentTypeOptions: { override: true },
        frameOptions: { frameOption: cloudfront.HeadersFrameOption.DENY, override: true },
        referrerPolicy: { referrerPolicy: cloudfront.HeadersReferrerPolicy.NO_REFERRER, override: true },
      },
      customHeadersBehavior: {
        customHeaders: [{ header: 'Permissions-Policy', value: 'camera=(self), microphone=(), geolocation=()', override: true }],
      },
    });

    const spa = (httpStatus: number) => ({ httpStatus, responseHttpStatus: 200, responsePagePath: '/index.html', ttl: Duration.seconds(0) });
    this.distribution = new cloudfront.Distribution(this, 'Cdn', {
      comment: `qcm-${envName} front`,
      defaultRootObject: 'index.html',
      httpVersion: cloudfront.HttpVersion.HTTP2_AND_3,
      priceClass: cloudfront.PriceClass.PRICE_CLASS_100,
      defaultBehavior: {
        origin: origins.S3BucketOrigin.withOriginAccessControl(this.bucket),
        viewerProtocolPolicy: cloudfront.ViewerProtocolPolicy.REDIRECT_TO_HTTPS,
        allowedMethods: cloudfront.AllowedMethods.ALLOW_GET_HEAD,
        cachePolicy: cloudfront.CachePolicy.CACHING_OPTIMIZED,
        responseHeadersPolicy: headers,
        compress: true,
      },
      // Fallback SPA: un chemin inconnu (S3 prive repond 403) rend index.html.
      errorResponses: [spa(403), spa(404)],
    });

    const origin = `https://${this.distribution.distributionDomainName}`;
    new ssm.StringParameter(this, 'ParamOrigin', { parameterName: ssmParam(envName, 'web/origin'), stringValue: origin });
    // Lus par la stack du contenu (pas d'export entre stacks: l'ajouter puis le retirer bloquerait le deploiement suivant).
    new ssm.StringParameter(this, 'ParamBucket', { parameterName: ssmParam(envName, 'web/bucket'), stringValue: this.bucket.bucketName });
    new ssm.StringParameter(this, 'ParamDistributionId', { parameterName: ssmParam(envName, 'web/distributionId'), stringValue: this.distribution.distributionId });
    new CfnOutput(this, 'SiteUrl', { value: origin, description: 'Adresse du site' });
  }
}

export interface WebContentStackProps extends StackProps {
  envName: Env;
  site: WebStack;
  /** Dossier du build du front (web/dist), fourni par `-c webDist=...`. */
  distDir: string;
}

/**
 * Contenu du site, deploye par CDK (roles d'amorcage: le role OIDC n'a aucun droit S3 ni CloudFront direct).
 * Synthetisee seulement quand le contexte webDist est donne, apres le build du front.
 * shortcut: Cache-Control no-cache sur tous les fichiers (revalidation par ETag), a affiner par type quand le trafic le justifie.
 */
export class WebContentStack extends Stack {
  constructor(scope: Construct, id: string, props: WebContentStackProps) {
    super(scope, id, props);
    const { envName } = props;
    this.addDependency(props.site);
    const param = (name: string) => ssm.StringParameter.valueForStringParameter(this, ssmParam(envName, `web/${name}`));
    new s3deploy.BucketDeployment(this, 'Content', {
      sources: [s3deploy.Source.asset(props.distDir)],
      destinationBucket: s3.Bucket.fromBucketName(this, 'Site', param('bucket')),
      distribution: cloudfront.Distribution.fromDistributionAttributes(this, 'Cdn', { distributionId: param('distributionId'), domainName: 'inutilise.invalid' /* seul l'identifiant sert a l'invalidation */ }),
      distributionPaths: ['/*'],
      cacheControl: [s3deploy.CacheControl.noCache()],
      prune: true,
    });
  }
}
