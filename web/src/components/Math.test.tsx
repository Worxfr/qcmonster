import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { Rich, renderMathml } from './Math';

describe('KaTeX en MathML', () => {
  it('produit du MathML sans style en ligne ni lien', () => {
    const h = renderMathml('\\frac{a}{b}', false)!;
    expect(h).toContain('<math');
    expect(h).not.toMatch(/style=|<a |href/);
  });
  it('\\href, \\url, \\htmlData ne produisent ni lien ni attribut (texte simple)', () => {
    for (const t of ['\\href{javascript:alert(1)}{x}', '\\url{javascript:alert(1)}', '\\htmlData{x=y}{z}']) {
      expect(renderMathml(t, false)).toBeNull();
      const { container, unmount } = render(<Rich text={`$${t}$`} />);
      expect(container.querySelector('a, [href], [data-x], math')).toBeNull();
      unmount();
    }
  });
  it('<script> dans une formule est échappé', () => {
    const { container } = render(<Rich text="$<script>alert(1)</script>$" />);
    expect(container.querySelector('script')).toBeNull();
    expect(container.textContent).toContain('script');
  });
  it('une formule invalide pour KaTeX s\'affiche en texte simple (chemin catch)', () => {
    expect(renderMathml('\\notacommand{x}', false)).toBeNull();
    const { container } = render(<Rich text="Voici $\notacommand{x}$ ici" />);
    expect(container.querySelector('math')).toBeNull();
    expect(container.querySelector('.math-fallback')?.textContent).toBe('\\notacommand{x}');
  });
  it('le HTML du texte reste du texte', () => {
    const { container } = render(<Rich text={'<img src=x onerror=alert(1)> $x$'} />);
    expect(container.querySelector('img')).toBeNull();
    expect(container.querySelector('math')).not.toBeNull();
  });
});
