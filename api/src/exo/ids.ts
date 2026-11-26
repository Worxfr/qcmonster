import { randomBytes } from 'node:crypto';
import { newTestId } from '../../../shared/tests-history.js';

/** Identifiant de copie: ULID (temps + hasard), comme les identifiants de passage. */
export const newCopieId = (ms: number): string => newTestId(ms, randomBytes(16));
