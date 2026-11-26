// M1 #90 (docs/M1-design.md 7.3): sur le gabarit SYNTHETISE (dev et prod), (1) les droits declares dans shared/revise-access.ts sont accordes au role de chaque fonction,
// (2) les deux roles nouveaux n'ont RIEN de plus (ni Bedrock, ni S3, ni COST# en ecriture, `revise-start` n'ecrit dans aucune partition DOC#), (3) la machine `revise`
// transmet les quatre identifiants a CHAQUE tache (une cle oubliee y arrive `undefined`: revue #100 B1), a un delai et un `Catch` vers `rev-fail` partout, (4) l'interrupteur est ferme par defaut.
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { REVISE_TASK_TIMEOUT_S, reviseMachineTimeoutS } = await import('../lib/pipeline-stack.js');
import { REVISE_HANDLERS, REVISE_INPUT_KEYS, type Partition } from '../../shared/revise-access.js';
import { ENVS, processingRoleNames, reviseRoleName, reviseStartRoleName, stackName } from '../../shared/names.js';
import { run, type Def, type Handlers } from './sfn-sim.js';

type Stmt = { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Res = { Type: string; Properties: Record<string, unknown> };
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const acts = (s: Stmt) => list(s.Action).map(String);

function world(env: (typeof ENVS)[number], context?: Record<string, string>) {
  const app = buildApp(env, 'test@example.invalid', context);
  const templates = (app.node.children.filter((c) => 'templateOptions' in c) as unknown as Parameters<typeof Template.fromStack>[0][]).map((s) => Template.fromStack(s).toJSON() as { Resources: Record<string, Res> });
  const all: Record<string, Res> = Object.assign({}, ...templates.map((t) => t.Resources));
  /** Instructions `Allow` du role de la fonction `qcm-<env>-<handler>` (toutes stacks). */
  const statementsOf = (handler: string): Stmt[] => {
    const fn = Object.values(all).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === `qcm-${env}-${handler}`);
    if (!fn) throw new Error(`fonction ${handler} absente`);
    const role = (fn.Properties.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0];
    return Object.values(all)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && (r.Properties.Roles as { Ref: string }[]).some((x) => x.Ref === role))
      .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement)
      .filter((s) => s.Effect === 'Allow');
  };
  const roleStatements = (roleName: string): Stmt[] => {
    const id = Object.entries(all).find(([, r]) => r.Type === 'AWS::IAM::Role' && r.Properties.RoleName === roleName)?.[0];
    if (!id) throw new Error(`role ${roleName} absent`);
    return Object.values(all).filter((r) => r.Type === 'AWS::IAM::Policy' && (r.Properties.Roles as { Ref: string }[]).some((x) => x.Ref === id)).flatMap((r) => (r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement);
  };
  return { all, templates, statementsOf, roleStatements };
}
const covers = (key: string, p: Partition, env: string) => key === (p === 'COST#' ? `COST#${env}` : `${p}*`);
const VERB = { get: 'dynamodb:GetItem', query: 'dynamodb:Query', put: 'dynamodb:PutItem', update: 'dynamodb:UpdateItem', batch: 'dynamodb:BatchWriteItem' } as const;

