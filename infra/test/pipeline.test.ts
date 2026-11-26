import { describe, expect, it } from 'vitest';
import { Match, Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
const { API_FUNCTIONS, EXPORT_FUNCTIONS, STEP_FUNCTIONS, TASK_TIMEOUT_S, UPLOAD_TIMEOUT_S, machineTimeoutS, MACHINE_TIMEOUT } = await import('../lib/pipeline-stack.js');
import { readFileSync } from 'node:fs';
import { run, type Def, type Handlers } from './sfn-sim.js';
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
        const expected = [...Object.keys(API_FUNCTIONS), ...Object.keys(EXPORT_FUNCTIONS), ...Object.values(STEP_FUNCTIONS).map((s) => s[0])].map((h) => `qcm-${env}-${h}`);
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
        expect(roles.sort()).toEqual(['api-read', 'api-write', 'api-delete', 'api-patch', 'api-folders', 'api-cours-read', 'api-cours', 'api-scans-delete', 'api-confirm', 'api-list', 'api-export', 'export'].map((r) => `qcm-${env}-pipeline-${r}-role`).concat([`qcm-${env}-pipeline-role`, `qcm-${env}-pipeline-trigger-role`]).sort());
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
        // E1: la seule action hors DynamoDB est DeleteObject sur copies/* (images des copies de la fiche, cles exactes); ni lecture, ni liste, ni ecriture S3
        expect(del.filter((a) => /^(s3|states|bedrock):/.test(a) || /PutItem/.test(a))).toEqual(['s3:DeleteObject']);
        expect(JSON.stringify(statements(t, /pipelineapidelete/i).filter((x) => [x.Action].flat().some((a) => a.startsWith('s3:'))).map((x) => x.Resource))).toMatch(/^\[.*\/copies\/\*.*\]$/);
        // Q1: seule ecriture en plus, UpdateItem sur STUDENT# (reecriture d'un passage multi-fiches), jamais sans condition sur la cle de partition
        const upd = statements(t, /pipelineapidelete/i).filter((x) => [x.Action].flat().includes('dynamodb:UpdateItem'));
        expect(upd).toHaveLength(1);
        expect(JSON.stringify((upd[0] as unknown as { Condition: unknown }).Condition)).toContain('STUDENT#*');
        expect(actions(statements(t, /pipelineapiwrite/i))).not.toContain('dynamodb:DeleteItem');
        expect(actions(statements(t, /pipelineapiwrite/i))).not.toContain('dynamodb:BatchWriteItem');
        for (const re of [/pipelineapiread/i, /pipelineapiwrite/i, /pipelineapidelete/i]) {
          const d = statements(t, re).filter((x) => [x.Action].flat().some((a) => a.startsWith('dynamodb:')));
          expect(d.length).toBeGreaterThan(0);
          for (const st of d) expect(JSON.stringify((st as unknown as { Condition: unknown }).Condition)).toContain('dynamodb:LeadingKeys');
        }
      });
      it('Q1 B1: tout role qui appelle deleteDocTree peut reecrire un passage multi-fiches (UpdateItem sur STUDENT#)', () => {
        // docs-delete (docs.ts), cours-delete (cours.ts), scans-delete et la restauration d'un ajout (append.ts), purge d'un scan (steps.ts, role de traitement)
        for (const re of [/^pipelineapidelete/i, /^pipelineapicoursrole/i, /^pipelineapiscansdelete/i, /^pipelinerole/i]) {
          const upd = statements(t, re).filter((x) => [x.Action].flat().includes('dynamodb:UpdateItem'));
          expect(upd.length, String(re)).toBeGreaterThan(0);
          const where = JSON.stringify(upd.map((x) => (x as unknown as { Condition?: unknown; Resource: unknown }).Condition ?? x.Resource));
          expect(where, String(re)).toMatch(/STUDENT#\*|"Fn::GetAtt"|Ref/);
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
        // R1-B: le seul PutObject de pipeline-role est le recadrage temporaire scans/*/fig/*
        const puts = statements(t, /^pipelinerole/i).filter((x) => actions([x]).includes('s3:PutObject'));
        expect(puts).toHaveLength(1);
        expect(JSON.stringify(puts[0].Resource)).toContain('/scans/*/fig/*');
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
        expect(perms).toHaveLength(Object.keys(API_FUNCTIONS).length + 1); // + me-export-archive (R1-B); la construction n'est jamais appelee par l'API
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
        expect(st).toHaveLength(4); // Haiku et Sonnet (R1-B): profil d'application + profil systeme, puis modele de base
        const flat = JSON.stringify(st);
        expect(flat).not.toMatch(/"Resource":"\*"|"Resource":\["\*"\]/);
        expect(flat).not.toContain('"*"');
        expect(flat).toContain('bedrock:InferenceProfileArn');
        for (const model of ['haiku', 'sonnet']) {
        const base = st.find((x) => JSON.stringify(x.Resource).includes('foundation-model') && JSON.stringify(x.Resource).includes(`${model}-5-5`))!;
        const regions = (base.Resource as unknown[]).map((r) => JSON.stringify(r));
        expect(regions.every((r) => /eu-[a-z]+-\d/.test(r))).toBe(true);
        expect(regions.some((r) => /us-|ap-|"\*"/.test(r))).toBe(false);
        expect(JSON.stringify(base.Resource)).not.toMatch(/-5-5\*|haiku\*|sonnet\*/); // identifiant exact, pas de prefixe
        }
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
          // R1-B: trois prefixes seulement, jamais un bucket entier: scans/ et exports/ (bucket des photos), figures/ (bucket des figures)
          if (as.some((a) => a.startsWith('s3:') && a !== 's3:ListBucket')) expect(res).toMatch(/\/(scans|exports|figures|copies)\/\*/);
          if (as.includes('s3:ListBucket')) expect(JSON.stringify(x)).toMatch(/(scans|figures)\/\*/); // E1: jamais de ListBucket sur copies/ ici
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

      const flat = (re: RegExp) => ddbStatements(re).map((x) => ({ actions: [...new Set(actions([x]))].sort(), keys: leadingOf(x) }));
      it('les 9 routes FEAT-A ont une fonction (une par handler) et passent de 501 au vrai proprietaire', () => {
        const names = Object.values(t.findResources('AWS::Lambda::Function')).map((f) => (f as { Properties: { FunctionName: string } }).Properties.FunctionName);
        for (const h of NEW_ROUTES) expect(names, h).toContain(`qcm-${env}-${h}`);
        expect(Object.keys(API_FUNCTIONS)).toEqual(expect.arrayContaining(NEW_ROUTES));
      });
      it('scans-list: DynamoDB en lecture seule sur FAMILY# et STUDENT#, sans S3', () => {
        expect(fnRole('scans-list').role).toMatch(/pipelineapilist/i);
        expect(flat(/pipelineapilist/i)).toEqual([{ actions: ['dynamodb:GetItem', 'dynamodb:Query'], keys: ['FAMILY#*', 'STUDENT#*'] }]);
        expect(own(/pipelineapilist/i).filter((a) => !a.startsWith('dynamodb:'))).toEqual([]);
      });
      it('docs-patch: Query de FAMILY# (callerOf) et un seul UpdateItem sur STUDENT#; ni GetItem, ni PutItem, ni S3', () => {
        expect(fnRole('docs-patch').role).toMatch(/pipelineapipatch/i);
        expect(flat(/pipelineapipatch/i)).toEqual([
          { actions: ['dynamodb:Query'], keys: ['FAMILY#*'] },
          { actions: ['dynamodb:UpdateItem'], keys: ['STUDENT#*'] },
        ]);
        expect(own(/pipelineapipatch/i).filter((a) => !a.startsWith('dynamodb:'))).toEqual([]);
      });
      it('folders-api: BatchWriteItem (ports.remove) et non DeleteItem; pas de S3 / Bedrock / Step Functions; 30 s minimum', () => {
        expect(fnRole('folders-api').role).toMatch(/pipelineapifolders/i);
        expect(fnRole('folders-api').timeout).toBeGreaterThanOrEqual(30);
        expect(own(/pipelineapifolders/i).filter((a) => !a.startsWith('dynamodb:'))).toEqual([]);
        expect(flat(/pipelineapifolders/i)).toEqual([{ actions: ['dynamodb:BatchWriteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], keys: ['FAMILY#*', 'STUDENT#*'] }]);
      });
      it('cours: GET sur une fonction en lecture seule, DELETE sur cours-delete (seul role qui supprime, signalements FAMILY# compris), 30 s minimum', () => {
        expect(fnRole('cours-api').role).toMatch(/pipelineapicoursread/i);
        expect(fnRole('cours-delete').role).toMatch(/^pipelineapicoursrole/i);
        expect(fnRole('cours-api').timeout).toBeGreaterThanOrEqual(30);
        expect(fnRole('cours-delete').timeout).toBeGreaterThanOrEqual(30);
        expect(flat(/pipelineapicoursread/i)).toEqual([
          { actions: ['dynamodb:Query'], keys: ['FAMILY#*'] },
          { actions: ['dynamodb:GetItem', 'dynamodb:Query'], keys: ['STUDENT#*'] },
          { actions: ['dynamodb:GetItem', 'dynamodb:Query'], keys: ['DOC#*'] }, // R1-B: marques (CLAIM#, VERDICT#) sous DOC#<id>
        ]);
        expect(flat(/^pipelineapicoursrole/i)).toEqual([
          { actions: ['dynamodb:BatchWriteItem', 'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], keys: ['STUDENT#*', 'DOC#*', 'JOB#*'] },
          { actions: ['dynamodb:BatchWriteItem', 'dynamodb:Query'], keys: ['FAMILY#*'] },
        ]);
        // R1-B: hors DynamoDB, la lecture signe des figures (GetObject) et la suppression liste et efface le prefixe figures/; jamais d'ecriture
        expect(own(/pipelineapicoursread/i).filter((a) => !a.startsWith('dynamodb:'))).toEqual(['s3:GetObject']);
        expect(own(/^pipelineapicoursrole/i).filter((a) => !a.startsWith('dynamodb:')).sort()).toEqual(['s3:DeleteObject', 's3:DeleteObject', 's3:ListBucket']); // figures/ (suppression et liste) + copies/ (E1, suppression seule)
        for (const re of [/pipelineapicoursread/i, /^pipelineapicoursrole/i]) expect(own(re).filter((a) => a === 'dynamodb:PutItem')).toEqual([]);
      });
      it('scans-delete: role etroit (ni confirmRole, ni PutObject, ni StartExecution, ni SendTaskSuccess, ni COST#)', () => {
        expect(fnRole('scans-delete').role).toMatch(/pipelineapiscansdelete/i);
        expect(flat(/pipelineapiscansdelete/i)).toEqual([
          { actions: ['dynamodb:BatchWriteItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'], keys: ['FAMILY#*', 'STUDENT#*', 'JOB#*', 'DOC#*'] },
        ]);
        expect(own(/pipelineapiscansdelete/i).filter((a) => !a.startsWith('dynamodb:')).sort()).toEqual(['s3:DeleteObject', 's3:DeleteObject', 's3:DeleteObject', 's3:ListBucket', 's3:ListBucket', 'states:SendTaskFailure']); // scans/ + figures/ (F10) + copies/ (E1, suppression seule)
      });
      it("jobs-confirm: role propre = droits d'ecriture + suppression du cours durable (STUDENT#, JOB#); le role d'ecriture ne supprime rien; l'etape fail supprime", () => {
        expect(fnRole('jobs-confirm').role).toMatch(/pipelineapiconfirm/i);
        for (const h of ['scans-create', 'jobs-cancel', 'docs-report']) expect(fnRole(h).role, h).toMatch(/pipelineapiwrite/i);
        const w = actions(ddbStatements(/pipelineapiwrite/i));
        expect(w.filter((a) => /Delete|BatchWrite/.test(a))).toEqual([]);
        const c = flat(/pipelineapiconfirm/i);
        expect(c).toContainEqual({ actions: ['dynamodb:BatchWriteItem'], keys: ['STUDENT#*', 'JOB#*'] });
        const c1 = c.find((x) => x.actions.includes('dynamodb:PutItem'))!;
        expect(c1.keys).toEqual(expect.arrayContaining(['STUDENT#*']));
        expect(c.some((x) => x.actions.includes('dynamodb:DeleteItem'))).toBe(false);
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

// Une fonction `qcm-<env>-<handler>` ne peut etre creee qu'une fois dans tout l'assemblage: sinon CloudFormation echoue (nom deja pris).
describe('FEAT-A (lot I): assemblage', () => {
  for (const env of ENVS) {
    const app = buildApp(env, 'test@example.invalid');
    const stacks = app.node.children.filter((c) => 'templateOptions' in c) as unknown as Parameters<typeof Template.fromStack>[0][];
    const templates = stacks.map((st) => ({ name: st.stackName, t: Template.fromStack(st) }));

    it(`${env}: aucun nom de fonction n'est declare deux fois, toutes stacks`, () => {
      const seen = new Map<string, string[]>();
      for (const { name, t } of templates) {
        for (const f of Object.values(t.findResources('AWS::Lambda::Function')) as { Properties: { FunctionName?: string } }[]) {
          if (f.Properties.FunctionName) seen.set(f.Properties.FunctionName, [...(seen.get(f.Properties.FunctionName) ?? []), name]);
        }
      }
      expect([...seen].filter(([, owners]) => owners.length > 1)).toEqual([]);
      expect(seen.size).toBeGreaterThan(30);
    });

    it(`${env}: chaque route de l'API pointe vers la bonne fonction (DELETE /cours vers cours-delete, GET vers cours-api)`, () => {
      const api = templates.find((x) => x.name === stackName(env, 'api'))!.t;
      const res = api.toJSON().Resources as Record<string, { Type: string; Properties: Record<string, unknown> }>;
      const target = (route: string): string => {
        const r = Object.values(res).find((x) => x.Type === 'AWS::ApiGatewayV2::Route' && x.Properties.RouteKey === route)!;
        const integ = /integrations\/","?\{?"?Ref"?:"?([A-Za-z0-9]+)/.exec(JSON.stringify(r.Properties.Target))?.[1] ?? '';
        const uri = JSON.stringify(res[integ].Properties.IntegrationUri);
        return new RegExp(`function:(qcm-${env}-[a-z-]+)`).exec(uri)![1];
      };
      const expected: Record<string, string> = {
        'POST /scans': 'scans-create', 'GET /scans': 'scans-list', 'PATCH /docs/{docId}': 'docs-patch', 'GET /folders': 'folders-api', 'POST /folders': 'folders-api',
        'PATCH /folders/{folderId}': 'folders-api', 'DELETE /folders/{folderId}': 'folders-api', 'POST /folders/{folderId}/scans': 'folders-api',
        'DELETE /folders/{folderId}/scans/{docId}': 'folders-api', 'GET /cours/{coursId}': 'cours-api', 'DELETE /cours/{coursId}': 'cours-delete',
      };
      for (const [route, h] of Object.entries(expected)) expect(target(route), route).toBe(`qcm-${env}-${h}`);
    });
  }
});

// Les noms d'export attendus de entry.ts. Tant qu'aucun export de B2 (coursHandler, ...) n'est present dans entry.ts de cette branche, le test est saute;
// des qu'un export de B2 est present, il exige TOUS les noms, ceux de B1 compris (sectionsPlanHandler, sectionCostHandler, finalizeHandler).
describe('FEAT-A (lot I): exports de entry.ts', () => {
  const entry = readFileSync(new URL('../../api/src/pipeline/entry.ts', import.meta.url), 'utf8');
  const exported = new Set([...entry.matchAll(/export const (\w+)\s*=/g)].map((m) => m[1]));
  const wanted = [...new Set([...Object.values(API_FUNCTIONS), ...Object.values(EXPORT_FUNCTIONS), ...Object.values(STEP_FUNCTIONS).map((x) => x[1])])];
  const b2Merged = ['coursHandler', 'scansListHandler', 'foldersHandler', 'docsPatchHandler'].some((n) => exported.has(n));
  it('la liste attendue contient les 12 exports de FEAT-A et du pipeline', () => {
    expect(wanted).toEqual(expect.arrayContaining(['scansListHandler', 'docsPatchHandler', 'foldersHandler', 'coursHandler', 'sectionsPlanHandler', 'sectionCostHandler', 'finalizeHandler']));
    expect(wanted.length).toBe(Object.keys(API_FUNCTIONS).length + Object.keys(EXPORT_FUNCTIONS).length + Object.keys(STEP_FUNCTIONS).length - 1); // coursHandler sert deux fonctions
  });
  it.skipIf(!b2Merged)('chaque fonction de API_FUNCTIONS et STEP_FUNCTIONS a son export dans entry.ts', () => {
    expect(wanted.filter((n) => !exported.has(n))).toEqual([]);
  });
});

// Machine d'etats rejouee avec des handlers simules (B1 simule): ordre des appels, une seule consommation de quota, section vide, rejet, defaut.
describe('FEAT-A (lot I): machine rejouee avec des handlers simules', () => {
  const t = stack('dev');
  const def = definition(t) as unknown as Def;
  type In = Record<string, unknown>;
  const base = (over: Handlers = {}): Handlers => ({
    AttenteEnvoi: () => undefined, ControleFichier: () => ({ ok: true }), Transcription: () => ({ ok: true }), AttenteConfirmation: () => undefined,
    PlanSections: () => ({ indices: [0, 1] }),
    Extraction: (i: In) => ({ ok: true, docId: `d${i.index}`, claims: 5, budgetRestantCentimes: 40 }),
    RognageFigures: () => undefined, Verification: () => ({ coutCentimes: 3 }), CoutSection: () => ({ addedMicros: 1 }),
    ConsommationQuota: () => ({ ok: true }), Generation: () => undefined, Finalisation: () => ({ docIds: ['d0', 'd1'] }), MarquerEchec: () => undefined,
    ...over,
  });
  const go = (h: Handlers) => run(def, { jobId: 'j1', sid: 's1' }, h);
  const names = (r: { calls: { state: string }[] }) => r.calls.map((c) => c.state);

  it('2 sections avec fiche: extraction, verification, cout par section, quota une fois, generation par section, finalisation', async () => {
    const r = await go(base());
    expect(r.end).toBe('Fiche-publiee');
    expect(names(r)).toEqual(['AttenteEnvoi', 'ControleFichier', 'Transcription', 'RognageFigures', 'AttenteConfirmation', 'PlanSections', 'Extraction', 'Verification', 'CoutSection', 'Extraction', 'Verification', 'CoutSection', 'ConsommationQuota', 'Generation', 'Generation', 'Finalisation']);
    expect(r.calls.filter((c) => c.state === 'Extraction').map((c) => c.input.index)).toEqual([0, 1]);
    expect(r.calls.filter((c) => c.state === 'Generation').map((c) => c.input.index)).toEqual([0, 1]);
    expect(r.calls.find((c) => c.state === 'Verification')!.input).toEqual({ jobId: 'j1', docId: 'd0', budgetRestantCentimes: 40 });
  });
  it('une section sans affirmation (claims 0) passe a la suivante sans verify-run ni cout', async () => {
    const r = await go(base({ Extraction: (i: In) => ({ ok: true, docId: `d${i.index}`, claims: i.index === 0 ? 0 : 4, budgetRestantCentimes: i.index === 0 ? 0 : 40 }) }));
    expect(r.end).toBe('Fiche-publiee');
    expect(r.calls.filter((c) => c.state === 'Verification').map((c) => c.input.docId)).toEqual(['d1']);
    expect(names(r).filter((n) => n === 'CoutSection')).toHaveLength(1);
  });
  it("aucune section avec fiche: B1 rend {ok:false} au quota, la machine s'arrete sans generation ni finalisation", async () => {
    const r = await go(base({ Extraction: () => ({ ok: true, claims: 0 }), ConsommationQuota: () => ({ ok: false }) }));
    expect(r.end).toBe('Termine-sans-fiche');
    for (const n of ['Generation', 'Finalisation', 'Verification']) expect(names(r)).not.toContain(n);
  });
  it("quota sans {ok} (ancien retour vide): Default vers Termine-sans-fiche, pas d'erreur States.Runtime", async () => {
    for (const out of [undefined, null, {}]) {
      const r = await go(base({ ConsommationQuota: () => out }));
      expect(r.end, JSON.stringify(out)).toBe('Termine-sans-fiche');
      expect(names(r)).not.toContain('Generation');
    }
  });
  it("echec d'une section: MarquerEchec puis Echec, sans quota ni generation", async () => {
    const r = await go(base({ Extraction: (i: In) => { if (i.index === 1) throw new Error('boom'); return { ok: true, docId: 'd0', claims: 5, budgetRestantCentimes: 40 }; } }));
    expect(r.end).toBe('Echec');
    expect(names(r)).toContain('MarquerEchec');
    expect(names(r)).not.toContain('ConsommationQuota');
  });
  it("echec de la generation d'une section: MarquerEchec, pas de finalisation", async () => {
    const r = await go(base({ Generation: (i: In) => { if (i.index === 1) throw new Error('boom'); } }));
    expect(r.end).toBe('Echec');
    expect(names(r)).not.toContain('Finalisation');
  });
  it('fichier ou cours refuse: fin sans fiche', async () => {
    expect((await go(base({ ControleFichier: () => ({ ok: false }) }))).end).toBe('Termine-sans-fiche');
    expect((await go(base({ Transcription: () => ({ ok: false }) }))).end).toBe('Termine-sans-fiche');
  });
});
