/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Vite 6 (Rollup) volontairement: Vite 7 passe a Rolldown, que vite-plugin-pwa 0.21 ne gere pas.
export default defineConfig({
  define: { global: 'globalThis' }, // amazon-cognito-identity-js attend `global` dans le navigateur
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
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
});