for (const env of ENVS) {
  const w = world(env);
  describe(`M1 #90 (${env}): droits synthetises = droits declares`, () => {
    for (const [handler, { access }] of Object.entries(REVISE_HANDLERS)) {
      it(`${handler}: chaque (verbe, partition) declare est accorde au role de la fonction (LeadingKeys compris)`, () => {
        const ddb = w.statementsOf(handler).filter((s) => acts(s).some((a) => a.startsWith('dynamodb:')));
        const granted = (action: string, p: Partition): boolean => ddb.some((s) => acts(s).includes(action) && (s.Condition ? list(s.Condition['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] as string[]).some((k) => covers(k, p, env)) : true)); // sans condition: toute partition
        for (const [verb, action] of Object.entries(VERB)) for (const p of access[verb as keyof typeof VERB]) expect(granted(action, p), `${action} sur ${p} non accorde a ${handler}`).toBe(true);
        if (access.sfn) expect(w.statementsOf(handler).some((s) => acts(s).includes('states:StartExecution')), `${handler}: StartExecution`).toBe(true);
      });
    }
    for (const [name, key] of [[reviseStartRoleName(env), 'reviseStart'], [reviseRoleName(env), 'revise']] as const) {
      it(`${name}: rien de plus que ce que declarent ses handlers; sans Bedrock, S3, ni joker; hors processingRoleNames`, () => {
        const st = w.roleStatements(name).filter((s) => s.Effect === 'Allow');
        for (const s of st) for (const a of acts(s)) expect(a, 'action avec joker').not.toMatch(/\*/);
        const actions = st.flatMap(acts).filter((a) => !a.startsWith('logs:'));
        expect(actions.filter((a) => /^(bedrock|s3|cloudwatch|lambda|ssm):/.test(a))).toEqual([]);
        expect(processingRoleNames(env)).not.toContain(name);
        // partitions accordees par verbe <= union des declarations
        const declared = (verb: 'get' | 'query' | 'put' | 'update' | 'batch') => new Set(Object.values(REVISE_HANDLERS).filter((h) => h.role === key).flatMap((h) => h.access[verb]));
        for (const s of st.filter((x) => acts(x).some((a) => a.startsWith('dynamodb:')))) {
          expect(s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'], 'DynamoDB sans LeadingKeys').toBeDefined();
          const verb = acts(s).includes('dynamodb:GetItem') ? 'get' : acts(s).includes('dynamodb:Query') ? 'query' : acts(s).includes('dynamodb:BatchWriteItem') ? 'batch' : acts(s).includes('dynamodb:PutItem') ? 'put' : 'update';
          for (const k of list(s.Condition!['ForAllValues:StringLike']['dynamodb:LeadingKeys'] as string[])) expect([...declared(verb)].some((p) => covers(k, p, env)), `${k} accorde en ${verb} sans declaration`).toBe(true);
          expect(acts(s)).toHaveLength(1); // une action par instruction: PutItem n'est pas UpdateItem
        }
      });
    }
    it('revise-start n\'ecrit dans aucune partition DOC#; revise n\'a ni COST# ni S3; ni DeleteItem nulle part', () => {
      const writes = (name: string) => w.roleStatements(name).filter((s) => acts(s).some((a) => /PutItem|UpdateItem|BatchWriteItem|DeleteItem/.test(a)));
      for (const s of writes(reviseStartRoleName(env))) expect(JSON.stringify(s.Condition)).not.toContain('DOC#');
      expect(JSON.stringify(w.roleStatements(reviseRoleName(env)))).not.toContain('COST#');
      for (const n of [reviseStartRoleName(env), reviseRoleName(env)]) expect(w.roleStatements(n).flatMap(acts)).not.toContain('dynamodb:DeleteItem');
    });
    it('revise-start: StartExecution sur la SEULE machine revise; revise-get ne lit pas JOB# (copie de travail)', () => {
      const sf = w.roleStatements(reviseStartRoleName(env)).filter((s) => acts(s).includes('states:StartExecution'));
      expect(sf).toHaveLength(1);
      expect(JSON.stringify(sf[0].Resource)).toContain(`qcm-${env}-revise`);
      expect(JSON.stringify(sf[0].Resource)).not.toContain('"*"');
      const keysOfGet = w.statementsOf('revise-get').filter((s) => acts(s).includes('dynamodb:GetItem')).flatMap((s) => list(s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'] as string[]));
      expect(keysOfGet).not.toContain('JOB#*');
    });
    it('Bedrock inchange: seul pipeline-role (rev-extract, rev-generate) appelle le modele', () => {
      for (const h of ['rev-prepare', 'rev-commit', 'rev-fail', 'revise-create', 'revise-cancel', 'revise-get']) expect(w.statementsOf(h).flatMap(acts).filter((a) => a.startsWith('bedrock:')), h).toEqual([]);
      for (const h of ['rev-extract', 'rev-generate']) expect(w.statementsOf(h).flatMap(acts)).toContain('bedrock:InvokeModel');
    });
  });

  describe(`M1 #90 (${env}): machine revise`, () => {
    const machine = Object.values(w.all).find((r) => r.Type === 'AWS::StepFunctions::StateMachine' && r.Properties.StateMachineName === `qcm-${env}-revise`)!;
    const def = JSON.parse((machine.Properties.DefinitionString as { 'Fn::Join': [string, unknown[]] })['Fn::Join'][1].map((x) => (typeof x === 'string' ? x : 'REF')).join('')) as Def & { TimeoutSeconds?: number };
    type St = { Type: string; Parameters?: Record<string, unknown>; TimeoutSeconds?: number; Catch?: { Next: string }[]; ItemProcessor?: { States: Record<string, St> }; ItemSelector?: Record<string, unknown> };
    const flatStates = (s: Record<string, St>): Record<string, St> => Object.assign({}, ...Object.entries(s).map(([k, v]) => ({ [k]: v, ...(v.ItemProcessor ? flatStates(v.ItemProcessor.States) : {}) })));
    const states = flatStates(def.States as Record<string, St>);
    const tasks = Object.entries(states).filter(([, s]) => s.Type === 'Task');

    it('CHAQUE tache recoit toutes les cles de l\'entree (revisionId, sid, fid, coursId), la verification ses 3 cles', () => {
      expect(tasks.length).toBe(6);
      for (const [name, s] of tasks) {
        const keysIn = Object.keys(s.Parameters ?? {}).map((k) => k.replace(/\.\$$/, ''));
        if (name === 'VerificationModification') expect(keysIn.sort()).toEqual(['budgetRestantCentimes', 'docId', 'jobId']);
        else for (const k of Object.keys(REVISE_INPUT_KEYS)) expect(keysIn, `${name}: cle ${k} non transmise`).toContain(k);
      }
      // le Map transmet les memes cles et le rang de la fiche aux taches qu'il contient
      const map = Object.values(states).find((s) => s.Type === 'Map')!;
      expect(Object.keys(map.ItemSelector!).map((k) => k.replace(/\.\$$/, '')).sort()).toEqual([...Object.keys(REVISE_INPUT_KEYS), 'index'].sort());
      for (const n of ['ExtractionModification', 'GenerationModification']) expect(Object.keys(states[n].Parameters!)).toContain('index.$');
    });
    it('chaque tache a un delai, et toute tache hors Map (ou le Map) a un Catch vers rev-fail', () => {
      for (const [name, s] of tasks) expect(s.TimeoutSeconds, name).toBeGreaterThan(0);
      for (const n of ['PreparationModification', 'Fiches-modification', 'ValidationModification']) expect(states[n].Catch?.[0].Next, n).toBe('EchecModification');
      expect(states.EchecModification.Type).toBe('Task');
    });
    it('delai de machine: au moins le chemin le plus long (jamais le mecanisme d\'echec)', () => {
      const T = REVISE_TASK_TIMEOUT_S;
      expect(def.TimeoutSeconds).toBe(reviseMachineTimeoutS());
      expect(def.TimeoutSeconds!).toBeGreaterThan(T.prepare + 3 * (T.extract + T.verify + T.generate) + T.commit + T.fail);
    });
    // Rejoue la DEFINITION synthetisee: chaque tache qui echoue mene a rev-fail, avec les identifiants intacts; sans panne, la machine va jusqu'au bout.
    const ok: Handlers = {
      PreparationModification: () => ({ indices: [0, 1] }),
      ExtractionModification: () => ({ ok: true, docId: 'W', claims: 1, budgetRestantCentimes: 3 }),
      VerificationModification: () => ({}),
      GenerationModification: () => ({}),
      ValidationModification: () => ({}),
      EchecModification: () => ({}),
    };
    const input = { revisionId: 'R1', sid: 's1', fid: 'f1', coursId: 'C1' };
    it('sans panne: preparation, 2 fiches (extraction, verification, generation), validation; aucun rev-fail', async () => {
      const r = await run(def, input, ok);
      expect(r.endType).toBe('Succeed');
      expect(r.calls.map((c) => c.state)).toEqual(['PreparationModification', 'ExtractionModification', 'VerificationModification', 'GenerationModification', 'ExtractionModification', 'VerificationModification', 'GenerationModification', 'ValidationModification']);
      for (const c of r.calls) for (const k of Object.keys(REVISE_INPUT_KEYS)) if (c.state !== 'VerificationModification') expect((c.input as Record<string, unknown>)[k], `${c.state}.${k}`).toBe((input as Record<string, string>)[k]);
    });
    for (const [name] of tasks.filter(([n]) => n !== 'EchecModification')) {
      it(`${name} en echec: rev-fail est appele avec les 4 identifiants, la machine finit en Fail`, async () => {
        const r = await run(def, input, { ...ok, [name]: () => { throw new Error('panne'); } });
        expect(r.endType).toBe('Fail');
        const fail = r.calls.at(-1)!;
        expect(fail.state).toBe('EchecModification');
        expect(fail.input).toEqual(input);
      });
    }
  });

  describe(`M1 #90 (${env}): interrupteur`, () => {
    const envOf = (ctx?: Record<string, string>) => {
      const x = world(env, ctx);
      const fn = Object.values(x.all).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === `qcm-${env}-revise-create`)!;
      return (fn.Properties.Environment as { Variables: Record<string, unknown> }).Variables;
    };
    it('ferme par defaut, ouvert seulement avec -c revise=true; la fonction pointe la machine revise', () => {
      expect(envOf().REVISE_ENABLED).toBe('false');
      expect(envOf({ revise: 'true' }).REVISE_ENABLED).toBe('true');
      expect(envOf({ revise: 'false' }).REVISE_ENABLED).toBe('false');
      expect(JSON.stringify(envOf().QCM_STATE_MACHINE_ARN)).toContain(`qcm-${env}-revise`);
    });
    it('toutes les ressources nouvelles portent les tags (project, Environment, ManagedBy, Owner)', () => {
      for (const [id, r] of Object.entries(w.all)) {
        const nameOf = String(r.Properties.RoleName ?? r.Properties.FunctionName ?? r.Properties.StateMachineName ?? '');
        if (!/qcm-(dev|prod)-(revise|rev-)/.test(nameOf)) continue;
        const keys = ((r.Properties.Tags as { Key: string }[] | undefined) ?? []).map((x) => x.Key);
        for (const k of ['project', 'Environment', 'ManagedBy', 'Owner']) expect(keys, `${id}`).toContain(k);
      }
    });
  });
}
void stackName;
