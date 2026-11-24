import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Squelette (lot 1). Le lot 4 ajoute la PWA (vite-plugin-pwa, attention: rester sur Vite 6/Rollup).
export default defineConfig({ plugins: [react()] });
