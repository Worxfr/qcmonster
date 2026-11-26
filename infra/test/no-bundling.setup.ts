// Les tests d'infra construisent l'application complete des dizaines de fois; chaque construction lancait ~20 bundles esbuild
// synchrones (1050 par run), ce qui bloquait le worker vitest plus de 60 s sur un runner charge ("Timeout calling onTaskUpdate").
// On saute le bundling esbuild ici. Il reste verifie en CI par l'etape `cdk synth` (dev et prod) du workflow, qui bundle pour de vrai.
import { vi } from 'vitest';

vi.mock('aws-cdk-lib', async (importOriginal) => {
  const cdk = await importOriginal<typeof import('aws-cdk-lib')>();
  class NoBundlingApp extends cdk.App {
    constructor(props: ConstructorParameters<typeof cdk.App>[0] = {}) {
      super({ ...props, context: { 'aws:cdk:bundling-stacks': [], ...props.context } });
    }
  }
  return { ...cdk, App: NoBundlingApp };
});
