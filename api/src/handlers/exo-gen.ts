// Lambda `exo-gen` (E1, role `exo-role`, Haiku seulement): invoquee en asynchrone par exo-post. Aucun contenu n'est journalise.
import { generateExo } from '../exo/gen.js';
import type { GenInput } from '../exo/ports.js';
import { processingDeps } from '../exo/runtime.js';
import { log } from '../../../shared/log/index.js';

export const handler = async (input: GenInput): Promise<void> => {
  const t0 = Date.now();
  const r = await generateExo(await processingDeps(), { sid: String(input.sid), fid: String(input.fid), docId: String(input.docId), nn: Number(input.nn) });
  log({ step: 'exo-gen', status: r === 'prete' ? 'ok' : 'rejected', durationMs: Date.now() - t0 });
};
