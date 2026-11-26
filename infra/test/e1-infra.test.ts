// E1-B: S3 de 1 jour sur copies/, aucune lecture/liste de copies/ hors roles prevus, machine `copie` sans contenu, exo-post -> exo-gen seulement,
// roles de suppression de fiche, pile Exo, routes. Tout est lu dans le gabarit SYNTHETISE.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { parse } from 'yaml';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { ROUTES } = await import('../lib/api-stack.js');
const { GAME_HANDLERS } = await import('../lib/game-stack.js');
const { BudgetStack } = await import('../lib/budget-stack.js');
import { E1_GAME_HANDLERS, E1_HANDLERS } from '../../shared/exo-access.js';
import { COPIES_PREFIX, ENVS, stackName, type Env } from '../../shared/names.js';

type Stmt = { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Res = { Type: string; Properties: Record<string, unknown> };
type Tpl = { Resources: Record<string, Res> };
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const acts = (s: Stmt) => list(s.Action).map(String);
function flat(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as Record<string, unknown>;
  if (o && typeof o.Ref === 'string') return `{Ref:${o.Ref}}`;
  const j = o?.['Fn::Join'] as [string, unknown[]] | undefined;
  if (j) return j[1].map(flat).join(j[0]);
  return JSON.stringify(v);
}
const STACKS = ['data', 'pipeline', 'game', 'exo', 'verify', 'budget'];
const build = (env: Env) => {
  const app = buildApp(env, 'test@example.invalid');
  const t = (s: string) => Template.fromStack(app.node.findChild(stackName(env, s)) as never).toJSON() as Tpl;
  return { app, t, all: STACKS.map(t) };
};
/** (role, instruction) de toutes les politiques de roles des templates donnes. */
function grants(tpls: Tpl[]): { role: string; s: Stmt }[] {
  const out: { role: string; s: Stmt }[] = [];
  for (const t of tpls) {
    for (const r of Object.values(t.Resources)) {
      if (r.Type !== 'AWS::IAM::Policy') continue;
      for (const ref of r.Properties.Roles as { Ref: string }[]) {
        const role = String(t.Resources[ref.Ref].Properties.RoleName ?? ref.Ref);
        for (const s of (r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement) if (s.Effect === 'Allow') out.push({ role, s });
      }
    }
  }
  return out;
}
const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$');
const KEY = `${COPIES_PREFIX}s1/c1/p1`;
/** Action S3 qui lit un objet (GetObject, GetObject*, s3:*, s3:Get*). */
const readsObject = (a: string) => globRe(a).test('s3:GetObject');
/** Le motif de ressource d'un objet (apres le bucket des scans) couvre-t-il copies/s1/c1/p1? Un autre bucket (figures, coffre) ne compte pas. */
const objectCovers = (resource: string) => {
  const m = /scansBucket\w*Parameter\}(\/.*)$/.exec(resource);
  return m ? globRe(m[1].slice(1)).test(KEY) : false;
};
const bucketLevel = (resource: string) => /scansBucket\w*Parameter\}$/.test(resource);

