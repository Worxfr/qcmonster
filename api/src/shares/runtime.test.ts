// Relecture #111 m1: l'interrupteur SHARE_PUBLIC_ENABLED n'ouvre que sur la valeur exacte `true`; variable absente (ou autre valeur) = FERME.
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { shareCtx } from '../handlers/shares-runtime.js';

const saved = { ...process.env };
beforeEach(() => {
  process.env.QCM_ENV = 'dev';
  process.env.TABLE_NAME = 'qcm-dev';
  delete process.env.SHARE_PUBLIC_ENABLED;
});
afterEach(() => {
  process.env = { ...saved };
});

describe('shareCtx: interrupteur', () => {
  it('variable absente: ferme', () => {
    expect(shareCtx().publicEnabled).toBe(false);
  });
  it('seule la valeur exacte `true` ouvre', () => {
    for (const v of ['false', '', 'TRUE', 'True', '1', 'yes', ' true', 'true ', 'on']) {
      process.env.SHARE_PUBLIC_ENABLED = v;
      expect(shareCtx().publicEnabled, JSON.stringify(v)).toBe(false);
    }
    process.env.SHARE_PUBLIC_ENABLED = 'true';
    expect(shareCtx().publicEnabled).toBe(true);
  });
  it('QCM_ENV ou TABLE_NAME manquant: erreur claire (pas de 500 muet en prod)', () => {
    delete process.env.TABLE_NAME;
    expect(() => shareCtx()).toThrow('TABLE_NAME manquant');
    process.env.TABLE_NAME = 'x';
    process.env.QCM_ENV = 'zzz';
    expect(() => shareCtx()).toThrow('QCM_ENV invalide');
  });
});
