import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
delete process.env.CDK_CONTEXT_JSON;
const { buildApp } = await import('../bin/app.js');

const build = (ctx: Record<string, string> = {}) => {
  const app = buildApp('dev', 'test@example.invalid', ctx);
  return (s: string) => Template.fromStack(app.node.findChild(`qcm-dev-${s}`) as never);
};

describe('Web (L5)', () => {
  const t = build()('web');
  it('bucket prive et chiffre', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      PublicAccessBlockConfiguration: { BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true },
      BucketEncryption: Match.anyValue(),
    });
  });
  it('CloudFront: OAC, fallback SPA 403/404, adresse par defaut', () => {
    t.resourceCountIs('AWS::CloudFront::OriginAccessControl', 1);
    t.hasResourceProperties('AWS::CloudFront::Distribution', {
      DistributionConfig: Match.objectLike({
        DefaultRootObject: 'index.html',
        CustomErrorResponses: [Match.objectLike({ ErrorCode: 403, ResponsePagePath: '/index.html', ResponseCode: 200 }), Match.objectLike({ ErrorCode: 404, ResponsePagePath: '/index.html', ResponseCode: 200 })],
      }),
    });
    expect(JSON.stringify(t.toJSON())).not.toContain('Aliases');
  });
  it('en-tetes de securite avec CSP', () => {
    t.hasResourceProperties('AWS::CloudFront::ResponseHeadersPolicy', {
      ResponseHeadersPolicyConfig: Match.objectLike({
        SecurityHeadersConfig: Match.objectLike({ ContentSecurityPolicy: Match.objectLike({ ContentSecurityPolicy: Match.stringLikeRegexp("default-src 'self'.*object-src 'none'") }) }),
      }),
    });
  });
  it('sortie SiteUrl', () => expect(Object.keys(t.toJSON().Outputs)).toContain('SiteUrl'));
});

describe('origine du front lue dans la stack Web (sans contexte webOrigin)', () => {
  const get = build();
  it('API: CORS = origine CloudFront (jamais *), via SSM', () => {
    const j = JSON.stringify(get('api').toJSON());
    expect(j).toContain('/qcm/dev/web/origin');
    get('api').hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: { AllowOrigins: [Match.anyValue()] } });
    expect(j).not.toMatch(/"AllowOrigins":\s*\["\*"\]/);
  });
  it('Data, Api et Game dependent de Web', () => {
    for (const s of ['data', 'api', 'game']) expect(JSON.stringify(get(s).toJSON())).toContain('/qcm/dev/web/origin');
  });
});

describe('contenu du site', () => {
  it('stack web-content seulement avec webDist (tests: infra/test, sans bundle)', () => {
    const app = buildApp('dev', 'test@example.invalid', { webDist: 'infra/test' });
    expect(app.node.tryFindChild('qcm-dev-web-content')).toBeDefined();
  });
});
