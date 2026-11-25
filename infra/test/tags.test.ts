import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
import { missingTags } from './tags.js';
import type { Env } from '../../shared/names.js';

for (const env of ['dev', 'prod'] as Env[]) {
  describe(`tags obligatoires (${env})`, () => {
    const app = buildApp(env, 'test@example.invalid');
    const stacks = app.node.children.filter((c) => 'templateOptions' in c) as unknown as Parameters<typeof Template.fromStack>[0][];
    it('synthetise les 9 stacks', () => expect(stacks).toHaveLength(9));
    it.each(stacks.map((s) => [s.stackName, s] as const))('%s: toutes les ressources portent Project, Environment, ManagedBy, Owner', (_n, s) => {
      expect(missingTags(Template.fromStack(s).toJSON())).toEqual([]);
    });
  });
}

describe('le test des tags detecte un tag retire (acceptation L1 n.3)', () => {
  it('echoue quand un tag manque', () => {
    const t = { Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { Tags: [{ Key: 'Project', Value: 'x' }, { Key: 'Owner', Value: 'x' }] } } } };
    expect(missingTags(t)).toEqual(['Topic (AWS::SNS::Topic): tag Environment manquant', 'Topic (AWS::SNS::Topic): tag ManagedBy manquant']);
  });
  it('passe quand les 4 tags sont la', () => {
    const tags = ['Project', 'Environment', 'ManagedBy', 'Owner'].map((Key) => ({ Key, Value: 'x' }));
    expect(missingTags({ Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { Tags: tags } } } })).toEqual([]);
  });
});
