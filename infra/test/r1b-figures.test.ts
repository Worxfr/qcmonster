import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { TASK_TIMEOUT_S } = await import('../lib/pipeline-stack.js');
import { readFileSync } from 'node:fs';
import { ENVS, stackName } from '../../shared/names.js';
import { REQUIRED_TAGS } from './tags.js';

// Lot R1-B (docs/R1-design.md 12): bucket des figures, couche sharp, etape cropFigures, droits minimaux, export de l'eleve.
type Stmt = { Effect: string; Action: string | string[]; Resource: unknown; Condition?: unknown };
type Pol = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } };
type Fn = { Properties: { FunctionName: string; Role: { 'Fn::GetAtt': string[] }; Layers?: unknown[]; MemorySize: number; Timeout: number; Architectures: string[]; Environment: { Variables: Record<string, unknown> } } };
const acts = (s: Stmt) => (Array.isArray(s.Action) ? s.Action : [s.Action]);
const text = (x: unknown) => JSON.stringify(x);

const synth = (env: (typeof ENVS)[number], ctx?: Record<string, string>) => {
  const app = buildApp(env, 'test@example.invalid', ctx);
  const t = (s: string) => Template.fromStack(app.node.findChild(stackName(env, s)) as never);
  return { data: t('data'), pipeline: t('pipeline'), game: t('game') };
};
/** Instructions IAM d'un role (nom logique du role). */
const roleStmts = (t: Template, roleName: string): Stmt[] => {
  const roles = t.findResources('AWS::IAM::Role', { Properties: { RoleName: roleName } });
  const logical = Object.keys(roles)[0];
  expect(logical, roleName).toBeDefined();
  return (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => (p.Properties.Roles.some((r) => r.Ref === logical) ? p.Properties.PolicyDocument.Statement : []));
};
const onFigures = (stmts: Stmt[]) => stmts.filter((s) => /figures\/\*|figuresBucket/.test(text([s.Resource, s.Condition])));
const fnsOf = (t: Template) => Object.values(t.findResources('AWS::Lambda::Function')) as Fn[];
const fnNamed = (t: Template, name: string) => fnsOf(t).find((f) => f.Properties.FunctionName === name)!.Properties;

