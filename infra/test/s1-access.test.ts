// TEST CLE (S1-D, #34, docs/S1-design.md section 11; faille recurrente de #95, #96 et #99: un droit oublie ou accorde en trop). SOURCE UNIQUE: shared/share-access.ts.
//  1. les TROIS roles nouveaux (shareMake, shareManage, sharePublic) ont EXACTEMENT les droits declares (comparaison d'ensembles, dans les deux sens), sans joker;
//  2. les trois roles existants qui suppriment avec l'option `deleteShares` (deleteRole, coursRole, admin) ont une instruction SEPAREE `SHARE#*` (Query, BatchWriteItem) et
//     les droits de base que `deleteSharesOf` exige sur STUDENT# et FAMILY#;
//  3. RECIPROQUEMENT: parmi TOUS les roles de TOUTES les stacks, seuls ces six atteignent `SHARE#*` (un role sans LeadingKeys ou avec un motif large compte): `manage`, `play`,
//     `readRole`, `writeRole`, `confirmRole`, `pipeline-role`, `scansDeleteRole`, `revise`... n'ont rien;
//  4. les APPELANTS de la suppression en cascade: la source des handlers est relue; seuls les fichiers declares activent l'option, ceux du pipeline (failJob, append, annulation d'un scan)
//     et de la modification d'un cours ne la mentionnent jamais, et tout fichier qui appelle une fonction de suppression est classe.
// Limites dites: IAM ne filtre pas la cle de tri; le test ne voit que les droits, pas ce que le code FAIT (lot S1-A: api/src/shares/access.test.ts avec enregistreur d'acces).
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { Stack } from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
import { SHARE_DDB_ACTIONS, VERBS, shareAccessOf } from '../lib/share-access.js';
import { DELETE_SHARES_ACCESS, DELETE_SHARES_ADDED, NO_SHARE_CALLER_FILES, SHARE_DELETE_CALLERS, SHARE_HANDLERS, type DeleteRole, type Partition, type ShareRole } from '../../shared/share-access.js';
import { ENVS, type Env } from '../../shared/names.js';

