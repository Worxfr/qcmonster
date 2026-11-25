import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { API_FUNCTIONS, STEP_FUNCTIONS, TASK_TIMEOUT_S, UPLOAD_TIMEOUT_S, machineTimeoutS, MACHINE_TIMEOUT } = await import('../lib/pipeline-stack.js');
import { ENVS, METRIC_NAMESPACE, processingRoleNames, stackName } from '../../shared/names.js';
import { CONFIRM_TIMEOUT_S, MACHINE_TIMEOUT_MIN_S, MAX_SECTIONS, machineTimeoutNeededS } from '../../shared/scans.js';
import { REQUIRED_TAGS } from './tags.js';

const stack = (env: (typeof ENVS)[number]) => Template.fromStack(buildApp(env, 'test@example.invalid').node.findChild(stackName(env, 'pipeline')) as never);

type Stmt = { Effect: string; Action: string | string[]; Resource: unknown };
type Pol = { Properties: { Roles: { Ref: string }[]; PolicyDocument: { Statement: Stmt[] } } };
const statements = (t: Template, roleLogical: RegExp): Stmt[] =>
  (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => (p.Properties.Roles.some((r) => roleLogical.test(r.Ref)) ? p.Properties.PolicyDocument.Statement : []));
/** Definition de la machine en objet (les references CloudFormation sont remplacees par `REF`). */
type SfnState = { Type: string; TimeoutSeconds?: number; Retry?: unknown[]; Resource?: string; MaxConcurrency?: number; Catch?: { Next: string }[]; ItemProcessor?: { States: Record<string, SfnState> } };
const definition = (t: Template): { TimeoutSeconds: number; States: Record<string, SfnState> } => {
  const sm = Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0] as { Properties: { DefinitionString: { 'Fn::Join': [string, unknown[]] } } };
  return JSON.parse(sm.Properties.DefinitionString['Fn::Join'][1].map((x) => (typeof x === 'string' ? x : 'REF')).join(''));
};
/** Tous les etats, ceux des `Map` compris (le nom d'un etat est unique dans la machine). */
const allStates = (states: Record<string, SfnState>): Record<string, SfnState> =>
  Object.assign({}, ...Object.entries(states).map(([k, v]) => ({ [k]: v, ...(v.ItemProcessor ? allStates(v.ItemProcessor.States) : {}) })));
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
        expect(roles.sort()).toEqual(['api-read', 'api-write', 'api-delete', 'api-patch', 'api-folders', 'api-cours-read', 'api-cours'].map((r) => `qcm-${env}-pipeline-${r}-role`).concat([`qcm-${env}-pipeline-role`, `qcm-${env}-pipeline-trigger-role`]).sort());
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
      it('B1: scans-create peut lire le compteur COST#<env> (GetItem seul), et seul le role ecriture le peut', () => {
        const cost = (re: RegExp) => statements(t, re).filter((x) => JSON.stringify((x as unknown as { Condition?: unknown }).Condition ?? '').includes(`COST#${env}`));
        const w = cost(/pipelineapiwrite/i);
        expect(w.length).toBe(1);
        expect(actions(w)).toEqual(['dynamodb:GetItem']);
        expect(cost(/pipelineapiread/i)).toEqual([]);
        expect(cost(/pipelineapidelete/i)).toEqual([]);
      });
      it('aucune action avec joker, pas de s3:PutObject hors role API', () => {
        const all = (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => p.Properties.PolicyDocument.Statement);
        expect(actions(all).filter((a) => a.includes('*'))).toEqual([]);
        expect(actions(statements(t, /^pipelinerole/i)).filter((a) => a === 's3:PutObject')).toEqual([]);
      });
      it("machine Standard: journal ERROR sans donnees d'execution, attentes de 20 minutes et 12 h, verify puis quota", () => {
        t.hasResourceProperties('AWS::StepFunctions::StateMachine', {
          StateMachineName: `qcm-${env}-process`,
          StateMachineType: 'STANDARD',
          LoggingConfiguration: Match.objectLike({ Level: 'ERROR', IncludeExecutionData: false }),
        });
        const def = JSON.stringify(Object.values(t.findResources('AWS::StepFunctions::StateMachine'))[0]);
        expect(def).toContain('waitForTaskToken');
        expect(def).toContain(`TimeoutSeconds\\":${CONFIRM_TIMEOUT_S}`);
        expect(def).toContain('TimeoutSeconds\\":1200');
        expect(def).toContain(`qcm-${env}-verify-run`);
        expect(def.indexOf('Verification\\":')).toBeLessThan(def.indexOf('ConsommationQuota\\":'));
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
      const states = allStates(def.States);
      const tasks = Object.entries(states).filter(([, v]) => v.Type === 'Task');
      const waits = ['AttenteEnvoi', 'AttenteConfirmation'];

      it('B1: le delai global depasse la somme de tous les delais de taches, et chaque tache a le sien', () => {
        const sum = tasks.reduce((n, [, v]) => n + (v.TimeoutSeconds ?? 0), 0);
        expect(tasks.filter(([, v]) => v.TimeoutSeconds === undefined).map(([k]) => k)).toEqual([]);
        expect(def.TimeoutSeconds).toBeGreaterThan(sum);
        // les delais sont ceux du code: attente d'envoi 20 min, confirmation 12 h (CONFIRM_TIMEOUT_S, jamais plus de 20 h), traitements bornes
        expect(states.AttenteEnvoi.TimeoutSeconds).toBe(1200);
        expect(states.AttenteConfirmation.TimeoutSeconds).toBe(43200);
        expect(CONFIRM_TIMEOUT_S).toBeLessThanOrEqual(20 * 3600);
        expect(states.Transcription.TimeoutSeconds).toBe(TASK_TIMEOUT_S.transcribe);
        expect(states.Verification.TimeoutSeconds).toBe(TASK_TIMEOUT_S.verify);
      });
      it("FEAT-A: le delai global couvre envoi + lecture + confirmation 12 h + MAX_SECTIONS sections, et au moins 16 h", () => {
        const T = TASK_TIMEOUT_S;
        const needed = machineTimeoutNeededS({
          uploadS: states.AttenteEnvoi.TimeoutSeconds!,
          transcribeS: T.scanCheck + T.transcribe + T.sectionsPlan + T.consume + T.finalize,
          confirmS: states.AttenteConfirmation.TimeoutSeconds!,
          sections: MAX_SECTIONS,
          perSectionS: T.extract + T.verify + T.sectionCost + T.generate,
        });
        expect(def.TimeoutSeconds).toBeGreaterThanOrEqual(needed);
        expect(def.TimeoutSeconds).toBeGreaterThanOrEqual(MACHINE_TIMEOUT_MIN_S);
        expect(def.TimeoutSeconds).toBe(MACHINE_TIMEOUT.toSeconds());
      });
      it('FEAT-A: le delai global suit CONFIRM_TIMEOUT_S (un delai trop court est detecte)', () => {
        expect(machineTimeoutS(20 * 3600)).toBeGreaterThan(machineTimeoutS(CONFIRM_TIMEOUT_S));
        for (const confirmS of [CONFIRM_TIMEOUT_S, 20 * 3600]) {
          const T = TASK_TIMEOUT_S;
          const needed = machineTimeoutNeededS({ uploadS: UPLOAD_TIMEOUT_S, transcribeS: T.scanCheck + T.transcribe + T.sectionsPlan + T.consume + T.finalize, confirmS, sections: MAX_SECTIONS, perSectionS: T.extract + T.verify + T.sectionCost + T.generate });
          expect(machineTimeoutS(confirmS)).toBeGreaterThanOrEqual(needed);
        }
        // l'ancien delai de 2 h ne passe pas: c'est la condition qui ferait echouer le test ci-dessus
        expect(2 * 3600).toBeLessThan(machineTimeoutNeededS({ uploadS: UPLOAD_TIMEOUT_S, transcribeS: 0, confirmS: CONFIRM_TIMEOUT_S, sections: 1, perSectionS: 0 }));
      });
      it('FEAT-A: deux Map en sequence (maxConcurrency 1), Catch vers MarquerEchec, un quota, une finalisation', () => {
        const maps = Object.entries(def.States).filter(([, v]) => v.Type === 'Map');
        expect(maps.map(([k]) => k)).toEqual(['Sections-extraction', 'Sections-generation']);
        for (const [k, m] of maps) {
          expect(m.MaxConcurrency, k).toBe(1);
          expect(m.Catch?.map((c) => c.Next), k).toEqual(['MarquerEchec']);
        }
        expect(Object.keys(states['Sections-extraction'].ItemProcessor!.States)).toEqual(expect.arrayContaining(['Extraction', 'Verification', 'CoutSection']));
        expect(Object.keys(states['Sections-generation'].ItemProcessor!.States)).toEqual(['Generation']);
        const json = JSON.stringify(def.States);
        for (const n of ['PlanSections', 'ConsommationQuota', 'Finalisation']) expect(json.split(`"${n}":`).length - 1, n).toBe(1);
        // ordre: plan, extraction, quota (une fois, entre les deux Map), generation, finalisation
        const idx = (n: string) => json.indexOf(`"${n}":`);
        expect([idx('PlanSections'), idx('Sections-extraction'), idx('ConsommationQuota'), idx('Sections-generation'), idx('Finalisation')]).toEqual([...[idx('PlanSections'), idx('Sections-extraction'), idx('ConsommationQuota'), idx('Sections-generation'), idx('Finalisation')]].sort((x, y) => x - y));
        expect(states.ConsommationQuota.Type).toBe('Task');
      });
      it('B2: pas de Retry automatique sur les appels de modele, les attentes ni verify-run', () => {
        for (const name of ['Transcription', 'Extraction', 'Generation', 'Verification', ...waits]) expect(states[name].Retry, name).toBeUndefined();
        for (const name of ['ControleFichier', 'PlanSections', 'CoutSection', 'ConsommationQuota', 'Finalisation']) expect(states[name].Retry, name).toBeDefined(); // etapes reprenables
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
            // Exception: le compteur de cout (COST#, GetItem) n'a pas besoin de l'index.
            const costRead = JSON.stringify((x as unknown as { Condition?: unknown }).Condition ?? '').includes('COST#');
            expect(Array.isArray(x.Resource) ? x.Resource.length : 1).toBe(costRead ? 1 : 2);
            if (!costRead) expect(res).toContain('index/GSI1');
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

describe('FEAT-A (lot I): fonctions, roles et tags', () => {
  const NEW_ROUTES = ['scans-list', 'docs-patch', 'folders-api', 'cours-api', 'cours-delete'];
  for (const env of ENVS) {
    describe(env, () => {
      const t = stack(env);
      const fnRole = (name: string) => {
        const f = Object.values(t.findResources('AWS::Lambda::Function')).find((x) => (x as { Properties: { FunctionName: string } }).Properties.FunctionName === `qcm-${env}-${name}`) as { Properties: { Role: { 'Fn::GetAtt': [string] }; Timeout: number } };
        return { role: f.Properties.Role['Fn::GetAtt'][0], timeout: f.Properties.Timeout };
      };
      const own = (re: RegExp) => actions(statements(t, re)).filter((a) => !a.startsWith('logs:')); // journaux de la fonction: hors sujet
      const ddbStatements = (re: RegExp) => statements(t, re).filter((x) => actions([x]).some((a) => a.startsWith('dynamodb:')));
      const leadingOf = (x: Stmt) => (x as unknown as { Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': string[] } } }).Condition['ForAllValues:StringLike']['dynamodb:LeadingKeys'];

      it('les 8 routes FEAT-A ont une fonction (une par handler) et passent de 501 au vrai proprietaire', () => {
        const names = Object.values(t.findResources('AWS::Lambda::Function')).map((f) => (f as { Properties: { FunctionName: string } }).Properties.FunctionName);
        for (const h of NEW_ROUTES) expect(names, h).toContain(`qcm-${env}-${h}`);
        expect(Object.keys(API_FUNCTIONS)).toEqual(expect.arrayContaining(NEW_ROUTES));
      });
      it('docs-patch: GetItem et UpdateItem seulement, STUDENT# seulement, ni S3 ni Query ni PutItem', () => {
        expect(fnRole('docs-patch').role).toMatch(/pipelineapipatch/i);
        const st = ddbStatements(/pipelineapipatch/i);
        expect([...new Set(actions(st))].sort()).toEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
        expect(leadingOf(st[0])).toEqual(['STUDENT#*']);
        expect(own(/pipelineapipatch/i).filter((a) => !a.startsWith('dynamodb:'))).toEqual([]);
      });
      it('folders-api: role dedie, pas de S3 / Bedrock / Step Functions, 30 s, FAMILY# et STUDENT# seulement', () => {
        expect(fnRole('folders-api').role).toMatch(/pipelineapifolders/i);
        expect(fnRole('folders-api').timeout).toBe(30);
        const as = own(/pipelineapifolders/i);
        expect(as.filter((a) => /^(s3|bedrock|states|cloudwatch):/.test(a))).toEqual([]);
        expect([...new Set(as)].sort()).toEqual(['dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
        expect(leadingOf(ddbStatements(/pipelineapifolders/i)[0])).toEqual(['FAMILY#*', 'STUDENT#*']);
      });
      it('cours-api: GET avec un role en lecture seule, DELETE avec le seul role qui supprime; parent sans droit (pas de FAMILY#)', () => {
        expect(fnRole('cours-api').role).toMatch(/pipelineapicoursread/i);
        expect(fnRole('cours-delete').role).toMatch(/^pipelineapicoursrole/i);
        expect(fnRole('cours-delete').role).not.toMatch(/read/i);
        expect(fnRole('cours-delete').timeout).toBe(30);
        const read = ddbStatements(/pipelineapicoursread/i);
        expect([...new Set(actions(read))].sort()).toEqual(['dynamodb:GetItem', 'dynamodb:Query']);
        expect(leadingOf(read[0])).toEqual(['STUDENT#*']);
        const del = ddbStatements(/^pipelineapicoursrole/i);
        expect([...new Set(actions(del))].sort()).toEqual(['dynamodb:BatchWriteItem', 'dynamodb:DeleteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem']);
        expect(leadingOf(del[0])).toEqual(['STUDENT#*', 'DOC#*', 'JOB#*']);
        expect(own(/^pipelineapicoursrole/i).filter((a) => !a.startsWith('dynamodb:'))).toEqual([]);
        for (const re of [/pipelineapicoursread/i, /^pipelineapicoursrole/i, /pipelineapipatch/i]) expect(JSON.stringify(statements(t, re)), String(re)).not.toContain('FAMILY#');
      });
      it("jobs-confirm (writeRole) lit FOLDER# et ecrit le cours sans pouvoir supprimer; l'etape fail (pipeline-role) supprime", () => {
        expect(fnRole('jobs-confirm').role).toMatch(/pipelineapiwrite/i);
        const w = actions(ddbStatements(/pipelineapiwrite/i));
        expect(w).toEqual(expect.arrayContaining(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']));
        expect(w.filter((a) => /Delete|BatchWrite/.test(a))).toEqual([]);
        const w1 = ddbStatements(/pipelineapiwrite/i).find((x) => actions([x]).includes('dynamodb:PutItem'))!;
        expect(leadingOf(w1)).toEqual(expect.arrayContaining(['STUDENT#*']));
        expect(fnRole('pipeline-fail').role).toMatch(/^pipelinerole/i);
        expect(actions(statements(t, /^pipelinerole/i))).toEqual(expect.arrayContaining(['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem', 'dynamodb:Query']));
      });
      it('liste des fonctions Bedrock inchangee: aucun role FEAT-A ne peut appeler Bedrock', () => {
        expect(processingRoleNames(env)).toContain(`qcm-${env}-pipeline-role`);
        for (const re of [/pipelineapipatch/i, /pipelineapifolders/i, /pipelineapicours/i]) expect(actions(statements(t, re)).filter((a) => a.startsWith('bedrock:'))).toEqual([]);
        expect(processingRoleNames(env).filter((r) => /pipeline-api/.test(r))).toEqual([]);
      });
      it('alarme de 10 EUR: seul pipeline-role a cloudwatch:PutMetricData, limite a l\'espace de noms QCMonster', () => {
        const withCw = (Object.values(t.findResources('AWS::IAM::Policy')) as Pol[]).flatMap((p) => p.Properties.PolicyDocument.Statement.filter((x) => actions([x]).some((a) => a.startsWith('cloudwatch:'))).map((x) => ({ roles: p.Properties.Roles.map((r) => r.Ref), x })));
        expect(withCw).toHaveLength(1);
        expect(withCw[0].roles.every((r) => /^pipelinerole/i.test(r))).toBe(true);
        expect(actions([withCw[0].x])).toEqual(['cloudwatch:PutMetricData']);
        expect(JSON.stringify((withCw[0].x as unknown as { Condition: unknown }).Condition)).toBe(JSON.stringify({ StringEquals: { 'cloudwatch:namespace': METRIC_NAMESPACE } }));
      });
      it('tags: roles, fonctions et groupes de journaux portent project=qcmonster et les 3 autres tags', () => {
        const tagged = ['AWS::IAM::Role', 'AWS::Lambda::Function', 'AWS::Logs::LogGroup', 'AWS::StepFunctions::StateMachine', 'AWS::Events::Rule'];
        let n = 0;
        for (const type of tagged) {
          for (const [id, r] of Object.entries(t.findResources(type))) {
            const keys = ((r as { Properties: { Tags?: { Key: string; Value: unknown }[] } }).Properties.Tags ?? []).map((x) => x.Key);
            for (const k of REQUIRED_TAGS) expect(keys, `${id} (${type})`).toContain(k);
            const p = ((r as { Properties: { Tags?: { Key: string; Value: unknown }[] } }).Properties.Tags ?? []).find((x) => x.Key === 'project');
            expect(p?.Value, id).toBe('qcmonster');
            n++;
          }
        }
        expect(n).toBeGreaterThan(30);
      });
    });
  }
});
