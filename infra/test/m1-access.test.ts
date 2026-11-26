// M1 #89: ce que shared/m1-access.ts declare pour jobs-confirm est accorde au role SYNTHETISE de la fonction `jobs-confirm`
// (et le role n'a pas de joker). Le test d'API api/src/pipeline/m1-access.test.ts verifie l'autre sens (le code ne touche que ce qui est declare).
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';
process.env.QCM_NO_AUTORUN = '1';
process.env.CDK_CONTEXT_JSON = JSON.stringify({ webOrigin: 'https://front.example.invalid' });
const { buildApp } = await import('../bin/app.js');
import { JOBS_CONFIRM_ACCESS as A, type Partition } from '../../shared/m1-access.js';
import { ENVS, stackName } from '../../shared/names.js';

type Stmt = { Effect: string; Action: string | string[]; Resource?: unknown; Condition?: Record<string, Record<string, unknown>> };
type Res = { Type: string; Properties: Record<string, unknown> };
const list = <T>(v: T | T[] | undefined): T[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);
const acts = (s: Stmt) => list(s.Action).map(String);
const flat = (v: unknown): string => {
  if (typeof v === 'string') return v;
  const o = v as Record<string, unknown>;
  if (o && typeof o.Ref === 'string') return `{Ref:${o.Ref}}`;
  const j = o?.['Fn::Join'] as [string, unknown[]] | undefined;
  return j ? j[1].map(flat).join(j[0]) : JSON.stringify(v);
};
const covers = (key: string, p: Partition) => key !== '*' && key === `${p}*`;

for (const env of ENVS) {
  describe(`M1 #89 (${env}): droits synthetises de jobs-confirm`, () => {
    const app = buildApp(env, 'test@example.invalid');
    const t = Template.fromStack(app.node.findChild(stackName(env, 'pipeline')) as never).toJSON() as { Resources: Record<string, Res> };
    const fn = Object.values(t.Resources).find((r) => r.Type === 'AWS::Lambda::Function' && r.Properties.FunctionName === `qcm-${env}-jobs-confirm`)!;
    const roleId = (fn.Properties.Role as { 'Fn::GetAtt': string[] })['Fn::GetAtt'][0];
    const stmts: Stmt[] = Object.values(t.Resources)
      .filter((r) => r.Type === 'AWS::IAM::Policy' && (r.Properties.Roles as { Ref: string }[]).some((x) => x.Ref === roleId))
      .flatMap((r) => (r.Properties.PolicyDocument as { Statement: Stmt[] }).Statement)
      .filter((s) => s.Effect === 'Allow');

    it('DynamoDB: chaque (verbe, partition) declare est couvert par un LeadingKeys; aucune instruction sans LeadingKeys', () => {
      const ddb = stmts.filter((s) => acts(s).some((a) => a.startsWith('dynamodb:')));
      for (const s of ddb) expect(s.Condition?.['ForAllValues:StringLike']?.['dynamodb:LeadingKeys'], 'instruction DynamoDB sans LeadingKeys').toBeDefined();
      const granted = (action: string, p: Partition) => ddb.some((s) => acts(s).includes(action) && list(s.Condition!['ForAllValues:StringLike']['dynamodb:LeadingKeys'] as string[]).some((k) => covers(k, p)));
      const need: [string[], Partition[]][] = [[['dynamodb:GetItem'], A.get], [['dynamodb:Query'], A.query], [['dynamodb:PutItem', 'dynamodb:UpdateItem'], A.write], [['dynamodb:BatchWriteItem'], A.batch]];
      for (const [actions, parts] of need) for (const p of parts) for (const a of actions) expect(granted(a, p), `${a} sur ${p} non accorde a jobs-confirm`).toBe(true);
      // Les transactions (job + verrou) exigent aussi PutItem/UpdateItem sur les memes partitions: deja verifie ci-dessus.
    });

    it('S3 (scans/, figures/) et Step Functions declares sont accordes; aucun joker', () => {
      for (const s of stmts) for (const a of acts(s)) expect(a, 'action avec joker').not.toMatch(/\*/);
      const s3 = stmts.filter((s) => acts(s).some((a) => a.startsWith('s3:')));
      const has = (action: string, where: RegExp) => s3.some((s) => acts(s).includes(action) && (action === 's3:ListBucket' ? JSON.stringify(s.Condition).match(where) : list(s.Resource).map(flat).some((r) => where.test(r))));
      if (A.scans.includes('get')) expect(has('s3:GetObject', /\/scans\/\*$/)).toBe(true);
      if (A.scans.includes('list')) expect(has('s3:ListBucket', /scans\/\*/)).toBe(true);
      if (A.scans.includes('delete')) expect(has('s3:DeleteObject', /\/scans\/\*$/)).toBe(true);
      if (A.figures.includes('put')) expect(has('s3:PutObject', /\/figures\/\*$/)).toBe(true);
      if (A.figures.includes('list')) expect(has('s3:ListBucket', /figures\/\*/)).toBe(true);
      if (A.figures.includes('delete')) expect(has('s3:DeleteObject', /\/figures\/\*$/)).toBe(true);
      const sf = stmts.filter((s) => acts(s).some((a) => a.startsWith('states:')));
      for (const m of A.sfn) expect(sf.some((s) => acts(s).includes(`states:${m}`)), m).toBe(true);
    });

    it('pas de Bedrock: la confirmation ne lit ni ne vend rien au modele', () => {
      expect(stmts.some((s) => acts(s).some((a) => a.startsWith('bedrock:')))).toBe(false);
    });
  });
}