type Stmt = { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Res = { Type: string; Properties: Record<string, unknown> };
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const acts = (s: Stmt) => list(s.Action).map(String);
const leadingOf = (s: Stmt): string[] | undefined => {
  const v = s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'];
  return v === undefined ? undefined : list(v as string | string[]).map(String);
};
const glob = (pattern: string): RegExp => new RegExp(`^${pattern.split('*').map((x) => x.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*')}$`);
const SAMPLE = 'SHARE#0123456789abcdef';
/** Un motif de LeadingKeys atteint-il SHARE#? Sans condition: oui. */
const reachesShare = (s: Stmt): boolean => { const k = leadingOf(s); return k === undefined || k.some((p) => glob(p).test(SAMPLE)); };
/** Action DynamoDB sur des elements (les actions d'une autre famille, comme `dynamodb:DescribeTable`, ne lisent aucun element). */
const DATA = /^(\*|dynamodb:\*|dynamodb:(GetItem|BatchGetItem|Query|Scan|PutItem|UpdateItem|DeleteItem|BatchWriteItem|ConditionCheckItem|TransactWriteItems|TransactGetItems|PartiQL.*))$/;
const covers = (key: string, p: Partition) => key !== '*' && key === `${p}*`;
/**
 * ECART CONNU, hors du lot S1-D (a decider par le conducteur): `pipeline-role` (qui porte failJob, append et les etapes de la machine) et `pipeline-trigger-role` ont une instruction DynamoDB
 * SANS `dynamodb:LeadingKeys` (`ddb(rw)` et `ddb([GetItem, UpdateItem])` de pipeline-stack.ts): ils atteignent donc TOUTE la table, `SHARE#*` compris (docs/S1-design.md section 11
 * dit « aucun droit sur SHARE#* », ce qui est faux pour ces deux roles). Le test les liste pour que la liste ne grossisse jamais en silence et echoue si l'un d'eux est resserre
 * (retirer alors la ligne). Pour failJob et append, « pas de suppression des partages » repose donc sur le CODE (option absente, test d'appelants ci-dessous), pas sur IAM.
 */
const KNOWN_TABLE_WIDE = (env: Env) => [`qcm-${env}-pipeline-role`, `qcm-${env}-pipeline-trigger-role`];
const NEW_ROLE_KEY: Record<ShareRole, string> = { shareMake: 'shareMake', shareManage: 'shareManage', sharePublic: 'sharePublic' };
const DELETE_ROLE_NAME = (env: Env, r: DeleteRole) => ({ delete: `qcm-${env}-pipeline-api-delete-role`, cours: `qcm-${env}-pipeline-api-cours-role`, admin: `qcm-${env}-game-admin-role` })[r];

function index(env: Env) {
  const app = buildApp(env, 'test@example.invalid');
  const stmtsOfRole = new Map<string, Stmt[]>();
  const roleOfFn = new Map<string, string>();
  for (const stack of app.node.children.filter((c): c is Stack => c instanceof Stack)) {
    const t = Template.fromStack(stack).toJSON() as { Resources: Record<string, Res> };
    const nameOf = (logical: string) => String(t.Resources[logical]?.Properties.RoleName ?? `${stack.node.id}/${logical}`);
    for (const [id, r] of Object.entries(t.Resources)) {
      if (r.Type === 'AWS::Lambda::Function') roleOfFn.set(String(r.Properties.FunctionName), nameOf((r.Properties.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0]));
      if (r.Type === 'AWS::IAM::Policy') {
        for (const ref of r.Properties.Roles as { Ref: string }[]) stmtsOfRole.set(nameOf(ref.Ref), [...(stmtsOfRole.get(nameOf(ref.Ref)) ?? []), ...(r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement]);
      }
      if (r.Type === 'AWS::IAM::Role') {
        const inline = list(r.Properties.Policies as { PolicyDocument: { Statement: Stmt[] } }[] | undefined).flatMap((p) => p.PolicyDocument.Statement);
        stmtsOfRole.set(nameOf(id), [...(stmtsOfRole.get(nameOf(id)) ?? []), ...inline]);
      }
      if (r.Type === 'AWS::IAM::ManagedPolicy') for (const ref of list(r.Properties.Roles as { Ref: string }[] | undefined)) stmtsOfRole.set(nameOf(ref.Ref), [...(stmtsOfRole.get(nameOf(ref.Ref)) ?? []), ...(r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement]);
    }
  }
  return { stmtsOfRole, roleOfFn };
}

/** Action DynamoDB -> partitions (motifs de LeadingKeys, `SHARE#*` sous la forme `SHARE#`), pour les instructions qui atteignent `SHARE#`. */
function shareActions(stmts: Stmt[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const s of stmts.filter((x) => x.Effect === 'Allow')) {
    for (const a of acts(s).filter((x) => DATA.test(x))) if (reachesShare(s)) out.set(a, [...(out.get(a) ?? []), ...(leadingOf(s) ?? ['(sans LeadingKeys)'])]);
  }
  return out;
}

for (const env of ENVS) {
  describe(`S1-D (${env}): droits synthetises du partage de QCM`, () => {
    const { stmtsOfRole, roleOfFn } = index(env);
    const stmts = (role: string) => { const s = stmtsOfRole.get(role); expect(s, `role ${role} introuvable dans le gabarit`).toBeDefined(); return s!.filter((x) => x.Effect === 'Allow'); };

    for (const role of Object.keys(NEW_ROLE_KEY) as ShareRole[]) {
      it(`${role}: exactement les droits de shared/share-access.ts (verbes et partitions, dans les deux sens), sans joker`, () => {
        const name = `qcm-${env}-game-${NEW_ROLE_KEY[role]}-role`;
        const s = stmts(name);
        const decl = shareAccessOf(role);
        // Aucune instruction hors DynamoDB (aucun S3, Bedrock, Step Functions, Lambda); aucune ressource `*`; aucune action avec joker; toujours un LeadingKeys.
        for (const st of s) {
          for (const a of acts(st)) { expect(a, `${name}: action avec joker`).not.toMatch(/\*/); expect(a, `${name}: hors DynamoDB`).toMatch(/^dynamodb:/); }
          expect(JSON.stringify(st.Resource), `${name}: ressource *`).not.toMatch(/"\*"|^"\*"$/);
          expect(leadingOf(st), `${name}: instruction DynamoDB sans LeadingKeys`).toBeDefined();
        }
        const granted = new Map<string, Set<string>>();
        for (const st of s) for (const a of acts(st)) granted.set(a, new Set([...(granted.get(a) ?? []), ...leadingOf(st)!]));
        const wanted = new Map<string, Set<string>>(VERBS.filter((v) => decl[v].length).map((v) => [SHARE_DDB_ACTIONS[v], new Set(decl[v].map((p) => `${p}*`))]));
        expect([...granted.keys()].sort(), `${name}: actions accordees != actions declarees`).toEqual([...wanted.keys()].sort());
        for (const [a, parts] of wanted) expect([...granted.get(a)!].sort(), `${name}: partitions de ${a}`).toEqual([...parts].sort());
      });
    }

    it('les handlers du partage sont les huit de la conception; chaque role nouveau porte au moins un handler', () => {
      expect(Object.keys(SHARE_HANDLERS).sort()).toEqual(['shares-create', 'shares-delete', 'shares-list', 'shares-open', 'shares-parent-delete', 'shares-parent-list', 'shares-report', 'shares-shareable']);
      for (const role of Object.keys(NEW_ROLE_KEY)) expect(Object.values(SHARE_HANDLERS).some((h) => h.role === role), role).toBe(true);
    });

    it('sharePublic: SHARE# seulement, aucun Query, aucune suppression; shareManage: jamais DOC#; shareMake: ni JOB#, ni EXO#, ni suppression', () => {
      const pub = stmts(`qcm-${env}-game-sharePublic-role`);
      expect(pub.flatMap(acts)).not.toContain('dynamodb:Query');
      expect(pub.flatMap(acts).filter((a) => /Delete|Batch|Scan/.test(a))).toEqual([]);
      for (const st of pub) expect(leadingOf(st)).toEqual(['SHARE#*']);
      for (const st of stmts(`qcm-${env}-game-shareManage-role`)) expect(leadingOf(st)!.some((k) => covers(k, 'DOC#'))).toBe(false);
      for (const st of stmts(`qcm-${env}-game-shareManage-role`)) expect(acts(st).filter((a) => /PutItem|UpdateItem|ConditionCheck|DeleteItem/.test(a))).toEqual([]);
      for (const st of stmts(`qcm-${env}-game-shareMake-role`)) {
        expect(leadingOf(st)!.some((k) => /^(JOB#|EXO#|COST#|ACTIVATION#)/.test(k))).toBe(false);
        expect(acts(st).filter((a) => /Delete|Batch/.test(a))).toEqual([]);
      }
      // La transaction de creation exige ConditionCheckItem sur l'eleve (FAMILY#) et la fiche (STUDENT#): sans lui, AccessDenied et aucun lien.
      const chk = stmts(`qcm-${env}-game-shareMake-role`).filter((st) => acts(st).includes('dynamodb:ConditionCheckItem')).flatMap((st) => leadingOf(st)!);
      expect(chk.sort()).toEqual(['FAMILY#*', 'STUDENT#*']);
    });

    for (const role of ['delete', 'cours', 'admin'] as const) {
      it(`${DELETE_ROLE_NAME(env, role)}: instruction SEPAREE SHARE#* (Query, BatchWriteItem) et droits de base de deleteSharesOf; aucun autre motif n'atteint SHARE#`, () => {
        const name = DELETE_ROLE_NAME(env, role);
        const s = stmts(name);
        const shareStmts = s.filter((st) => acts(st).some((a) => DATA.test(a)) && reachesShare(st));
        expect(shareStmts, `${name}: une seule instruction atteint SHARE#`).toHaveLength(1);
        expect(leadingOf(shareStmts[0])).toEqual(['SHARE#*']);
        expect(acts(shareStmts[0]).sort()).toEqual(VERBS.filter((v) => DELETE_SHARES_ADDED[v].length).map((v) => SHARE_DDB_ACTIONS[v]).sort());
        expect(JSON.stringify(shareStmts[0].Resource)).not.toMatch(/GSI1/);
        // Droits de base (deja la avant S1-D): ce que deleteSharesOf lit et supprime sous STUDENT# (references) et FAMILY# (emplacements).
        for (const v of VERBS) for (const p of DELETE_SHARES_ACCESS[v].filter((x) => x !== 'SHARE#')) {
          expect(s.some((st) => acts(st).includes(SHARE_DDB_ACTIONS[v]) && leadingOf(st)?.some((k) => covers(k, p))), `${name}: ${SHARE_DDB_ACTIONS[v]} sur ${p}`).toBe(true);
        }
      });
    }

    it('RECIPROQUE: parmi tous les roles de toutes les stacks, seuls les six roles declares atteignent SHARE#; manage, play, pipeline et revise n\'ont rien', () => {
      const allowed = new Set<string>([...Object.keys(NEW_ROLE_KEY).map((k) => `qcm-${env}-game-${k}-role`), ...(['delete', 'cours', 'admin'] as const).map((r) => DELETE_ROLE_NAME(env, r))]);
      const reaching = [...stmtsOfRole.keys()].filter((n) => shareActions(stmtsOfRole.get(n)!).size > 0);
      expect(reaching.filter((n) => !allowed.has(n)).sort(), 'role non declare qui atteint SHARE# (hors ecart connu)').toEqual(KNOWN_TABLE_WIDE(env).sort());
      for (const n of KNOWN_TABLE_WIDE(env)) expect(stmtsOfRole.get(n)!.some((st) => st.Effect === 'Allow' && acts(st).some((a) => DATA.test(a)) && leadingOf(st) === undefined), `${n}: l'ecart connu n'existe plus, retirer la ligne`).toBe(true);
      expect([...allowed].filter((n) => !reaching.includes(n)), 'role declare sans acces').toEqual([]);
      for (const n of [`qcm-${env}-game-manage-role`, `qcm-${env}-game-play-role`, `qcm-${env}-pipeline-api-read-role`, `qcm-${env}-pipeline-api-write-role`, `qcm-${env}-pipeline-api-confirm-role`, `qcm-${env}-pipeline-api-scans-delete-role`]) {
        expect(stmtsOfRole.has(n), `role ${n} introuvable (le test doit le couvrir)`).toBe(true);
        expect([...shareActions(stmtsOfRole.get(n)!).keys()], n).toEqual([]);
      }
      for (const n of [`qcm-${env}-revise-role`, `qcm-${env}-revise-start-role`]) if (stmtsOfRole.has(n)) expect([...shareActions(stmtsOfRole.get(n)!).keys()], n).toEqual([]);
    });

    it('les fonctions qui appellent la suppression avec l\'option sont portees par le role declare; students-update (manage) et les fonctions du pipeline ne le sont pas', () => {
      for (const [h, c] of Object.entries(SHARE_DELETE_CALLERS)) expect(roleOfFn.get(`qcm-${env}-${h}`), `fonction ${h}`).toBe(DELETE_ROLE_NAME(env, c.role));
      expect(roleOfFn.get(`qcm-${env}-students-update`)).toBe(`qcm-${env}-game-manage-role`);
      expect(shareActions(stmts(`qcm-${env}-game-manage-role`)).size).toBe(0);
      for (const f of ['scans-delete', 'jobs-confirm', 'scans-create']) {
        const role = roleOfFn.get(`qcm-${env}-${f}`);
        if (role) expect(shareActions(stmts(role)).size, f).toBe(0);
      }
    });
  });
}

// --- Appelants de la suppression en cascade (source relue: pas de synthese).
const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const walk = (dir: string): string[] => readdirSync(dir).flatMap((f) => { const p = join(dir, f); return statSync(p).isDirectory() ? walk(p) : [p]; });
const sources = walk(join(ROOT, 'api/src')).filter((p) => p.endsWith('.ts') && !/\.test\.ts$|\.spec\.ts$/.test(p)).map((p) => ({ rel: relative(ROOT, p), code: readFileSync(p, 'utf8').split('\n').map((l) => l.replace(/\/\/.*$/, '')).join('\n') }));
const TREE_CALL = /\b(deleteDocTree|deleteCoursTree|deleteStudentTree|deleteFamilyTree|deleteSharesOf)\s*\(/;

describe('S1-D: appelants de deleteDocTree et des autres suppressions en cascade', () => {
  const declared = new Set(Object.values(SHARE_DELETE_CALLERS).map((c) => c.file));
  const known = new Set<string>([...declared, ...NO_SHARE_CALLER_FILES]);
  it('tout fichier de l\'API qui appelle une suppression en cascade est classe (declare ou sans option): un nouvel appelant doit etre decide', () => {
    const callers = sources.filter((s) => TREE_CALL.test(s.code)).map((s) => s.rel);
    expect(callers.filter((f) => !known.has(f) && !f.startsWith('api/src/shares/') && !/^api\/src\/handlers\/shares-/.test(f))).toEqual([]);
  });
  it('les fichiers du pipeline (failJob, append, annulation d\'un scan) et de M1 ne mentionnent jamais l\'option ni deleteSharesOf', () => {
    for (const f of NO_SHARE_CALLER_FILES) {
      const s = sources.find((x) => x.rel === f);
      expect(s, `${f} introuvable`).toBeDefined();
      expect(s!.code, f).not.toMatch(/deleteShares/);
    }
    for (const s of sources.filter((x) => /^api\/src\/(pipeline|revise|exo)\//.test(x.rel))) expect(s.code, s.rel).not.toMatch(/deleteShares/);
  });
  it('l\'option n\'apparait que dans les fichiers declares (et les handlers de partage du lot S1-A)', () => {
    const using = sources.filter((s) => /deleteShares/.test(s.code)).map((s) => s.rel);
    expect(using.filter((f) => !declared.has(f) && !f.startsWith('api/src/shares/') && !/^api\/src\/handlers\/shares-/.test(f))).toEqual([]);
  });
  it('les fichiers declares existent et appellent bien la fonction de suppression annoncee', () => {
    for (const [h, c] of Object.entries(SHARE_DELETE_CALLERS)) {
      const s = sources.find((x) => x.rel === c.file);
      expect(s, `${h}: ${c.file} introuvable`).toBeDefined();
      expect(s!.code, `${h}: ${c.tree}`).toMatch(new RegExp(`\\b${c.tree}\\s*\\(`));
    }
  });
});

// S1-A (docs/S1-design.md section 15): exiger `deleteShares` dans les quatre fichiers de SHARE_DELETE_CALLERS quand leurs handlers passent l'option.
it.todo('S1-A: docs.ts, cours.ts, students.ts et family.ts passent l\'option deleteShares (un oubli laisserait des copies publiques apres suppression)');
