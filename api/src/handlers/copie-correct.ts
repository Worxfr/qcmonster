// Lambda `copie-correct` (E1, role `copie-role`): etat `corriger` de la machine `copie`. Entree sans contenu {copieId, sid, fid, exoRef, pages}.
import { log } from '../../../shared/log/index.js';
import { s3Files, sharpReencoder } from '../exo/aws.js';
import { correctCopie } from '../exo/correct.js';
import type { CopieInput } from '../exo/ports.js';
import { processingDeps } from '../exo/runtime.js';

export const handler = async (input: CopieInput): Promise<{ etat: string }> => {
  const t0 = Date.now();
  const r = await correctCopie({ ...(await processingDeps()), files: s3Files(), images: sharpReencoder() }, { copieId: String(input.copieId), sid: String(input.sid), fid: String(input.fid), exoRef: String(input.exoRef), pages: Number(input.pages) });
  log({ step: 'copie-correct', status: r === 'corrigee' || r === 'illisible' ? 'ok' : 'rejected', durationMs: Date.now() - t0 });
  return { etat: r };
};
