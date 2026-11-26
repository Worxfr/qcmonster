import { render } from '@testing-library/react';
import katex from 'katex';
import { describe, expect, it, vi } from 'vitest';
import { Rich, renderMathml } from './Math';

describe('options de KaTeX (la barrière est trust: false, pas le filtre)', () => {
  it('chaque rendu passe trust: false, throwOnError: true, output mathml, maxSize et maxExpand', () => {
    const spy = vi.spyOn(katex, 'renderToString');
    renderMathml('x^2', false);
    renderMathml('\\frac{a}{b}', true);
    expect(spy).toHaveBeenCalledTimes(2);
    for (const [, opts] of spy.mock.calls) expect(opts).toMatchObject({ trust: false, throwOnError: true, output: 'mathml', maxSize: 10, maxExpand: 1000, strict: 'ignore' });
    spy.mockRestore();
  });
  it('si le filtre était contourné, KaTeX seul (trust: false) n’écrit ni lien, ni image, ni attribut: la commande reste du texte', () => {
    const spy = vi.spyOn(katex, 'renderToString');
    renderMathml('x', false);
    const opts = spy.mock.calls[0][1] as katex.KatexOptions;
    spy.mockRestore();
    for (const t of ['\\href{javascript:alert(1)}{x}', '\\url{https://exemple.invalide}', '\\htmlData{a=b}{x}', '\\includegraphics{x.png}']) {
      const out = katex.renderToString(t, opts);
      expect(out, t).not.toMatch(/<a[\s>]|href=|src=|data-|style=|<img|<script/);
      expect(out, t).toContain('<mtext>'); // la commande non permise est affichée telle quelle
    }
  });
});

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
  it('µ, π, Ω et x² sont marqués pour la police KaTeX (pas de carré vide)', () => {
    const h = renderMathml('\\mu \\pi \\Omega x^2 y', false)!;
    expect(h).toContain('<mi class="mi-i">μ</mi>');
    expect(h).toContain('<mi class="mi-i">π</mi>');
    expect(h).toContain('<mi class="mi-i">x</mi>');
    expect(h).toContain('Ω');
    expect(renderMathml('\\sin x', false)).toContain('<mi>sin</mi>'); // plusieurs lettres: inchangé
    expect(h).not.toMatch(/style=/);
  });
});
