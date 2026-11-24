import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
import { parse } from 'yaml';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' }); // prod exige webOrigin

const { buildApp } = await import('../bin/app.js');
const { ROUTES } = await import('../lib/api-stack.js');
import { App } from 'aws-cdk-lib';
import { webOriginFor } from '../lib/data-stack.js';
import { ENVS, stackName } from '../../shared/names.js';

const tpl = (env: (typeof ENVS)[number], s: string) => {
  const app = buildApp(env, 'test@example.invalid');
  return Template.fromStack(app.node.findChild(stackName(env, s)) as never);
};

describe('Data', () => {
  const t = tpl('dev', 'data');
  it('table qcm-dev: PK/SK, GSI1, TTL, pas de PITR', () => {
    t.hasResourceProperties('AWS::DynamoDB::Table', {
      TableName: 'qcm-dev',
      KeySchema: [{ AttributeName: 'PK', KeyType: 'HASH' }, { AttributeName: 'SK', KeyType: 'RANGE' }],
      GlobalSecondaryIndexes: [Match.objectLike({ IndexName: 'GSI1' })],
      TimeToLiveSpecification: { AttributeName: 'ttl', Enabled: true },
      PointInTimeRecoverySpecification: { PointInTimeRecoveryEnabled: false },
    });
  });
  it('scans: expiration 1 jour, acces public bloque', () => {
    t.hasResourceProperties('AWS::S3::Bucket', {
      LifecycleConfiguration: { Rules: [Match.objectLike({ ExpirationInDays: 1, Status: 'Enabled' })] },
      PublicAccessBlockConfiguration: Match.objectLike({ BlockPublicAcls: true, RestrictPublicBuckets: true }),
    });
  });
  it('coffre: lecture refusee a toute identite sauf le role d\'evaluation', () => {
    const policies = t.findResources('AWS::S3::BucketPolicy');
    const stmts = Object.values(policies).flatMap((p) => (p as { Properties: { PolicyDocument: { Statement: Record<string, unknown>[] } } }).Properties.PolicyDocument.Statement);
    const deny = stmts.find((s) => s.Sid === 'OnlyEvalRoleReads') as { Effect: string; Condition: { ArnNotLike: Record<string, unknown> } };
    expect(deny.Effect).toBe('Deny');
    expect(JSON.stringify(deny.Condition.ArnNotLike)).toContain('qcm-dev-eval-role');
  });
  it('coffre conserve a la suppression de la stack', () => {
    const vaults = Object.values(t.findResources('AWS::S3::Bucket', { DeletionPolicy: 'Retain' }));
    expect(vaults).toHaveLength(1);
  });
});

describe('Models', () => {
  for (const env of ENVS) {
    it(`${env}: 2 profils d'application copies de profils systeme UE`, () => {
      const t = tpl(env, 'models');
      const profiles = Object.values(t.findResources('AWS::Bedrock::ApplicationInferenceProfile')) as { Properties: { InferenceProfileName: string; ModelSource: unknown } }[];
      expect(profiles.map((p) => p.Properties.InferenceProfileName).sort()).toEqual([`qcm-${env}-haiku`, `qcm-${env}-sonnet`]);
      expect(JSON.stringify(profiles[0].Properties.ModelSource)).toContain('inference-profile/eu.anthropic.');
    });
  }
});

describe('Api', () => {
  const spec = parse(readFileSync(new URL('../../shared/contract/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const contract = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`)).sort();
  it('la table ROUTES couvre exactement les routes du contrat', () => {
    expect(ROUTES.map((r) => r.route).sort()).toEqual(contract);
  });
  const t = tpl('dev', 'api');
  it('chaque route est protegee par l\'autorisateur JWT', () => {
    const routes = Object.values(t.findResources('AWS::ApiGatewayV2::Route')) as { Properties: { AuthorizationType: string; RouteKey: string } }[];
    expect(routes).toHaveLength(contract.length);
    for (const r of routes) expect(r.Properties.AuthorizationType).toBe('JWT');
  });
  it('CORS restreint a une origine, jamais *', () => {
    t.hasResourceProperties('AWS::ApiGatewayV2::Api', { CorsConfiguration: Match.objectLike({ AllowOrigins: ['https://front.example.invalid'] }) });
  });
  it('limitation definie pour chaque route', () => {
    const stage = Object.values(t.findResources('AWS::ApiGatewayV2::Stage'))[0] as { Properties: { RouteSettings: Record<string, unknown> } };
    expect(Object.keys(stage.Properties.RouteSettings).sort()).toEqual(contract);
  });
  it('les squelettes repondent 501', () => {
    t.hasResourceProperties('AWS::Lambda::Function', { Code: { ZipFile: Match.stringLikeRegexp('statusCode: 501') } });
  });
});

describe('webOrigin', () => {
  it('prod sans contexte: erreur; dev sans contexte: localhost', () => {
    const saved = process.env.CDK_CONTEXT_JSON;
    delete process.env.CDK_CONTEXT_JSON;
    try {
      expect(() => webOriginFor(new App(), 'prod')).toThrow(/webOrigin/);
      expect(webOriginFor(new App(), 'dev')).toBe('http://localhost:5173');
    } finally {
      process.env.CDK_CONTEXT_JSON = saved;
    }
  });
});

describe('role d\'evaluation', () => {
  it('confiance limitee au role de deploiement, pas au root du compte', () => {
    const t = tpl('dev', 'data');
    const role = Object.values(t.findResources('AWS::IAM::Role')).find((r) => (r as { Properties: { RoleName?: string } }).Properties.RoleName === 'qcm-dev-eval-role') as { Properties: { AssumeRolePolicyDocument: unknown } };
    const doc = JSON.stringify(role.Properties.AssumeRolePolicyDocument);
    expect(doc).toContain('role/QCMonster-GitHubActions-Deploy');
    expect(doc).not.toContain(':root');
  });
});
