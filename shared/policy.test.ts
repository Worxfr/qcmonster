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

describe('version de la politique: coherence entre texte, contrat et site', () => {
  const root = new URL('../', import.meta.url);
  const read = (p: string) => readFileSync(new URL(p, root), 'utf8');
  it('tous les exemples policyVersion du contrat sont la version en vigueur', () => {
    const found = [...read('shared/contract/openapi.yaml').matchAll(/policyVersion: '([0-9-]+)'/g)].map((m) => m[1]);
    expect(found.length).toBeGreaterThan(0);
    expect(new Set(found)).toEqual(new Set([POLICY_VERSION]));
  });
  it('la version est de la forme AAAA-MM-JJ (patron du contrat) et definie une seule fois dans le code', () => {
    expect(POLICY_VERSION).toMatch(/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/);
    expect(read('shared/contract/openapi.yaml')).toContain("pattern: '^[0-9]{4}-[0-9]{2}-[0-9]{2}$'");
    for (const f of ['web/src/screens/Parent.tsx', 'web/src/screens/PolicyAgain.tsx', 'web/src/screens/CreateFamily.tsx', 'api/src/family/family.ts', 'api/src/family/students.ts']) {
      expect(read(f), f).not.toMatch(/['"]20[0-9]{2}-[0-9]{2}-[0-9]{2}['"]/);
      expect(read(f), f).toContain('POLICY_VERSION');
    }
  });
  it('tous les textes importes par la page Policy.tsx existent', () => {
    const imports = [...read('web/src/screens/Policy.tsx').matchAll(/from '([^']+\.md)\?raw'/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const i of imports) expect(() => readFileSync(new URL(i.replace('../../../', ''), root)), i).not.toThrow();
  });
});

describe('ligne « Version : » du texte', () => {
  it('est exactement POLICY_VERSION', () => {
    const md = readFileSync(new URL('../docs/legal/politique-confidentialite.md', import.meta.url), 'utf8');
    const m = [...md.matchAll(/^\*\*Version : ([0-9-]+)\*\*$/gm)];
    expect(m).toHaveLength(1);
    expect(m[0][1]).toBe(POLICY_VERSION);
  });
});