describe.each(ENVS)('E1: copies/ (%s)', (env) => {
  const { app, t, all } = build(env);
  const g = grants(all);

  it('regle S3 de 1 jour: une seule regle, active, sans filtre (prefixe, tag, taille): elle couvre copies/', () => {
    const buckets = Object.values(t('data').Resources).filter((r) => r.Type === 'AWS::S3::Bucket');
    const withRule = buckets.filter((b) => JSON.stringify(b.Properties.LifecycleConfiguration ?? {}).includes('ExpirationInDays'));
    expect(withRule).toHaveLength(1); // le bucket des scans
    const rules = (withRule[0].Properties.LifecycleConfiguration as { Rules: Record<string, unknown>[] }).Rules;
    expect(rules).toHaveLength(1);
    expect(rules[0]).toMatchObject({ Status: 'Enabled', ExpirationInDays: 1 });
    for (const k of ['Prefix', 'TagFilters', 'ObjectSizeGreaterThan', 'ObjectSizeLessThan', 'Filter']) expect(rules[0][k], `filtre ${k} exclurait des objets`).toBeUndefined();
  });

  it('seul copie-role lit copies/ (GetObject); lister copies/: copieStart et admin seulement; jamais de ListBucket sans condition de prefixe', () => {
    const readers = new Set<string>();
    const listers = new Set<string>();
    for (const { role, s } of g) {
      const res = list(s.Resource).map(flat);
      if (acts(s).some(readsObject) && res.some(objectCovers)) readers.add(role);
      if (acts(s).some((a) => a === 's3:ListBucket' || a === 's3:*' || a === 's3:List*') && res.some(bucketLevel)) {
        const prefixes = list(s.Condition?.StringLike?.['s3:prefix'] as string[]);
        if (prefixes.length === 0 || prefixes.some((p) => globRe(p).test(KEY))) listers.add(role);
        // une condition de prefixe est obligatoire sur tout ListBucket du bucket des scans
        expect(prefixes.length, `${role}: ListBucket sans condition de prefixe`).toBeGreaterThan(0);
      }
    }
    expect([...readers]).toEqual([`qcm-${env}-copie-role`]);
    expect([...listers].sort()).toEqual([`qcm-${env}-game-admin-role`, `qcm-${env}-game-copieStart-role`].sort());
  });

  it('copieStart: ListBucket avec condition de prefixe copies/*, aucun GetObject; copie-role: ni PutObject ni ListBucket', () => {
    const of = (role: string) => g.filter((x) => x.role === role).flatMap(({ s }) => acts(s));
    expect(g.some(({ role, s }) => role === `qcm-${env}-game-copieStart-role` && acts(s).includes('s3:ListBucket') && JSON.stringify(s.Condition) === JSON.stringify({ StringLike: { 's3:prefix': ['copies/*'] } }))).toBe(true);
    expect(of(`qcm-${env}-game-copieStart-role`)).not.toContain('s3:GetObject');
    expect(of(`qcm-${env}-copie-role`)).not.toContain('s3:PutObject');
    expect(of(`qcm-${env}-copie-role`)).not.toContain('s3:ListBucket');
  });

  it('admin: liste seule (pas de lecture) sur copies/, avec suppression', () => {
    const adm = g.filter((x) => x.role === `qcm-${env}-game-admin-role`);
    expect(adm.some(({ s }) => acts(s).includes('s3:ListBucket') && list(s.Condition?.StringLike?.['s3:prefix'] as string[]).includes('copies/*'))).toBe(true);
    expect(adm.some(({ s }) => acts(s).includes('s3:DeleteObject') && list(s.Resource).map(flat).some((r) => r.endsWith('/copies/*')))).toBe(true);
    expect(adm.flatMap(({ s }) => acts(s))).not.toContain('s3:GetObject');
  });

  it('suppression de fiche: docs-delete, scans-delete et cours-delete effacent copies/* (cles exactes), sans lire ni lister; DOC# et STUDENT# couverts', () => {
    for (const r of ['pipeline-api-delete-role', 'pipeline-api-scans-delete-role', 'pipeline-api-cours-role']) {
      const mine = g.filter((x) => x.role === `qcm-${env}-${r}`);
      expect(mine.some(({ s }) => acts(s).includes('s3:DeleteObject') && list(s.Resource).map(flat).some((x) => x.endsWith('/copies/*'))), `${r}: DeleteObject copies/*`).toBe(true);
      const keysOf = (action: string) => mine.filter(({ s }) => acts(s).includes(action)).flatMap(({ s }) => list(s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] as string[]));
      // deleteDocTree: liste DOC# (EXO#, CLAIM#...) et STUDENT# (EXOP#, COPIE#, TEST#), puis supprime par lots
      for (const a of ['dynamodb:Query', 'dynamodb:BatchWriteItem']) for (const p of ['DOC#*', 'STUDENT#*']) expect(keysOf(a), `${r}: ${a} sur ${p}`).toContain(p);
    }
  });

  it('exo-post lance exo-gen et rien d\'autre; personne d\'autre ne peut invoquer exo-gen; variable EXO_GEN_FUNCTION', () => {
    const inv = g.filter(({ s }) => acts(s).includes('lambda:InvokeFunction') && list(s.Resource).map(flat).some((r) => r.includes('exo-gen')));
    expect(inv.map((x) => x.role)).toEqual([`qcm-${env}-game-play-role`]);
    expect(inv[0].s.Resource).toBeDefined();
    expect(list(inv[0].s.Resource).map(flat)).toHaveLength(1);
    expect(flat(list(inv[0].s.Resource)[0])).toMatch(/:function:qcm-(dev|prod)-exo-gen$/);
    const fn = Object.values(t('game').Resources).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === `qcm-${env}-exo-post`)!;
    expect((fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables).toMatchObject({ EXO_GEN_FUNCTION: `qcm-${env}-exo-gen` });
  });

  it('copies-submit seul demarre la machine `copie` (copieStart); variables des handlers de copie', () => {
    const start = g.filter(({ s }) => acts(s).includes('states:StartExecution') && list(s.Resource).map(flat).some((r) => r.endsWith(`:stateMachine:qcm-${env}-copie`)));
    expect(start.map((x) => x.role)).toEqual([`qcm-${env}-game-copieStart-role`]);
    expect(list(start[0].s.Resource)).toHaveLength(1);
    const fns = Object.values(t('game').Resources).filter((r) => r.Type === 'AWS::Lambda::Function');
    const vars = (n: string) => Object.keys(((fns.find((f) => f.Properties.FunctionName === `qcm-${env}-${n}`)!.Properties.Environment) as { Variables: Record<string, unknown> }).Variables).sort();
    expect(vars('copie-delete')).toEqual(['QCM_ENV', 'SCANS_BUCKET', 'TABLE_NAME']);
    expect(vars('copies-create')).toEqual(['QCM_ENV', 'SCANS_BUCKET', 'TABLE_NAME']);
    expect(vars('copies-submit')).toEqual(['COPIE_STATE_MACHINE_ARN', 'QCM_ENV', 'SCANS_BUCKET', 'TABLE_NAME']);
  });

  it('machine `copie`: Standard, entree {copieId,sid,exoRef,pages} sans contenu, aucune sortie gardee, une reprise, Catch vers copie-fail, journal sans donnees', () => {
    const exo = t('exo');
    const sm = Object.values(exo.Resources).find((r) => r.Type === 'AWS::StepFunctions::StateMachine')!;
    expect(sm.Properties).toMatchObject({ StateMachineName: `qcm-${env}-copie`, StateMachineType: 'STANDARD' });
    expect(sm.Properties.LoggingConfiguration).toMatchObject({ IncludeExecutionData: false, Level: 'ERROR' });
    const def = JSON.parse(((sm.Properties.DefinitionString as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1]).map((x) => (typeof x === 'string' ? x : 'REF')).join('')) as { StartAt: string; TimeoutSeconds: number; States: Record<string, Record<string, unknown>> };
    expect(def.StartAt).toBe('corriger');
    expect(Object.keys(def.States).sort()).toEqual(['Corrigee', 'Echec', 'corriger', 'echec']);
    for (const n of ['corriger', 'echec']) {
      const st = def.States[n];
      expect(st.Parameters, n).toEqual({ 'copieId.$': '$.copieId', 'sid.$': '$.sid', 'exoRef.$': '$.exoRef', 'pages.$': '$.pages' });
      expect(st.ResultPath, `${n}: la sortie de la fonction ne doit pas etre gardee`).toBeNull();
      expect(st.TimeoutSeconds).toBe(150);
    }
    const c = def.States.corriger as { Retry: { MaxAttempts: number; ErrorEquals: string[] }[]; Catch: { ErrorEquals: string[]; Next: string; ResultPath: unknown }[] };
    expect(c.Retry).toHaveLength(1);
    expect(c.Retry[0].MaxAttempts).toBe(1);
    expect(c.Retry[0].ErrorEquals).not.toContain('States.ALL');
    expect(c.Retry[0].ErrorEquals).not.toContain('States.Timeout');
    expect(c.Catch).toEqual([{ ErrorEquals: ['States.ALL'], ResultPath: null, Next: 'echec' }]); // l'erreur (qui pourrait citer un texte) n'est pas gardee
    expect(def.States.echec.Retry).toBeUndefined();
    expect(def.TimeoutSeconds).toBeGreaterThan(0);
    // les deux taches invoquent copie-correct puis copie-fail
    const fnNames = Object.values(exo.Resources).filter((r) => r.Type === 'AWS::Lambda::Function').map((r) => r.Properties.FunctionName);
    expect(fnNames.sort()).toEqual([`qcm-${env}-copie-correct`, `qcm-${env}-copie-fail`, `qcm-${env}-exo-gen`]);
  });

  it('pile Exo: delais 120 s, copie-correct 1 Go avec la couche sharp de Pipeline (ARN lu dans SSM), exo-gen sans reprise asynchrone, tous les droits Bedrock sans Converse', () => {
    const exo = t('exo');
    const fns = Object.values(exo.Resources).filter((r) => r.Type === 'AWS::Lambda::Function');
    for (const f of fns) expect(f.Properties.Timeout).toBe(120);
    const correct = fns.find((f) => f.Properties.FunctionName === `qcm-${env}-copie-correct`)!;
    expect(correct.Properties.MemorySize).toBe(1024);
    expect(JSON.stringify(correct.Properties.Layers)).toContain('pipelinesharpLayerArn');
    expect(JSON.stringify(t('pipeline'))).toContain(`/qcm/${env}/pipeline/sharpLayerArn`);
    expect(fns.filter((f) => f !== correct && list(f.Properties.Layers).length > 0)).toEqual([]);
    const cfg = Object.values(exo.Resources).find((r) => r.Type === 'AWS::Lambda::EventInvokeConfig')!;
    expect(cfg.Properties).toMatchObject({ MaximumRetryAttempts: 0 });
    const deps = (app.node.findChild(stackName(env, 'exo')) as unknown as { dependencies: { stackName: string }[] }).dependencies.map((d) => d.stackName).sort();
    expect(deps).toEqual(['data', 'models', 'pipeline'].map((s) => stackName(env, s)));
    expect(JSON.stringify(exo)).not.toMatch(/[:/]\d{12}[:/"]/); // aucun identifiant de compte en dur
  });

  it('les handlers de la pile Game sont exactement E1_GAME_HANDLERS et portent le role de exo-access', () => {
    const mine = GAME_HANDLERS.filter((h) => E1_GAME_HANDLERS.includes(h.name));
    expect(mine.map((h) => h.name).sort()).toEqual([...E1_GAME_HANDLERS].sort());
    for (const h of mine) expect(h.role).toBe(E1_HANDLERS[h.name].role);
  });
});

describe('E1: routes et budget', () => {
  const spec = parse(readFileSync(new URL('../../shared/contract/openapi.yaml', import.meta.url), 'utf8')) as { paths: Record<string, Record<string, unknown>> };
  const contract = Object.entries(spec.paths).flatMap(([p, ops]) => Object.keys(ops).map((m) => `${m.toUpperCase()} ${p}`));
  it('les 9 routes E1 sont au contrat, owner game, limitees comme la section 12 du design', () => {
    const want: Record<string, [string, number, number]> = {
      'GET /docs/{docId}/exercices': ['exo-list', 10, 20], 'POST /docs/{docId}/exercices': ['exo-post', 1, 3], 'GET /exercices/{exoId}': ['exo-get', 10, 20],
      'POST /exercices/{exoId}/indice': ['exo-hint-post', 2, 5], 'POST /exercices/{exoId}/solution': ['exo-solution-post', 2, 5], 'POST /exercices/{exoId}/copies': ['copies-create', 1, 3],
      'POST /copies/{copieId}/submit': ['copies-submit', 1, 3], 'GET /copies/{copieId}': ['copie-get', 5, 10], 'DELETE /copies/{copieId}': ['copie-delete', 2, 5],
    };
    for (const [route, [handler, rate, burst]] of Object.entries(want)) {
      expect(contract).toContain(route);
      expect(ROUTES.find((r) => r.route === route), route).toMatchObject({ handler, owner: 'game', throttle: { rate, burst } });
    }
    expect(Object.keys(want)).toHaveLength(9);
  });

  it('budget securite-40: avec budgetAction, la pile depend de pipeline, verify et exo (les roles cibles existent avant)', () => {
    const app = new App({ context: { budgetAction: 'true' } });
    for (const s of ['pipeline', 'verify', 'exo']) new Stack(app, stackName('prod', s));
    const b = new BudgetStack(app, stackName('prod', 'budget'), { envName: 'prod', alertEmail: 'a@example.org' });
    expect(b.dependencies.map((d) => d.stackName).sort()).toEqual(['pipeline', 'verify', 'exo'].map((s) => stackName('prod', s)).sort());
    const sans = new App();
    for (const s of ['pipeline', 'verify', 'exo']) new Stack(sans, stackName('prod', s));
    expect(new BudgetStack(sans, stackName('prod', 'budget'), { envName: 'prod', alertEmail: 'a@example.org' }).dependencies).toEqual([]);
  });
});