for (const env of ENVS) {
  describe(`R1-B (${env})`, () => {
    const { data, pipeline, game } = synth(env);
    const p = (name: string) => roleStmts(pipeline, `qcm-${env}-${name}`);

    it('bucket figures: chiffre, TLS exige, acces public bloque, aucun cycle de vie, parametre SSM', () => {
      const ids = Object.keys(data.findResources('AWS::S3::Bucket'));
      expect(ids.filter((i) => /^Figures/.test(i))).toHaveLength(1);
      const b = data.findResources('AWS::S3::Bucket')[ids.find((i) => /^Figures/.test(i))!] as { Properties: Record<string, unknown>; DeletionPolicy?: string };
      expect(b.Properties.LifecycleConfiguration).toBeUndefined();
      expect(b.Properties.CorsConfiguration).toBeUndefined();
      expect(b.Properties.PublicAccessBlockConfiguration).toEqual({ BlockPublicAcls: true, BlockPublicPolicy: true, IgnorePublicAcls: true, RestrictPublicBuckets: true });
      expect(text(b.Properties.BucketEncryption)).toContain('AES256');
      expect(b.DeletionPolicy).toBe(env === 'prod' ? 'Retain' : 'Delete');
      const policies = Object.values(data.findResources('AWS::S3::BucketPolicy')) as { Properties: { Bucket: { Ref: string }; PolicyDocument: { Statement: Stmt[] } } }[];
      const own = policies.find((x) => x.Properties.Bucket.Ref === ids.find((i) => /^Figures/.test(i)));
      expect(text(own?.Properties.PolicyDocument.Statement)).toContain('"aws:SecureTransport":"false"');
      data.hasResourceProperties('AWS::SSM::Parameter', { Name: `/qcm/${env}/data/figuresBucket` });
    });

    it('tags: bucket, couche exclue (CloudFormation ne l\'accepte pas), fonctions et roles portent les 4 tags', () => {
      const f = Object.values(data.findResources('AWS::S3::Bucket')).filter((x) => text((x as { Properties: object }).Properties).includes('AES256'));
      for (const b of f) for (const k of REQUIRED_TAGS) expect(text((b as { Properties: { Tags: unknown } }).Properties.Tags)).toContain(`"Key":"${k}"`);
      expect(text(f[0])).toContain('"Key":"project","Value":"qcmonster"');
    });

    it('couche sharp: arm64, Node, attachee a crop-figures seulement; crop-figures: 1 Go, 2 min, role de traitement', () => {
      const layers = Object.values(pipeline.findResources('AWS::Lambda::LayerVersion')) as { Properties: { CompatibleArchitectures: string[]; CompatibleRuntimes: string[] } }[];
      expect(layers).toHaveLength(1);
      expect(layers[0].Properties.CompatibleArchitectures).toEqual(['arm64']);
      expect(layers[0].Properties.CompatibleRuntimes).toEqual(['nodejs22.x']);
      const withLayer = fnsOf(pipeline).filter((f) => (f.Properties.Layers ?? []).length > 0).map((f) => f.Properties.FunctionName);
      expect(withLayer).toEqual([`qcm-${env}-crop-figures`]);
      const crop = fnNamed(pipeline, `qcm-${env}-crop-figures`);
      expect(crop).toMatchObject({ MemorySize: 1024, Timeout: 120, Architectures: ['arm64'] });
      expect(text(crop.Role)).toMatch(/pipelinerole/i);
    });

    it('sharp est external du paquet commun (jamais embarque)', () => {
      expect(readFileSync(new URL('../lib/pipeline-stack.ts', import.meta.url), 'utf8')).toMatch(/external: \['sharp'\]/);
    });

    it('machine: RognageFigures entre Transcription et AttenteConfirmation, rejouable, Catch vers MarquerEchec; la lecture reste sans reprise', () => {
      const sm = Object.values(pipeline.findResources('AWS::StepFunctions::StateMachine'))[0] as { Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } } };
      const def = JSON.parse(sm.Properties.DefinitionString['Fn::Join'][1].map((x) => (typeof x === 'string' ? x : 'REF')).join('')) as { States: Record<string, { Next?: string; Choices?: { Next: string }[]; Retry?: unknown[]; Catch?: { Next: string }[]; TimeoutSeconds?: number }> };
      const s = def.States;
      expect(s.CoursAccepte.Choices?.[0].Next).toBe('RognageFigures');
      expect(s.RognageFigures.Next).toBe('AttenteConfirmation');
      expect(s.RognageFigures.TimeoutSeconds).toBe(TASK_TIMEOUT_S.cropFigures);
      expect(s.RognageFigures.Retry?.length).toBeGreaterThan(0);
      expect(s.RognageFigures.Catch?.[0].Next).toBe('MarquerEchec');
      expect(s.Transcription.Retry).toBeUndefined();
      // delais revus: la tache de lecture couvre la fonction (10 min) et sa reprise Sonnet
      expect(fnNamed(pipeline, `qcm-${env}-transcribe`).Timeout).toBe(600);
      expect(TASK_TIMEOUT_S.transcribe).toBeGreaterThan(600);
    });

    it('FIGURES_ENABLED: vrai par defaut, faux avec -c figures=false', () => {
      expect(fnNamed(pipeline, `qcm-${env}-crop-figures`).Environment.Variables.FIGURES_ENABLED).toBe('true');
      const off = synth(env, { figures: 'false' }).pipeline;
      expect(fnNamed(off, `qcm-${env}-crop-figures`).Environment.Variables.FIGURES_ENABLED).toBe('false');
    });

    it('droits: aucun droit hors prefixe (figures/*, scans/*/fig/*, exports/*), jamais de joker de bucket', () => {
      const all = (Object.values(pipeline.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((x) => x.Properties.PolicyDocument.Statement);
      for (const s of onFigures(all)) {
        const as = acts(s);
        if (as.includes('s3:ListBucket')) expect(text(s.Condition)).toContain('figures/*');
        else expect(text(s.Resource)).toMatch(/\/figures\/\*/);
        expect(as.every((a) => a.startsWith('s3:'))).toBe(true);
      }
      // aucune instruction S3 sur les objets d'un bucket sans prefixe
      for (const s of all.filter((x) => acts(x).some((a) => a.startsWith('s3:') && a !== 's3:ListBucket'))) expect(text(s.Resource)).toMatch(/\/(scans|figures|exports)\//);
    });

    it('tableau des droits: procRole, confirm, read, cours-read, cours', () => {
      const fig = (name: string) => onFigures(p(name)).flatMap(acts).sort();
      expect(fig('pipeline-role')).toEqual(['s3:DeleteObject', 's3:ListBucket']);
      expect(p('pipeline-role').some((s) => acts(s).includes('s3:PutObject') && text(s.Resource).includes('/scans/*/fig/*'))).toBe(true);
      expect(fig('pipeline-api-confirm-role')).toEqual(['s3:DeleteObject', 's3:PutObject']);
      expect(p('pipeline-api-confirm-role').some((s) => acts(s).includes('s3:GetObject') && text(s.Resource).includes('/scans/*'))).toBe(true);
      expect(fig('pipeline-api-read-role')).toEqual(['s3:GetObject']);
      expect(fig('pipeline-api-cours-read-role')).toEqual(['s3:GetObject']);
      expect(fig('pipeline-api-cours-role')).toEqual(['s3:DeleteObject', 's3:ListBucket']);
      // scans-delete: aucun droit figures (le recadrage est sous scans/)
      expect(fig('pipeline-api-scans-delete-role')).toEqual([]);
      for (const r of ['api-write', 'api-delete', 'api-list', 'api-patch', 'api-folders', 'trigger']) expect(fig(`pipeline-${r}-role`), r).toEqual([]);
    });

    it('Sonnet: seul pipeline-role appelle le profil Sonnet', () => {
      const roles = Object.values(pipeline.findResources('AWS::IAM::Role')).map((r) => (r as { Properties: { RoleName?: string } }).Properties.RoleName).filter(Boolean) as string[];
      const withSonnet = roles.filter((r) => text(roleStmts(pipeline, r).filter((s) => acts(s).some((a) => a.startsWith('bedrock:')))).includes('sonnet'));
      expect(withSonnet).toEqual([`qcm-${env}-pipeline-role`]);
    });

    it('game: seul le role admin touche figures/ (liste du prefixe et suppression); parent, export du parent et lecture sans droit', () => {
      const names = Object.values(game.findResources('AWS::IAM::Role')).map((r) => (r as { Properties: { RoleName?: string } }).Properties.RoleName).filter(Boolean) as string[];
      for (const r of names) {
        const f = onFigures(roleStmts(game, r));
        if (r === `qcm-${env}-game-admin-role`) {
          expect(f.flatMap(acts).sort()).toEqual(['s3:DeleteObject', 's3:ListBucket']);
          expect(text(f.find((s) => acts(s).includes('s3:ListBucket'))?.Condition)).toContain('figures/*');
        } else expect(f, r).toEqual([]);
      }
      expect(names).toContain(`qcm-${env}-game-archive-role`);
    });

    it('export de l\'eleve: fonction de construction (15 min, 512 Mo, role propre) sans suppression ni Bedrock; la route lance et signe, sans droit figures', () => {
      const build = fnNamed(pipeline, `qcm-${env}-student-export-build`);
      expect(build).toMatchObject({ MemorySize: 512, Timeout: 900 });
      expect(text(build.Role)).toMatch(/pipelineexportrole/i);
      const b = p('pipeline-export-role');
      const fig = onFigures(b);
      expect(fig.flatMap(acts).sort()).toEqual(['s3:GetObject', 's3:ListBucket']);
      expect(text(fig.find((s) => acts(s).includes('s3:ListBucket'))?.Condition)).toContain('figures/*');
      const s3 = b.filter((s) => acts(s).some((a) => a.startsWith('s3:')) && !/figuresBucket/.test(text(s.Resource)));
      expect(s3.flatMap(acts).sort()).toEqual(['s3:AbortMultipartUpload', 's3:ListMultipartUploadParts', 's3:PutObject']);
      expect(text(s3.map((s) => s.Resource))).toContain('/exports/*');
      expect(b.flatMap(acts).filter((a) => /Delete|bedrock|states:/.test(a))).toEqual([]);
      const route = p('pipeline-api-export-role');
      expect(onFigures(route)).toEqual([]);
      expect(route.flatMap(acts)).toContain('lambda:InvokeFunction');
      expect(text(route.find((s) => acts(s).includes('lambda:InvokeFunction'))?.Resource)).toContain('student-export-build');
      expect(route.flatMap(acts).filter((a) => /Delete|bedrock/.test(a))).toEqual([]);
    });
  });
}
