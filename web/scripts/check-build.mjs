// Apres `vite build`: la PWA doit etre installable (service worker, manifeste, icones, aucune ressource cachee en dehors de l'app).
import { existsSync, readFileSync } from 'node:fs';

const need = ['dist/sw.js', 'dist/manifest.webmanifest', 'dist/index.html', 'dist/icons/icon-192.png', 'dist/icons/icon-512.png'];
const missing = need.filter((f) => !existsSync(new URL(`../${f}`, import.meta.url)));
if (missing.length) {
  console.error(`PWA incomplete, fichiers absents: ${missing.join(', ')}`);
  process.exit(1);
}
const m = JSON.parse(readFileSync(new URL('../dist/manifest.webmanifest', import.meta.url), 'utf8'));
const sizes = (m.icons ?? []).map((i) => i.sizes);
if (m.display !== 'standalone' || !m.start_url || !sizes.includes('192x192') || !sizes.includes('512x512')) {
  console.error('Manifeste invalide (display, start_url, icones 192 et 512)');
  process.exit(1);
}
if (/Rolldown/i.test(readFileSync(new URL('../dist/sw.js', import.meta.url), 'utf8'))) process.exit(1);
console.log('PWA OK: sw.js, manifest.webmanifest, icones');
