import { defineConfig, devices } from '@playwright/test';

// Deux modes. mock (defaut): site en connexion simulee + API factice locale, sans AWS. dev: site dev reel, lance a la main.
const mode = process.env.E2E_MODE === 'dev' ? 'dev' : 'mock';
const WEB_PORT = 5174;
const API_PORT = 4012;

if (mode === 'dev') {
  for (const k of ['E2E_BASE_URL', 'E2E_USER', 'E2E_PASSWORD']) {
    if (!process.env[k]) throw new Error(`Mode dev: la variable ${k} est obligatoire (voir e2e/README.md).`);
  }
}
const baseURL = mode === 'dev' ? process.env.E2E_BASE_URL! : `http://127.0.0.1:${WEB_PORT}`;

export default defineConfig({
  testDir: './tests',
  outputDir: './.artifacts/results',
  globalSetup: './support/global-setup.ts',
  workers: 1, // un seul processus: l'API factice a un seul etat, et le mode dev ne doit pas lancer deux scans a la fois
  fullyParallel: false,
  retries: 0,
  timeout: mode === 'dev' ? 360_000 : 60_000,
  expect: { timeout: mode === 'dev' ? 30_000 : 10_000 },
  reporter: mode === 'dev' ? 'list' : [['list'], ['html', { outputFolder: './.artifacts/report', open: 'never' }]],
  use: {
    baseURL,
    actionTimeout: 30_000, // sans plafond, un clic sur un bouton absent attend jusqu'a la fin du test
    navigationTimeout: 60_000,
    viewport: { width: 1280, height: 900 },
    locale: 'fr-FR',
    // Mode dev: ni capture, ni video, ni trace (elles pourraient montrer l'identifiant tape). Activables avec E2E_CAPTURES=1.
    screenshot: mode === 'mock' || process.env.E2E_CAPTURES === '1' ? 'only-on-failure' : 'off',
    video: mode === 'mock' ? 'retain-on-failure' : 'off',
    trace: mode === 'mock' ? 'retain-on-failure' : 'off',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 900 } } }],
  webServer:
    mode === 'dev'
      ? undefined
      : [
          { command: 'node mock-api/server.mjs', url: `http://127.0.0.1:${API_PORT}/__test/state`, env: { MOCK_API_PORT: String(API_PORT) }, reuseExistingServer: !process.env.CI, timeout: 30_000 },
          {
            command: `npm run dev -w web -- --host 127.0.0.1 --port ${WEB_PORT} --strictPort`,
            cwd: '..',
            url: `http://127.0.0.1:${WEB_PORT}`,
            env: { VITE_API_URL: `http://127.0.0.1:${API_PORT}`, VITE_AUTH_MODE: 'mock' },
            reuseExistingServer: !process.env.CI,
            timeout: 90_000,
          },
        ],
});
