// TEST CLE (E1, faille recurrente de #95 et #96: un droit oublie). Pour CHAQUE handler de shared/exo-access.ts (source unique):
//  1. on retrouve dans le gabarit SYNTHETISE le role de LA Lambda de ce handler (pas un role suppose);
//  2. chaque (verbe, partition) et chaque droit S3 declare y est accorde, avec `dynamodb:LeadingKeys` qui couvre la partition;
//  3. reciproquement, un role propre a E1 n'a RIEN de plus: comparaison d'ensembles (actions, partitions, S3), moindre privilege exact.
// `play` sert aussi des handlers hors E1: on n'y verifie que l'inclusion, plus l'absence de DeleteItem et de S3.
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
import { E1_HANDLERS, type E1Role, type Partition } from '../../shared/exo-access.js';
import { ENVS, stackName, type Env } from '../../shared/names.js';

type Stmt = { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Res = { Type: string; Properties: Record<string, unknown> };
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const acts = (s: Stmt) => list(s.Action).map(String);
/** Aplatit une valeur CloudFormation (Ref, GetAtt, Join) en texte. */
function flat(v: unknown): string {
  if (typeof v === 'string') return v;
  const o = v as Record<string, unknown>;
  if (o && typeof o.Ref === 'string') return `{Ref:${o.Ref}}`;
  const j = o?.['Fn::Join'] as [string, unknown[]] | undefined;
  if (j) return j[1].map(flat).join(j[0]);
  return JSON.stringify(v);
}

const PARTITIONS: Partition[] = ['STUDENT#', 'DOC#', 'FAMILY#', 'COST#'];
const VERBS = { get: ['dynamodb:GetItem'], query: ['dynamodb:Query'], write: ['dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem'], delete: ['dynamodb:DeleteItem'] } as const;
type Verb = keyof typeof VERBS;
/** Role CloudFormation attendu (RoleName) de chaque role E1. */
const roleNameOf = (env: Env, r: E1Role): string => ({ exoRole: `qcm-${env}-exo-role`, copieRole: `qcm-${env}-copie-role`, copieStart: `qcm-${env}-game-copieStart-role`, play: `qcm-${env}-game-play-role`, copieDelete: `qcm-${env}-game-copieDelete-role` })[r];
/** Un motif de LeadingKeys couvre-t-il une partition? `STUDENT#*` couvre `STUDENT#`; `COST#dev` couvre `COST#`; jamais `*` seul. */
const covers = (key: string, p: Partition) => key !== '*' && key.startsWith(p) && (key === `${p}*` || (p === 'COST#' && /^COST#(dev|prod)$/.test(key)));
const partitionOf = (key: string): Partition => {
  const hits = PARTITIONS.filter((p) => covers(key, p));
  expect(hits, `motif de LeadingKeys non reconnu: ${key}`).toHaveLength(1);
  return hits[0];
};

function index(env: Env) {
  const app = buildApp(env, 'test@example.invalid');
  const templates = ['game', 'exo'].map((s) => Template.fromStack(app.node.findChild(stackName(env, s)) as never).toJSON() as { Resources: Record<string, Res> });
  /** Fonction (par nom) -> nom du role. */
  const roleOfFn = new Map<string, string>();
  const stmtsOfRole = new Map<string, Stmt[]>();
  for (const t of templates) {
    for (const r of Object.values(t.Resources)) {
      if (r.Type === 'AWS::Lambda::Function') {
        const ref = (r.Properties.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0];
        roleOfFn.set(String(r.Properties.FunctionName), String(t.Resources[ref].Properties.RoleName));
      }
      if (r.Type === 'AWS::IAM::Policy') {
        for (const ref of r.Properties.Roles as { Ref: string }[]) {
          const n = String(t.Resources[ref.Ref].Properties.RoleName);
          stmtsOfRole.set(n, [...(stmtsOfRole.get(n) ?? []), ...((r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement)]);
        }
      }
    }
  }
  return { roleOfFn, stmtsOfRole };
}

/** Partitions accordees (motifs de LeadingKeys) par action DynamoDB; echoue si une instruction DynamoDB n'est pas limitee par LeadingKeys. */
function ddbGrants(stmts: Stmt[], role: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of stmts.filter((x) => x.Effect === 'Allow' && acts(x).some((a) => a.startsWith('dynamodb:')))) {
    const keys = s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
    expect(keys, `${role}: instruction DynamoDB sans dynamodb:LeadingKeys`).toBeDefined();
    for (const a of acts(s)) out.set(a, [...(out.get(a) ?? []), ...list(keys as string[] | string)]);
  }
  return out;
}

/** Droits S3 sur copies/: verbe -> vrai; toute autre forme S3 (autre prefixe, autre action) est une erreur. */
function s3Grants(stmts: Stmt[], role: string): { get: boolean; put: boolean; delete: boolean; list: boolean } {
  const g = { get: false, put: false, delete: false, list: false };
  for (const s of stmts.filter((x) => x.Effect === 'Allow' && acts(x).some((a) => a.startsWith('s3:')))) {
    for (const a of acts(s)) {
      if (a === 's3:ListBucket') {
        expect(list(s.Condition?.StringLike?.['s3:prefix'] as string[]), `${role}: ListBucket sans condition de prefixe copies/`).toEqual(['copies/*']);
        g.list = true;
      } else {
        const res = list(s.Resource).map(flat);
        expect(res, `${role}: ${a} hors de copies/*`).toHaveLength(1);
        expect(res[0], `${role}: ${a} hors de copies/*`).toMatch(/\/copies\/\*$/);
        if (a === 's3:GetObject') g.get = true;
        else if (a === 's3:PutObject') g.put = true;
        else if (a === 's3:DeleteObject') g.delete = true;
        else expect.fail(`${role}: action S3 inattendue ${a}`);
      }
    }
  }
  return g;
}

describe.each(ENVS)('E1: droits du role de chaque handler = shared/exo-access.ts (%s)', (env) => {
  const { roleOfFn, stmtsOfRole } = index(env);

  it('chaque handler E1 a une fonction synthetisee, rattachee au role attendu', () => {
    for (const [name, h] of Object.entries(E1_HANDLERS)) expect(roleOfFn.get(`qcm-${env}-${name}`), name).toBe(roleNameOf(env, h.role));
  });

  describe.each(Object.entries(E1_HANDLERS))('%s', (name, h) => {
    const role = () => roleOfFn.get(`qcm-${env}-${name}`)!;
    const stmts = () => stmtsOfRole.get(role()) ?? [];

    it('chaque acces declare est accorde (DynamoDB couvert par LeadingKeys, S3 sur copies/ seulement)', () => {
      const ddb = ddbGrants(stmts(), role());
      for (const v of Object.keys(VERBS) as Verb[]) {
        for (const p of h.access[v]) {
          for (const a of VERBS[v]) expect((ddb.get(a) ?? []).some((k) => covers(k, p)), `${name}: ${a} sur ${p} non accorde a ${role()}`).toBe(true);
        }
      }
      const s3 = s3Grants(stmts(), role());
      for (const k of ['get', 'put', 'delete', 'list'] as const) if (h.access.s3?.[k]) expect(s3[k], `${name}: s3 ${k} non accorde`).toBe(true);
    });
  });

  describe.each((['exoRole', 'copieRole', 'copieStart', 'copieDelete'] as E1Role[]))('moindre privilege exact: %s', (r) => {
    const mine = Object.values(E1_HANDLERS).filter((h) => h.role === r);
    const name = roleNameOf(env, r);
    it('rien de plus que l\'union des acces declares par ses handlers (DynamoDB, S3, autres services)', () => {
      const stmts = stmtsOfRole.get(name) ?? [];
      expect(stmts.length, name).toBeGreaterThan(0);
      for (const s of stmts) expect(s.Effect).toBe('Allow');
      const ddb = ddbGrants(stmts, name);
      const wantActions = new Set<string>();
      for (const v of Object.keys(VERBS) as Verb[]) {
        const want = new Set<Partition>(mine.flatMap((h) => h.access[v]));
        for (const a of VERBS[v]) {
          if (want.size) wantActions.add(a);
          const got = new Set((ddb.get(a) ?? []).map(partitionOf));
          expect([...got].sort(), `${name}: partitions de ${a}`).toEqual([...want].sort());
        }
      }
      // aucune autre action DynamoDB (BatchWriteItem, Scan, DeleteItem en trop...)
      expect([...ddb.keys()].sort()).toEqual([...wantActions].sort());
      // S3: ensemble exact
      const s3 = s3Grants(stmts, name);
      const wantS3 = { get: false, put: false, delete: false, list: false };
      for (const h of mine) for (const k of ['get', 'put', 'delete', 'list'] as const) if (h.access.s3?.[k]) wantS3[k] = true;
      expect(s3, `${name}: droits S3`).toEqual(wantS3);
      // services autorises hors DynamoDB et S3: journaux, metrique de cout, Bedrock (roles de traitement), machine `copie` (copieStart)
      const others = new Set(stmts.flatMap(acts).filter((a) => !/^(dynamodb|s3):/.test(a)));
      const allowed: Record<string, string[]> = {
        exoRole: ['bedrock:InvokeModel', 'cloudwatch:PutMetricData', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        copieRole: ['bedrock:InvokeModel', 'cloudwatch:PutMetricData', 'logs:CreateLogStream', 'logs:PutLogEvents'],
        copieStart: ['logs:CreateLogStream', 'logs:PutLogEvents', 'states:StartExecution'],
        copieDelete: ['logs:CreateLogStream', 'logs:PutLogEvents'],
      };
      expect([...others].sort()).toEqual([...allowed[r]].sort());
    });
  });

  it('play: inclut tout ce que declarent exo-* et copie-get, mais jamais DeleteItem ni S3', () => {
    const name = roleNameOf(env, 'play');
    const stmts = stmtsOfRole.get(name) ?? [];
    expect(stmts.flatMap(acts)).not.toContain('dynamodb:DeleteItem');
    expect(stmts.flatMap(acts).filter((a) => a.startsWith('s3:'))).toEqual([]);
    // la seule action hors DynamoDB et journaux: lancer exo-gen
    expect(stmts.flatMap(acts).filter((a) => !/^(dynamodb|logs):/.test(a))).toEqual(['lambda:InvokeFunction']);
  });
});
