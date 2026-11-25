/// <reference types="vitest/config" />
import { defineConfig, loadEnv, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// CSP posee en <meta> au build (le HTML de dev a besoin de scripts inline pour le rechargement a chaud).
// Pour une politique en en-tete CloudFront, voir docs/ops (lot de deploiement): memes directives.
function csp(env: Record<string, string>): Plugin {
  return {
    name: 'qcm-csp',
    apply: 'build',
    transformIndexHtml(html) {
      const api = env.VITE_API_URL ? new URL(env.VITE_API_URL).origin : '';
      const region = (env.VITE_COGNITO_POOL_ID ?? '').split('_')[0] || 'eu-west-3';
      const s3 = `https://*.s3.${region}.amazonaws.com`;
      const policy = [
        "default-src 'self'",
        "script-src 'self'",
        "style-src 'self'",
        `connect-src 'self' ${api} https://cognito-idp.${region}.amazonaws.com ${s3}`.replace(/ +/g, ' '),
        `img-src 'self' data: blob: ${s3}`,
        `form-action 'self' ${s3}`,
        "worker-src 'self'",
        "manifest-src 'self'",
        "object-src 'none'",
        "base-uri 'self'",
      ].join('; ');
      return html.replace('<head>', `<head>\n    <meta http-equiv="Content-Security-Policy" content="${policy}" />`);
    },
  };
}

// Vite 6 (Rollup) volontairement: Vite 7 passe a Rolldown, que vite-plugin-pwa 0.21 ne gere pas.
export default defineConfig(({ mode }) => ({
  define: { global: 'globalThis' }, // amazon-cognito-identity-js attend `global` dans le navigateur
  plugins: [
    react(),
    csp(loadEnv(mode, process.cwd(), 'VITE_')),
    VitePWA({
      registerType: 'prompt', // bandeau « Nouvelle version » (components/UpdateBanner.tsx): pas de rechargement force en plein envoi de photo
      manifest: {
        name: 'QCMonster',
        short_name: 'QCMonster',
        description: 'Scanne ton cours, deviens plus fort.',
        lang: 'fr',
        start_url: '/',
        scope: '/',
        display: 'standalone',
        orientation: 'portrait',
        background_color: '#fff8e7',
        theme_color: '#6d28d9',
        icons: [
          { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icons/icon-512-maskable.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,webmanifest}'],
        navigateFallback: 'index.html',
        // Aucun cache d'appel d'API ni de photo: seules les ressources de l'application sont precachees.
      },
    }),
  ],
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    include: ['src/**/*.test.{ts,tsx}'],
    testTimeout: 60000,
    hookTimeout: 120000,
    env: { VITE_API_URL: 'http://127.0.0.1:4011', VITE_AUTH_MODE: 'mock' },
  },
}));
