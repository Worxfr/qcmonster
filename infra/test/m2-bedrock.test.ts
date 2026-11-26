// Test M2 (docs/cost-guard.md): AUCUN role IAM ne peut appeler Bedrock sans passer par le garde de cout.
// Le garde est `shared/bedrock.ts`; il ne protege que les identites qui l'utilisent, donc seules celles de `processingRoleNames` peuvent invoquer un modele,
// et seulement sur les profils d'inference de QCMonster. Le test lit le template synthetise de TOUTES les stacks (donc aussi celles que d'autres lots
// ajouteront): politiques en ligne, politiques jointes, politiques gerees du client ET politiques gerees AWS (liste blanche de noms).
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { App, Stack } from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });

const { buildApp } = await import('../bin/app.js');
const { EU_REGIONS, SYSTEM_PROFILES } = await import('../lib/models-stack.js');
const { evalRunRoleNames } = await import('../lib/eval-stack.js');
import { ENVS, processingRoleNames, type Env } from '../../shared/names.js';

type Json = Record<string, unknown>;
type Stmt = { Effect?: string; Action?: string | string[]; NotAction?: unknown; Resource?: unknown; NotResource?: unknown; Condition?: Json };
type Res = { Type: string; Properties?: Json };
type Tpl = { name: string; json: { Resources?: Record<string, Res> } };

/** Actions Bedrock qui lancent un modele ou un agent (une action `*` ou `bedrock:*` les couvre toutes). */
const INVOKE_ACTIONS = [
  'bedrock:InvokeModel', 'bedrock:InvokeModelWithResponseStream', 'bedrock:Converse', 'bedrock:ConverseStream', 'bedrock:InvokeAgent',
  'bedrock:InvokeInlineAgent', 'bedrock:InvokeFlow', 'bedrock:StartAsyncInvoke', 'bedrock:CreateModelInvocationJob', 'bedrock:Retrieve',
  'bedrock:RetrieveAndGenerate', 'bedrock:ApplyGuardrail',
];
/** Seule action permise aux roles de traitement (l'API Converse demande bedrock:InvokeModel). */
const ONLY_ACTION = 'bedrock:InvokeModel';
/** Politiques gerees AWS permises: aucune n'ouvre Bedrock. Tout autre nom echoue (liste blanche, pas liste noire). */
const ALLOWED_AWS_MANAGED = ['service-role/AWSLambdaBasicExecutionRole'];

const globRe = (g: string) => new RegExp('^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*').replace(/\?/g, '.') + '$', 'i');
const canInvoke = (actions: string[]) => actions.some((a) => INVOKE_ACTIONS.some((i) => globRe(a).test(i)));

