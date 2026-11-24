import { spawn, type ChildProcess } from 'node:child_process';
import { resolve } from 'node:path';

// Demarre l'API simulee (Prism sur le contrat) pour les tests de parcours. Port distinct de `npm run mock` (4010).
const ROOT = resolve(process.cwd(), '..') + '/'; // vitest tourne depuis web/
export const MOCK_URL = 'http://127.0.0.1:4011';
let child: ChildProcess | undefined;

export async function startMock(): Promise<void> {
  child = spawn(`${ROOT}node_modules/.bin/prism`, ['mock', '-p', '4011', '-h', '127.0.0.1', 'shared/contract/openapi.yaml'], { cwd: ROOT, stdio: 'ignore' });
  for (let i = 0; i < 90; i++) {
    try {
      const r = await fetch(`${MOCK_URL}/me`, { headers: { authorization: 'Bearer x' } });
      if (r.ok) return;
    } catch {
      /* pas encore pret */
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error('API simulee injoignable');
}
export const stopMock = () => child?.kill();
