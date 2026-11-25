import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { POLICY_VERSION } from './policy.js';

describe('politique de confidentialite', () => {
  const md = readFileSync(new URL('../docs/legal/politique-confidentialite.md', import.meta.url), 'utf8');
  it('la version du texte est celle que l\'API exige', () => {
    expect(md).toContain(`**Version : ${POLICY_VERSION}**`);
  });
  it('declare l\'envoi de mots a Wikimedia, les delais reels et la rectification', () => {
    expect(md).toMatch(/Wikim[ée]dia/);
    expect(md).toContain('au plus 8 mots');
    expect(md).toContain('dans les 2 jours');
    expect(md).toContain('supprimer le compte de l\'élève et le recréer');
  });
});
