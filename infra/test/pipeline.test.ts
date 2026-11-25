import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { API_FUNCTIONS, STEP_FUNCTIONS, TASK_TIMEOUT_S } = await import('../lib/pipeline-stack.js');
import { ENVS, processingRoleNames, stackName } from '../../shared/names.js';

const stack = (env: (typeof ENVS)[number]) => Template.fromStack(buildApp(env, 'test@example.invalid').node.findChild(stackName(env, 'pipeline')) as never);

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown };
type Pol = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } };
const statements = (t: Template, roleLogical: RegExp): Stmt[] =>
  (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => (p.Properties.Roles.some((r) => roleLogical.test(r.Ref)) ? p.Properties.PolicyDocument.Statement : []));
/** Definition de la machine en objet (les references CloudFormation sont remplacees par `REF`). */
const definition = (t: Template): { TimeoutSeconds: number; States: Record<string, { Type: string; TimeoutSeconds?: number; Retry?: unknown[]; Resource?: string }> } => {
  const sm = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0] as { Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } } };
  return JSON.parse(sm.Properties.DefinitionString['Fn::Join'][1].map((x) => (typeof x === 'string' ? x : 'REF')).join(''));
};
const actions = (s: Stmt[]) => s.flatMap((x) => (Array.isArray(x.Action) ? x.Action : [x.Action]));

describe('Pipeline (L2a)', () => {
  for (const env of ENVS) {
    describe(env, () => {
      const t = stack(env);
      it('une fonction par route et par etape, nommees qcm-<env>-<handler>', () => {
        const names = Object.values(t.findResources('AWS::Lambda::Function')).map((f) => (f as { Properties: { FunctionName: string } }).Properties.FunctionName);
        const expected = [...Object.keys(API_FUNCTIONS), ...Object.values(STEP_FUNCTIONS).map((s) => s[0])].map((h) => `qcm-${env}-${h}`);
        expect(names.sort()).toEqual(expected.sort());
        expect(names).toContain(`qcm-${env}-quota-consume`);
        expect(names).toContain(`qcm-${env}-scan-check`);
      });
      it('Bedrock simule par defaut et QCM_ENV pose', () => {
        t.hasResourceProperties('AWS::Lambda::Function', { Environment: { Variables: Match.objectLike({ QCM_ENV: env, QCM_BEDROCK: 'mock' }) } });
      });
      it('seul le role de traitement peut appeler Bedrock, et il est dans processingRoleNames', () => {
        expect(processingRoleNames(env)).toContain(`qcm-${env}-pipeline-role`);
        const roles = Object.values(t.findResources('AWS::IAM::Role')).map((r) => (r as { Properties: { RoleName?: string } }).Properties.RoleName).filter(Boolean); // la machine d'etats a son role genere (sans Bedrock)
        expect(roles.sort()).toEqual([`qcm-${env}-pipeline-api-read-role`, `qcm-${env}-pipeline-api-write-role`, `qcm-${env}-pipeline-api-delete-role`, `qcm-${env}-pipeline-role`, `qcm-${env}-pipeline-trigger-role`].sort());
        const bedrock = (re: RegExp) => actions(statements(t, re)).filter((a) => a.startsWith('bedrock:'));
        expect(bedrock(/pipelineapi/i)).toEqual([]);
        expect(bedrock(/pipelinetriggerrole/i)).toEqual([]);
        expect([...new Set(bedrock(/^pipelinerole/i))]).toEqual(['bedrock:InvokeModel']);
      });
      it('C2: roles API separes lecture/ecriture/suppression, DynamoDB limite par LeadingKeys, sans droit superflu', () => {
        const writes = /Put|Update|Delete|BatchWrite/;
        const read = actions(statements(t, /pipelineapiread/i));
        expect(read.filter((a) => (/^(dynamodb|s3):/.test(a) && writes.test(a)) || a.startsWith('states:'))).toEqual([]);
        const del = actions(statements(t, /pipelineapidelete/i));
        expect(del.filter((a) => /^(s3|states|bedrock):/.test(a) || /PutItem|UpdateItem/.test(a))).toEqual([]);
        expect(actions(statements(t, /pipelineapiwrite/i))).not.toContain('dynamodb:DeleteItem');
        for (const re of [/pipelineapiread/i, /pipelineapiwrite/i, /pipelineapidelete/i]) {
          const d = statements(t, re).filter((x) => [x.Action].flat().some((a) => a.startsWith('dynamodb:')));
          expect(d.length).toBeGreaterThan(0);
          for (const st of d) expect(JSON.stringify((st as unknown as { Condition: unknown }).Condition)).toContain('dynamodb:LeadingKeys');
        }
      });
      it('aucune action avec joker, pas de s3:PutObject hors role API', () => {
        const all = (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
        expect(actions(all).filter((a) => a.includes('*'))).toEqual([]);
        expect(actions(statements(t, /^pipelinerole/i)).filter((a) => a === 's3:PutObject')).toEqual([]);
      });
      it("machine Standard: journal ERROR sans donnees d'execution, attentes de 20 et 30 minutes, verify puis quota", () => {
        t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          StateMachineName: `qcm-${env}-process`,
          StateMachineType: 'STANDARD',
          LoggingConfiguration: Match.objectLike({ Level: 'ERROR', IncludeExecutionData: false }),
        });
        const def = JSON.stringify(Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0]);
        expect(def).toContain('waitForTaskToken');
        expect(def).toContain('TimeoutSeconds\\":1800');
        expect(def).toContain('TimeoutSeconds\\":1200');
        expect(def).toContain(`qcm-${env}-verify-run`);
        expect(def.indexOf('Verification')).toBeLessThan(def.indexOf('ConsommationQuota'));
      });
      it('regle EventBridge: photos du prefixe scans/ seulement', () => {
        t.hasResourceProperties('AWS::Events::Rule', {
          EventPattern: Match.objectLike({ source: ['aws.s3'], 'detail-type': ['Object Created'], detail: Match.objectLike({ object: { key: [{ prefix: 'scans/' }] } }) }),
        });
      });
      it("API Gateway peut invoquer les fonctions de route, limitee a l'API", () => {
        const perms = Object.values(t.findResources('AWS::Lambda::Permission')).filter((p) => (p as { Properties: { Principal: string } }).Properties.Principal === 'apigateway.amazonaws.com');
        expect(perms).toHaveLength(Object.keys(API_FUNCTIONS).length);
      });
    });
  }
});

