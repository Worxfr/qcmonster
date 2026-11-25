import { mkdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';

// Remet a zero le compteur de vrais scans (mode dev) et le dossier des images fabriquees.
export default function globalSetup() {
  const tmp = resolve(import.meta.dirname, '..', '.tmp');
  rmSync(tmp, { recursive: true, force: true });
  mkdirSync(tmp, { recursive: true });
}