/** Aplatit une valeur CloudFormation en texte: Ref -> `{Ref:X}`, Fn::Join -> concatenation, le reste -> JSON. */
function flat(v: unknown): string {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    const o = v as Json;
    if (typeof o.Ref === 'string') return `{Ref:${o.Ref}}`;
    const join = o['Fn::Join'] as [string, unknown[]] | undefined;
    if (join) return join[1].map(flat).join(join[0]);
  }
  return JSON.stringify(v);
}
const list = (v: unknown): unknown[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/** Ressources permises pour un role de traitement (motifs sur le texte aplati). */
function allowed(env: Env) {
  const app = new RegExp(`^(\\{Ref:SsmParameterValueqcm${env}models(haiku|sonnet)[A-Za-z0-9]*Parameter\\}|arn:[a-z-]+:bedrock:eu-west-3:(\\d{12}|\\{Ref:AWS::AccountId\\}):application-inference-profile/qcm-${env}-(haiku|sonnet))$`);
  const ids = Object.values(SYSTEM_PROFILES);
  const sys = new RegExp(`^arn:(aws|\\{Ref:AWS::Partition\\}):bedrock:eu-west-3:(\\d{12}|\\{Ref:AWS::AccountId\\}):inference-profile/(${ids.map((i) => i.replace(/\./g, '\\.')).join('|')})$`);
  const base = ids.map((i) => i.replace(/^eu\./, '').replace(/\./g, '\\.')).join('|');
  const model = new RegExp(`^arn:(aws|\\{Ref:AWS::Partition\\}):bedrock:(${EU_REGIONS.join('|')})::foundation-model/(${base})$`);
  return { app, sys, model, profile: (s: string) => app.test(s) || sys.test(s) };
}

/** Verifie une declaration Allow qui peut invoquer Bedrock. Renvoie les raisons de refus. */
function checkGrant(env: Env, s: Stmt): string[] {
  const out: string[] = [];
  const actions = list(s.Action).map(String);
  if (s.NotAction !== undefined || s.NotResource !== undefined) return ['NotAction/NotResource sur une declaration Allow'];
  for (const a of actions) if (a !== ONLY_ACTION) out.push(`action ${a} (seule ${ONLY_ACTION} est permise)`);
  const a = allowed(env);
  const resources = list(s.Resource).map(flat);
  if (resources.length === 0) out.push('aucune ressource');
  const cond = s.Condition as Record<string, Record<string, unknown>> | undefined;
  const viaProfile = Object.values(cond ?? {}).flatMap((c) => list(c['bedrock:InferenceProfileArn']).map(flat));
  for (const r of resources) {
    if (r.includes('*')) out.push(`joker dans la ressource ${r}`);
    else if (a.profile(r)) continue;
    else if (a.model.test(r)) {
      // Le modele de base n'est ouvert que lorsque l'appel passe par un profil QCMonster.
      if (viaProfile.length === 0 || !viaProfile.every(a.profile)) out.push(`modele de base sans condition bedrock:InferenceProfileArn vers un profil QCMonster (${r})`);
    } else out.push(`ressource hors profils QCMonster ${r}`);
  }
  for (const c of viaProfile) if (c.includes('*')) out.push(`joker dans la condition ${c}`);
  return out;
}

/** Roles autorises a ouvrir Bedrock: traitement (L2a/L2b) et, en dev seulement, `eval-run` (voie d'evaluation, E1). Jamais en prod. */
const bedrockRoles = (env: Env): string[] => [...processingRoleNames(env), ...evalRunRoleNames(env)];

const stmtsOf = (doc: unknown): Stmt[] => list((doc as { Statement?: unknown } | undefined)?.Statement) as Stmt[];

/** Audit M2 de templates synthetises: renvoie la liste des violations (vide = conforme) et le nombre de declarations qui ouvrent Bedrock. */
function audit(env: Env, tpls: Tpl[]): { violations: string[]; grants: Set<string> } {
  const violations: string[] = [];
  const grants = new Set<string>();
  for (const { name, json } of tpls) {
    const res = json.Resources ?? {};
    const roleName = (ref: unknown): string => {
      const id = (ref as { Ref?: string })?.Ref;
      const r = id ? res[id] : undefined;
      const n = r?.Properties?.RoleName;
      return typeof n === 'string' ? n : `${name}:${id ?? flat(ref)}`; // role sans nom fixe: ne peut pas figurer dans la liste
    };
    const who = (id: string, r: Res) => (r.Type === 'AWS::IAM::Role' && typeof r.Properties?.RoleName === 'string' ? (r.Properties.RoleName as string) : `${name}:${id}`);
    const checkStatements = (stmts: Stmt[], principals: string[], where: string) => {
      for (const s of stmts) {
        if (s.Effect !== 'Allow') continue;
        const actions = list(s.Action).map(String);
        if (s.NotAction === undefined && !canInvoke(actions)) continue;
        if (principals.length === 0) violations.push(`${where}: politique qui ouvre Bedrock sans role identifie (jointe plus tard?)`);
        for (const p of principals) {
          grants.add(p);
          if (!bedrockRoles(env).includes(p)) violations.push(`${p} ne figure pas dans processingRoleNames (ni parmi les roles d'evaluation dev) mais ouvre Bedrock (${where})`);
        }
        for (const reason of checkGrant(env, s)) violations.push(`${where}: ${reason}`);
      }
    };
    for (const [id, r] of Object.entries(res)) {
      const p = r.Properties ?? {};
      if (r.Type === 'AWS::IAM::Policy' || r.Type === 'AWS::IAM::ManagedPolicy') {
        const principals = [...list(p.Roles).map(roleName), ...list(p.Users).map((u) => `${name}:user:${flat(u)}`), ...list(p.Groups).map((g) => `${name}:group:${flat(g)}`)];
        checkStatements(stmtsOf(p.PolicyDocument), principals, `${name}:${id}`);
      }
      if (['AWS::IAM::Role', 'AWS::IAM::User', 'AWS::IAM::Group'].includes(r.Type)) {
        for (const pol of list(p.Policies) as { PolicyDocument?: unknown }[]) checkStatements(stmtsOf(pol.PolicyDocument), [who(id, r)], `${name}:${id} (politique en ligne)`);
        for (const arn of list(p.ManagedPolicyArns)) {
          const t = flat(arn);
          const aws = /:iam::aws:policy\/(.+)$/.exec(t);
          const local = (arn as { Ref?: string })?.Ref && res[(arn as { Ref: string }).Ref]?.Type === 'AWS::IAM::ManagedPolicy';
          if (aws ? !ALLOWED_AWS_MANAGED.includes(aws[1]) : !local) violations.push(`${who(id, r)}: politique geree non autorisee ${t}`);
        }
      }
    }
  }
  return { violations, grants };
}

const toTpls = (stacks: { name: string; t: Template }[]): Tpl[] => stacks.map(({ name, t }) => ({ name, json: t.toJSON() }));
// En dev, la voie d'evaluation est synthetisee aussi (`-c evalPath=true`): son role d'execution est audite comme les autres.
const EVAL_CTX = { evalPath: 'true', evalSubPrefix: 'repo:Exemple@1/depot@2' };
const realTemplates = (env: Env): Tpl[] => {
  const app = buildApp(env, 'test@example.invalid', env === 'dev' ? EVAL_CTX : undefined);
  return toTpls(app.node.children.filter((c) => c.node.id.startsWith(`qcm-${env}-`)).map((s) => ({ name: s.node.id, t: Template.fromStack(s as never) })));
};
const synth = (build: (s: Stack) => void): Tpl[] => {
  const s = new Stack(new App(), 'Neg');
  build(s);
  return toTpls([{ name: 'Neg', t: Template.fromStack(s) }]);
};

describe.each(ENVS)('M2: aucune identite ne peut invoquer Bedrock hors du garde (%s)', (env) => {
  it('stacks reelles: seuls les roles de traitement invoquent Bedrock, sur les profils QCMonster, sans joker', () => {
    const { violations, grants } = audit(env, realTemplates(env));
    expect(violations).toEqual([]);
    expect([...grants].sort()).toEqual([...bedrockRoles(env)].sort()); // non vacuite: tous les roles attendus sont vus (eval-run en dev seulement)
  });

  describe('test negatif sur de vrais templates (le detecteur echoue quand il le faut)', () => {
    const lambda = new iam.ServicePrincipal('lambda.amazonaws.com');
    const proc = processingRoleNames(env)[1];
    const profile = `arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/qcm-${env}-sonnet`;
    const fm = (region: string) => `arn:aws:bedrock:${region}::foundation-model/anthropic.claude-sonnet-5-5`;
    const roleWith = (roleName: string | undefined, st: iam.PolicyStatementProps) => synth((s) => new iam.Role(s, 'R', { roleName, assumedBy: lambda }).addToPrincipalPolicy(new iam.PolicyStatement(st)));
    const bad = (t: Tpl[], re: RegExp) => expect(audit(env, t).violations.join('\n')).toMatch(re);

    it('profil QCMonster exact: accepte', () => {
      expect(audit(env, roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: [profile] })).violations).toEqual([]);
    });
    it('jokers: ressource *, action bedrock:*, action *, action Invoke*, region *', () => {
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: ['*'] }), /joker dans la ressource/);
      bad(roleWith(proc, { actions: ['bedrock:*'], resources: [profile] }), /action bedrock:\*/);
      bad(roleWith(proc, { actions: ['*'], resources: [profile] }), /action \*/);
      bad(roleWith(proc, { actions: ['bedrock:Invoke*'], resources: [profile] }), /action bedrock:Invoke\*/);
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: [fm('*')], conditions: { StringLike: { 'bedrock:InferenceProfileArn': profile } } }), /joker dans la ressource/);
    });
    it('ressource hors profils QCMonster: autre profil d\'application, profil systeme inconnu, modele de base dans une region non UE', () => {
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: ['arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/autre-projet'] }), /hors profils QCMonster/);
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: ['arn:aws:bedrock:eu-west-3:123456789012:inference-profile/eu.anthropic.autre-modele'] }), /hors profils QCMonster/);
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: [fm('us-east-1')], conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profile } } }), /hors profils QCMonster/);
    });
    it('modele de base sans condition de profil (ou avec un autre profil): refuse', () => {
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: [fm('eu-west-3')] }), /sans condition/);
      bad(roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: [fm('eu-west-3')], conditions: { StringEquals: { 'bedrock:InferenceProfileArn': 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/autre' } } }), /sans condition/);
      expect(audit(env, roleWith(proc, { actions: ['bedrock:InvokeModel'], resources: [fm('eu-west-3')], conditions: { StringEquals: { 'bedrock:InferenceProfileArn': profile } } })).violations).toEqual([]);
    });
    it('autres actions Bedrock que InvokeModel (Converse, streaming): refusees', () => {
      bad(roleWith(proc, { actions: ['bedrock:InvokeModelWithResponseStream'], resources: [profile] }), /seule bedrock:InvokeModel/);
      bad(roleWith(proc, { actions: ['bedrock:Converse'], resources: [profile] }), /seule bedrock:InvokeModel/);
    });
    it('role hors processingRoleNames ou sans nom fixe: refuse, meme sur un profil QCMonster', () => {
      bad(roleWith('autre-role', { actions: ['bedrock:InvokeModel'], resources: [profile] }), /autre-role ne figure pas/);
      bad(roleWith(undefined, { actions: ['bedrock:InvokeModel'], resources: [profile] }), /ne figure pas dans processingRoleNames/);
    });
    it('utilisateur, groupe, politique en ligne de role, politique orpheline: refuses', () => {
      bad(synth((s) => new iam.User(s, 'U').addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [profile] }))), /user|U/);
      bad(synth((s) => new iam.Group(s, 'G').addToPrincipalPolicy(new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [profile] }))), /group|G/);
      bad(synth((s) => void new iam.Role(s, 'R', { roleName: 'autre-role', assumedBy: lambda, inlinePolicies: { p: new iam.PolicyDocument({ statements: [new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [profile] })] }) } })), /autre-role/);
      bad(synth((s) => void new iam.ManagedPolicy(s, 'MP', { statements: [new iam.PolicyStatement({ actions: ['bedrock:InvokeModel'], resources: [profile] })] })), /sans role identifie/);
    });
    it("eval-run: autorise en dev seulement; en prod le meme role est refuse", () => {
      const evalRole = `qcm-${env}-eval-run-role`;
      const t = roleWith(evalRole, { actions: ['bedrock:InvokeModel'], resources: [profile] });
      if (env === 'dev') expect(audit(env, t).violations).toEqual([]);
      else bad(t, /eval-run-role ne figure pas/);
    });
    it('eval-run avec un joker ou une action en trop: refuse (le role d\'evaluation n\'est pas exempte des regles)', () => {
      const evalRole = `qcm-${env}-eval-run-role`;
      bad(roleWith(evalRole, { actions: ['bedrock:InvokeModel'], resources: ['*'] }), /joker dans la ressource/);
      bad(roleWith(evalRole, { actions: ['bedrock:Converse'], resources: [profile] }), /seule bedrock:InvokeModel/);
    });
    it('NotAction sur Allow: refuse', () => {
      bad(roleWith(proc, { notActions: ['s3:*'], resources: [profile] }), /NotAction/);
    });
    it('politiques gerees AWS: Bedrock, Admin, PowerUser et toute autre hors liste blanche refusees; la liste blanche passe', () => {
      for (const n of ['AmazonBedrockFullAccess', 'AmazonBedrockReadOnly', 'AdministratorAccess', 'PowerUserAccess', 'AmazonSageMakerFullAccess']) {
        bad(synth((s) => void new iam.Role(s, 'R', { roleName: proc, assumedBy: lambda, managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName(n)] })), new RegExp(`non autorisee.*${n}`));
      }
      expect(audit(env, synth((s) => void new iam.Role(s, 'R', { roleName: proc, assumedBy: lambda, managedPolicies: [iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AWSLambdaBasicExecutionRole')] }))).violations).toEqual([]);
    });
    it('un Deny Bedrock n\'est pas une ouverture (filet du budget securite-40)', () => {
      expect(audit(env, roleWith('autre-role', { effect: iam.Effect.DENY, actions: ['bedrock:InvokeModel'], resources: ['*'] })).violations).toEqual([]);
    });
  });
});

describe.each(ENVS)('M2 (E1): quatre roles de traitement, modeles par role (%s)', (env) => {
  const tpls = realTemplates(env);
  /** Ressources et conditions Bedrock (aplaties) accordees a un role nomme, toutes politiques confondues. */
  const bedrockOf = (roleName: string): string[] => {
    const out: string[] = [];
    for (const { json } of tpls) {
      const res = json.Resources ?? {};
      for (const r of Object.values(res)) {
        if (r.Type !== 'AWS::IAM::Policy') continue;
        const names = list(r.Properties?.Roles).map((x) => res[(x as { Ref: string }).Ref]?.Properties?.RoleName);
        if (!names.includes(roleName)) continue;
        for (const st of stmtsOf(r.Properties?.PolicyDocument)) {
          if (st.Effect !== 'Allow' || !list(st.Action).some((a) => String(a).startsWith('bedrock:'))) continue;
          out.push(...list(st.Resource).map(flat), ...Object.values(st.Condition ?? {}).flatMap((c) => Object.values(c as Json).flatMap((v) => list(v).map(flat))));
        }
      }
    }
    return out;
  };
  it('processingRoleNames: pipeline, verify, exo et copie', () => {
    expect(processingRoleNames(env)).toEqual([`qcm-${env}-pipeline-role`, `qcm-${env}-verify-role`, `qcm-${env}-exo-role`, `qcm-${env}-copie-role`]);
  });
  it('exo-role: Haiku seulement (aucune trace de Sonnet, ni dans les ressources ni dans les conditions)', () => {
    const b = bedrockOf(`qcm-${env}-exo-role`);
    expect(b.filter((x) => /haiku/i.test(x)).length).toBeGreaterThan(0);
    expect(b.filter((x) => /sonnet/i.test(x))).toEqual([]);
  });
  it('copie-role: Haiku et Sonnet', () => {
    const b = bedrockOf(`qcm-${env}-copie-role`);
    expect(b.some((x) => /haiku/i.test(x))).toBe(true);
    expect(b.some((x) => /sonnet/i.test(x))).toBe(true);
  });
  it("aucun autre role que les quatre (et eval-run en dev) n'a bedrock:InvokeModel", () => {
    const holders = new Set<string>();
    for (const { json } of tpls) {
      const res = json.Resources ?? {};
      for (const r of Object.values(res)) {
        if (r.Type !== 'AWS::IAM::Policy') continue;
        if (!stmtsOf(r.Properties?.PolicyDocument).some((st) => st.Effect === 'Allow' && list(st.Action).some((a) => String(a) === 'bedrock:InvokeModel'))) continue;
        for (const x of list(r.Properties?.Roles)) holders.add(String(res[(x as { Ref: string }).Ref]?.Properties?.RoleName));
      }
    }
    expect([...holders].sort()).toEqual([...bedrockRoles(env)].sort());
  });
});

describe('M2: role OIDC de deploiement (infra-bootstrap/setup-oidc.sh)', () => {
  const script = readFileSync(new URL('../../infra-bootstrap/setup-oidc.sh', import.meta.url), 'utf8');
  const policy = /POLICY="\$\(cat <<JSON\n([\s\S]*?)\nJSON/.exec(script)?.[1] ?? '';
  it('la politique du role n\'accorde que sts:AssumeRole (roles de bootstrap CDK) et ssm:GetParameter: aucune action Bedrock, aucun joker', () => {
    expect(policy).not.toBe('');
    const doc = JSON.parse(policy.replace(/\$\{[A-Z_]+\}/g, 'X')) as { Statement: Stmt[] };
    const actions = doc.Statement.flatMap((s) => list(s.Action).map(String)).sort();
    expect(actions).toEqual(['ssm:GetParameter', 'sts:AssumeRole']);
    expect(policy.toLowerCase()).not.toContain('bedrock');
    expect(canInvoke(actions)).toBe(false);
    for (const s of doc.Statement) for (const r of list(s.Resource).map(String)) expect(r).toMatch(/^arn:aws:(iam|ssm):/);
  });
  it('le script ne joint au role que sa propre politique (POLICY_ARN), aucune politique geree AWS', () => {
    const attaches = script.split('\n').filter((l) => /attach-role-policy/.test(l) && !l.trim().startsWith('#'));
    expect(attaches.length).toBeGreaterThan(0);
    for (const l of attaches) expect(l).toMatch(/--policy-arn "\$POLICY_ARN"/);
    expect(script).not.toMatch(/arn:aws:iam::aws:policy/);
  });
});
