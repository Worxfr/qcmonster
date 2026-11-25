#!/usr/bin/env node
// Point d'entree CDK COMPLET (design-v2 10.1): toutes les stacks sont importees ici, apres le lot 1 ce fichier ne change plus.
// Chaque fichier de stack appartient a un seul lot. Usage: cdk synth -c env=dev|prod
import { App, Tags } from 'aws-cdk-lib';
import { ENVS, OWNER, PROJECT, REGION, stackName, type Env } from '../../shared/names.js';
import { AuthStack } from '../lib/auth-stack.js';
import { DataStack } from '../lib/data-stack.js';
import { ApiStack } from '../lib/api-stack.js';
import { ModelsStack } from '../lib/models-stack.js';
import { BudgetStack } from '../lib/budget-stack.js';
import { PipelineStack } from '../lib/pipeline-stack.js';
import { VerifyStack } from '../lib/verify-stack.js';
import { GameStack } from '../lib/game-stack.js';
import { EvalStack } from '../lib/eval-stack.js';
import { WebContentStack, WebStack } from '../lib/web-stack.js';

export function buildApp(envName: Env, alertEmail: string, context?: Record<string, string>): App {
  const app = new App({ context });
  // Le compte vient de l'environnement (CDK_DEFAULT_ACCOUNT, fourni par la CLI CDK): jamais ecrit dans le depot.
  const env = { account: process.env.CDK_DEFAULT_ACCOUNT, region: REGION };
  const common = { env, envName };
  const n = (s: string) => stackName(envName, s);

  // Le site est cree EN PREMIER: Data, Api et Game lisent son origine (CORS) et en dependent (voir webOriginFor).
  const web = new WebStack(app, n('web'), { ...common, stackName: n('web') });
  // Contenu du site: seulement avec `-c webDist=<dossier du build>` (apres le build du front, voir deploy.yml).
  const webDist = app.node.tryGetContext('webDist') as string | undefined;
  if (webDist) new WebContentStack(app, n('web-content'), { ...common, stackName: n('web-content'), site: web, distDir: webDist });

  new DataStack(app, n('data'), { ...common, stackName: n('data') });
  new AuthStack(app, n('auth'), { ...common, stackName: n('auth') });
  new ApiStack(app, n('api'), { ...common, stackName: n('api') });
  new ModelsStack(app, n('models'), { ...common, stackName: n('models') });
  new BudgetStack(app, n('budget'), { ...common, stackName: n('budget'), alertEmail });
  new PipelineStack(app, n('pipeline'), { ...common, stackName: n('pipeline') });
  new VerifyStack(app, n('verify'), { ...common, stackName: n('verify') });
  new GameStack(app, n('game'), { ...common, stackName: n('game') });
  // Voie d'evaluation: DEV seulement et seulement avec `-c evalPath=true` (voir eval/README.md). En prod, la demander est une erreur.
  if (String(app.node.tryGetContext('evalPath')) === 'true') {
    if (envName !== 'dev') throw new Error("evalPath=true n'est permis qu'en dev");
    new EvalStack(app, n('eval'), { ...common, stackName: n('eval'), subPrefix: String(app.node.tryGetContext('evalSubPrefix') ?? '') });
  }

  // Tags obligatoires sur TOUTES les ressources (test CI: infra/test/tags.test.ts).
  Tags.of(app).add('Project', PROJECT);
  Tags.of(app).add('Environment', envName);
  Tags.of(app).add('ManagedBy', 'CDK');
  Tags.of(app).add('Owner', OWNER);
  return app;
}

// Execution directe par la CLI CDK (pas pendant les tests, qui importent buildApp).
if (process.env.QCM_NO_AUTORUN !== '1') {
  // La CLI passe `-c env=...` dans CDK_CONTEXT_JSON (pas d'App intermediaire: il ecraserait cdk.out).
  const ctx = JSON.parse(process.env.CDK_CONTEXT_JSON ?? '{}') as { env?: string };
  const envName = (ctx.env ?? 'dev') as Env;
  if (!ENVS.includes(envName)) throw new Error(`env invalide: ${envName} (attendu: ${ENVS.join(', ')})`);
  const alertEmail = process.env.QCM_ALERT_EMAIL ?? 'alerte-a-configurer@example.invalid';
  buildApp(envName, alertEmail).synth();
}
