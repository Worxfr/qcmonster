import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['infra/test/**/*.test.ts', 'shared/**/*.test.ts', 'api/**/*.test.ts', 'mock/**/*.test.ts', 'scripts/**/*.test.ts', 'eval/**/*.test.ts', 'golden/**/*.test.ts'], testTimeout: 120000, hookTimeout: 120000 },
});
