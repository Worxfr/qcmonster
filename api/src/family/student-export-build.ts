// Fonction `me-export-build` (R1): construit l'archive de l'eleve en flux. Appelee seulement par `me-export` (appel asynchrone), jamais par API Gateway.
import { log } from '../../../shared/log/index.js';
import { buildStudentExport } from './student-export.js';
import { studentExportDeps } from './export-runtime.js';

const ID = /^[A-Za-z0-9_-]{1,64}$/;

export const handler = async (e: { sid?: unknown; exportId?: unknown }): Promise<void> => {
  if (typeof e.sid !== 'string' || typeof e.exportId !== 'string' || !ID.test(e.sid) || !ID.test(e.exportId)) throw new Error('evenement invalide');
  const t0 = Date.now();
  try {
    await buildStudentExport(studentExportDeps(), { sid: e.sid, exportId: e.exportId });
    log({ step: 'me-export-build', status: 'ok', durationMs: Date.now() - t0 });
  } catch (err) {
    log({ step: 'me-export-build', status: 'error', durationMs: Date.now() - t0, errorCode: (err as { name?: string })?.name });
    throw err;
  }
};
