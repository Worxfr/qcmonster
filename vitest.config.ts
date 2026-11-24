import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['infra/test/**/*.test.ts', 'shared/**/*.test.ts', 'api/**/*.test.ts', 'mock/**/*.test.ts', 'scripts/**/*.test.ts', 'eval/**/*.test.ts', 'golden/**/*.test.ts'], testTimeout: 120000, hookTimeout: 120000,
    // npm run test:cov. Seuil de branches par repertoire: api/src/game/** (L3, >= 90 %, design 10.3). Sans fichier correspondant le seuil ne s'applique pas.
    coverage: { provider: 'v8', include: ['api/src/**', 'shared/**'], exclude: ['**/*.test.ts', 'shared/contract/generated/**'], thresholds: { 'api/src/game/**': { branches: 90 } } },
  },
});
