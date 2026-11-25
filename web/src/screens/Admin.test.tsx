import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

// Page #/admin en mode simule. La securite vient du serveur: ici on verifie l'affichage et l'appel.
const CODE = '0123456789abcdef0123456789abcdef';
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const signIn = (admin: boolean) => {
  sessionStorage.setItem('qcm.mockRole', 'parent');
  if (admin) sessionStorage.setItem('qcm.mockAdmin', '1');
  window.location.hash = '#/admin';
};

describe('page Invitations (#/admin)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('administrateur: génère un code, l\'affiche une fois avec le rappel, le copie', async () => {
    const user = userEvent.setup();
    const calls: { url: string; method: string; body: unknown }[] = [];
    vi.stubGlobal('fetch', async (url: string, init?: RequestInit) => {
      calls.push({ url, method: init?.method ?? 'GET', body: init?.body });
      return json({ code: CODE, createdAt: '2026-12-01T09:00:00.000Z', remainingToday: 19 }, 201);
    });
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    signIn(true);
    const { container } = render(<App />);
    const gen = await screen.findByRole('button', { name: 'Générer un code' });
    expect(screen.queryByTestId('invite-code')).toBeNull();
    await user.click(gen);
    expect(await screen.findByTestId('invite-code')).toHaveTextContent(CODE);
    expect(screen.getByRole('status')).toHaveTextContent(/une seule fois/);
    expect(screen.getByRole('status')).toHaveTextContent(/plus affiché/);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ method: 'POST', body: undefined });
    expect(calls[0].url).toMatch(/\/admin\/invitations$/);
    await user.click(screen.getByRole('button', { name: 'Copier le code' }));
    expect(writeText).toHaveBeenCalledWith(CODE);
    expect(await screen.findByRole('button', { name: 'Copié ✔' })).toBeInTheDocument();
    const res = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(res.violations).toEqual([]);
    // Le code n'est jamais conserve dans le navigateur.
    expect(JSON.stringify({ ...sessionStorage })).not.toContain(CODE);
    expect(JSON.stringify({ ...localStorage })).not.toContain(CODE);
  });

  it('limite quotidienne (429): message clair, aucun code affiché', async () => {
    const user = userEvent.setup();
    vi.stubGlobal('fetch', async () => json({ code: 'quota_epuise', message: 'Limite' }, 429));
    signIn(true);
    render(<App />);
    await user.click(await screen.findByRole('button', { name: 'Générer un code' }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/limite/i);
    expect(screen.queryByTestId('invite-code')).toBeNull();
  });

  it('non administrateur: page introuvable, aucun bouton, aucun appel', async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    signIn(false);
    render(<App />);
    expect(await screen.findByText('Cette page n\'existe pas.')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Générer un code' })).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
