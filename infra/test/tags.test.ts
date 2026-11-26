import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
import { readdirSync, readFileSync } from 'node:fs';
import { missingTags } from './tags.js';
import type { Env } from '../../shared/names.js';

for (const env of ['dev', 'prod'] as Env[]) {
  describe(`tags obligatoires (${env})`, () => {
    const app = buildApp(env, 'test@example.invalid');
    const stacks = app.node.children.filter((c) => 'templateOptions' in c) as unknown as Parameters<typeof Template.fromStack>[0][];
    it('synthetise les 9 stacks', () => expect(stacks).toHaveLength(9));
    it.each(stacks.map((s) => [s.stackName, s] as const))('%s: toutes les ressources portent project, Environment, ManagedBy, Owner', (_n, s) => {
      expect(missingTags(Template.fromStack(s).toJSON())).toEqual([]);
    });
  });
}

describe('cle de repartition des couts (FEAT-D)', () => {
  it.each(['dev', 'prod'] as Env[])('%s: la valeur du tag project est qcmonster et la cle Project (majuscule) est absente', (env) => {
    const app = buildApp(env, 'test@example.invalid');
    const stacks = app.node.children.filter((c) => 'templateOptions' in c) as unknown as Parameters<typeof Template.fromStack>[0][];
    let seen = 0;
    for (const s of stacks) {
      for (const r of Object.values(Template.fromStack(s).toJSON().Resources ?? {}) as { Properties?: { Tags?: unknown } }[]) {
        const raw = r.Properties?.Tags;
        if (!Array.isArray(raw)) continue;
        const tags = raw as { Key: string; Value: unknown }[];
        expect(tags.some((t) => t.Key === 'Project')).toBe(false);
        const p = tags.find((t) => t.Key === 'project');
        if (p) { expect(p.Value).toBe('qcmonster'); seen++; }
      }
    }
    expect(seen).toBeGreaterThan(10);
  });
});

describe('le test des tags detecte un tag retire (acceptation L1 n.3)', () => {
  it('echoue quand un tag manque', () => {
    const t = { Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { Tags: [{ Key: 'project', Value: 'x' }, { Key: 'Owner', Value: 'x' }] } } } };
    expect(missingTags(t)).toEqual(['Topic (AWS::SNS::Topic): tag Environment manquant', 'Topic (AWS::SNS::Topic): tag ManagedBy manquant']);
  });
  it('passe quand les 4 tags sont la', () => {
    const tags = ['project', 'Environment', 'ManagedBy', 'Owner'].map((Key) => ({ Key, Value: 'x' }));
    expect(missingTags({ Resources: { Topic: { Type: 'AWS::SNS::Topic', Properties: { Tags: tags } } } })).toEqual([]);
  });
});

describe('cle de tag `project` en minuscules partout (F13)', () => {
  it('la stack eval (dev, evalPath=true) porte project=qcmonster et jamais Project', () => {
    const app = buildApp('dev', 'test@example.invalid', { evalPath: 'true', evalSubPrefix: 'repo:o/r' });
    const s = app.node.tryFindChild('qcm-dev-eval') as unknown as Parameters<typeof Template.fromStack>[0];
    expect(s).toBeDefined();
    const t = Template.fromStack(s).toJSON();
    expect(missingTags(t)).toEqual([]);
    expect(JSON.stringify(t)).not.toMatch(/"Key":"Project"/);
    expect(JSON.stringify(t)).toMatch(/"Key":"project","Value":"qcmonster"/);
  });
  it('les scripts de bootstrap ne posent pas la cle Project (majuscule)', () => {
    const dir = new URL('../../infra-bootstrap/', import.meta.url);
    const scripts = readdirSync(dir).filter((f) => f.endsWith('.sh'));
    expect(scripts.length).toBeGreaterThan(0);
    for (const f of scripts) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      expect(src, f).not.toMatch(/Key=Project\b|\bProject=/);
      expect(src, f).toMatch(/Key=project,Value=qcmonster/);
    }
  });
});
