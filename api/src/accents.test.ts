import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

// Messages visibles par l'élève ou le parent: aucun ne doit revenir sans accent.
const SANS_ACCENT = [
  "Annule par l'eleve", 'deja un dossier', 'Quota de pages epuise', 'pas a confirmer', 'plus a confirmer',
  'une matiere pour tout', 'plus etre annule', "Reserve a l'eleve", 'Reserve au parent', 'Acces refuse',
  'Requete invalide', 'Etat incompatible', 'reessayez', "Reessayez", 'Phrase de depart', 'La premiere section commence',
  'Signalement deja', 'Mot de passe refuse', "d\\'eleves atteint", 'Quota superieur', 'Famille deja creee',
  'Le traitement a echoue', 'Annule par',
];

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((n) => {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) return n === 'node_modules' ? [] : sources(p);
    return p.endsWith('.ts') && !p.endsWith('.test.ts') ? [p] : [];
  });
}

describe('accents dans les messages visibles', () => {
  it('aucun message connu ne revient sans accent', () => {
    const found: string[] = [];
    for (const f of sources(join(__dirname))) {
      const txt = readFileSync(f, 'utf8');
      for (const bad of SANS_ACCENT) if (txt.includes(bad)) found.push(`${f}: ${bad}`);
    }
    expect(found).toEqual([]);
  });
});
