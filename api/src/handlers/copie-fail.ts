// Lambda `copie-fail` (E1, role `copie-role`): `Catch` de la machine `copie`. Supprime les images, passe la copie a `echec` et rembourse (une seule fois).
import { log } from '../../../shared/log/index.js';
import { s3Files } from '../exo/aws.js';
import { endWithoutCorrection } from '../exo/fail.js';
import type { CopieInput } from '../exo/ports.js';
import { processingDeps } from '../exo/runtime.js';

export const handler = async (input: CopieInput): Promise<{ rembourse: boolean }> => {
  const ok = await endWithoutCorrection(await processingDeps(), { copieId: String(input.copieId), sid: String(input.sid), fid: String(input.fid), exoRef: String(input.exoRef), pages: Number(input.pages) }, { etat: 'echec', motif: 'technique', refundPages: true, refundAttempt: true, files: s3Files() });
  log({ step: 'copie-fail', status: ok ? 'ok' : 'rejected' });
  return { rembourse: ok };
};
