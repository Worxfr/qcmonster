import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

export const isMock = process.env.E2E_MODE !== 'dev';
export const TMP = resolve(import.meta.dirname, '..', '.tmp');
export const API = `http://127.0.0.1:${process.env.MOCK_API_PORT ?? 4012}`;

/** Identifiants lus dans l'environnement seulement. Eleve = E2E_USER; parent (facultatif) = E2E_PARENT_USER. */
export const creds = {
  eleve: { user: process.env.E2E_USER ?? '', password: process.env.E2E_PASSWORD ?? '' },
  parent: { user: process.env.E2E_PARENT_USER ?? '', password: process.env.E2E_PARENT_PASSWORD ?? '' },
};

/** Nombre de vrais scans autorises en mode dev: E2E_REAL_SCANS (0 par defaut, 2 au maximum). */
export const REAL_SCANS = Math.max(0, Math.min(2, Math.floor(Number(process.env.E2E_REAL_SCANS ?? 0)) || 0));

const counter = resolve(TMP, 'real-scans-used');
/** Reserve un vrai scan. Renvoie false quand le budget est epuise (le test doit alors se sauter). Toujours vrai en mode mock. */
export function takeRealScan(): boolean {
  if (isMock) return true;
  const used = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0;
  if (used >= REAL_SCANS) return false;
  writeFileSync(counter, String(used + 1));
  return true;
}