describe('Pipeline (L2a): relecture PR #14', () => {
  for (const env of ENVS) {
    describe(env, () => {
      const t = stack(env);
      const def = definition(t);
      const tasks = Object.entries(def.States).filter(([, v]) => v.Type === 'Task');
      const waits = ['AttenteEnvoi', 'AttenteConfirmation'];

      it('B1: le delai global depasse la somme de tous les delais de taches, et chaque tache a le sien', () => {
        const sum = tasks.reduce((n, [, v]) => n + (v.TimeoutSeconds ?? 0), 0);
        expect(tasks.filter(([, v]) => v.TimeoutSeconds === undefined).map(([k]) => k)).toEqual([]);
        expect(def.TimeoutSeconds).toBeGreaterThan(sum);
        expect(def.TimeoutSeconds).toBeGreaterThanOrEqual(2 * 3600);
        // les delais sont ceux du code: attentes de 20 et 30 minutes, traitements bornes
        expect(def.States.AttenteEnvoi.TimeoutSeconds).toBe(1200);
        expect(def.States.AttenteConfirmation.TimeoutSeconds).toBe(1800);
        expect(def.States.Transcription.TimeoutSeconds).toBe(TASK_TIMEOUT_S.transcribe);
        expect(def.States.Verification.TimeoutSeconds).toBe(TASK_TIMEOUT_S.verify);
      });
      it('B1: pire cas du chemin le plus long (envoi a la 19e minute, confirmation a la 29e) tient dans le delai global', () => {
        const longest = 1200 + TASK_TIMEOUT_S.scanCheck + TASK_TIMEOUT_S.transcribe + 1800 + TASK_TIMEOUT_S.extract + TASK_TIMEOUT_S.verify + TASK_TIMEOUT_S.consume + TASK_TIMEOUT_S.generate;
        expect(def.TimeoutSeconds).toBeGreaterThan(longest);
      });
      it('B2: pas de Retry automatique sur les appels de modele, les attentes ni verify-run', () => {
        for (const name of ['Transcription', 'Extraction', 'Generation', 'Verification', ...waits]) expect(def.States[name].Retry, name).toBeUndefined();
        for (const name of ['ControleFichier', 'ConsommationQuota']) expect(def.States[name].Retry, name).toBeDefined(); // etapes reprenables
      });
      it('toute tache de traitement a un Catch vers le filet', () => {
        const withCatch = JSON.stringify(def).match(/"Catch"/g)?.length ?? 0;
        expect(withCatch).toBeGreaterThanOrEqual(8);
      });

      it('M2 ressources: Bedrock limite aux profils du projet et aux modeles de base UE sous condition de profil', () => {
        const st = statements(t, /^pipelinerole/i).filter((x) => actions([x]).some((a) => a.startsWith('bedrock:')));
        expect(st).toHaveLength(2);
        const flat = JSON.stringify(st);
        expect(flat).not.toMatch(/"Resource":"\*"|"Resource":\["\*"\]/);
        expect(flat).not.toContain('"*"');
        expect(flat).toContain('bedrock:InferenceProfileArn');
        const base = st.find((x) => JSON.stringify(x.Resource).includes('foundation-model'))!;
        const regions = (base.Resource as unknown[]).map((r) => JSON.stringify(r));
        expect(regions.every((r) => /eu-[a-z]+-\d/.test(r))).toBe(true);
        expect(regions.some((r) => /us-|ap-|"\*"/.test(r))).toBe(false);
        expect(JSON.stringify(base.Resource)).not.toMatch(/haiku-5-5\*|haiku\*/); // identifiant exact, pas de prefixe
      });
      it('M2 ressources: DynamoDB limite a la table et a GSI1, S3 au prefixe scans/', () => {
        const all = (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
        for (const x of all) {
          const as = actions([x]);
          const res = JSON.stringify(x.Resource);
          if (as.some((a) => a.startsWith('dynamodb:'))) {
            expect(res).toContain(`table/qcm-${env}`);
            expect(res).not.toContain('"*"');
            expect((x.Resource as unknown[]).length).toBe(2);
            expect(res).toContain('index/GSI1');
          }
          if (as.some((a) => a.startsWith('s3:GetObject') || a === 's3:PutObject' || a === 's3:DeleteObject')) expect(res).toContain('/scans/*');
          if (as.includes('s3:ListBucket')) expect(JSON.stringify(x)).toContain('scans/*');
          if (as.some((a) => a.startsWith('bedrock:'))) expect(res).not.toContain('"*"');
        }
      });
    });
  }
});

describe('M2 sur toutes les stacks: tout role avec bedrock:Invoke* est un role de traitement', () => {
  for (const env of ENVS) {
    it(env, () => {
      const app = buildApp(env, 'test@example.invalid');
      for (const child of app.node.children) {
        if (!(child as { templateOptions?: unknown }).templateOptions) continue;
        const t = Template.fromStack(child as never);
        const names = new Map(Object.entries(t.findResources('AWS::IAM::Role')).map(([id, r]) => [id, (r as { Properties: { RoleName?: string } }).Properties.RoleName]));
        const check = (roleIds: string[], stmts: Stmt[]) => {
          if (!actions(stmts).some((a) => a.startsWith('bedrock:Invoke') || a === 'bedrock:*')) return;
          for (const id of roleIds) expect(processingRoleNames(env), `${child.node.id}: ${id}`).toContain(names.get(id) ?? '');
        };
        for (const p of Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]) check(p.Properties.Roles.map((r) => r.Ref), p.Properties.PolicyDocument.Statement);
        for (const [id, r] of Object.entries(t.findResources('AWS::IAM::Role'))) {
          const pols = (r as { Properties: { Policies?: { PolicyDocument: { Statement: Stmt[] } }[] } }).Properties.Policies ?? [];
          for (const p of pols) check([id], p.PolicyDocument.Statement);
        }
      }
    });
  }
});
