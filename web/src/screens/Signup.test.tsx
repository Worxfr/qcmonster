import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { describe, expect, it } from 'vitest';
import { App } from '../App';

// Parcours d'inscription en mode simule (VITE_AUTH_MODE=mock, ignore en build de production). Le code de confirmation simule est 123456.
const INVITE = 'a'.repeat(32);
async function fillForm(user: ReturnType<typeof userEvent.setup>, invite = INVITE) {
  await user.type(await screen.findByLabelText('Ton e-mail'), 'parent@example.org');
  await user.type(screen.getByLabelText('Mot de passe'), 'Motdepasse12');
  await user.type(screen.getByLabelText("Code d'invitation"), invite);
}

describe('inscription parent (mock)', () => {
  it('formulaire, code reçu par e-mail, connexion automatique puis « Créer ma famille »', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/inscription';
    const { container } = render(<App />);
    await fillForm(user);
    const submit = screen.getByRole('button', { name: 'Créer mon compte' });
    expect(submit).toBeDisabled(); // consentement requis
    expect(screen.getByRole('link', { name: /politique de confidentialité/i })).toHaveAttribute('href', '#/politique');
    await user.click(screen.getByRole('checkbox', { name: /politique/i }));
    const axeRes = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
    expect(axeRes.violations).toEqual([]);
    await user.click(submit);

    await user.type(await screen.findByLabelText('Code reçu par e-mail'), '000000');
    await user.click(screen.getByRole('button', { name: 'Valider mon compte' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Code incorrect ou expiré.');
    await user.clear(screen.getByLabelText('Code reçu par e-mail'));
    await user.type(screen.getByLabelText('Code reçu par e-mail'), '123456');
    await user.click(screen.getByRole('button', { name: 'Valider mon compte' }));
    await waitFor(() => expect(sessionStorage.getItem('qcm.mockRole')).toBe('parent'));
    expect(sessionStorage.getItem('qcm.pendingSignup')).toBeNull();
  });

  it("signale un mot de passe trop court puis accepte un mot de passe valable", async () => {
    const user = userEvent.setup();
    window.location.hash = '#/inscription';
    render(<App />);
    await user.type(await screen.findByLabelText('Ton e-mail'), 'parent@example.org');
    await user.type(screen.getByLabelText('Mot de passe'), 'court');
    expect(screen.getByText('Au moins 12 caractères.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Mot de passe'));
    await user.type(screen.getByLabelText('Mot de passe'), 'Motdepasse12');
    await user.type(screen.getByLabelText("Code d'invitation"), INVITE);
    await user.click(screen.getByRole('checkbox', { name: /politique/i }));
    expect(screen.getByRole('button', { name: 'Créer mon compte' })).toBeEnabled();
  });

  it("dit seulement « invalide ou expiré » pour un code d'invitation refusé", async () => {
    const user = userEvent.setup();
    window.location.hash = '#/inscription';
    render(<App />);
    await fillForm(user, 'invalide-' + 'z'.repeat(12));
    await user.click(screen.getByRole('checkbox', { name: /politique/i }));
    await user.click(screen.getByRole('button', { name: 'Créer mon compte' }));
    expect(await screen.findByRole('alert')).toHaveTextContent("Code d'invitation invalide ou expiré.");
  });

  it('mot de passe oublié: même écran que le compte existe ou non, puis nouveau mot de passe', async () => {
    const user = userEvent.setup();
    window.location.hash = '#/mot-de-passe-oublie';
    render(<App />);
    await user.type(await screen.findByLabelText('Ton e-mail'), 'inconnu@example.org');
    await user.click(screen.getByRole('button', { name: 'Recevoir un code' }));
    await user.type(await screen.findByLabelText('Code reçu par e-mail'), '123456');
    await user.type(screen.getByLabelText('Nouveau mot de passe'), 'AutreMotdepasse1');
    await user.click(screen.getByRole('button', { name: 'Changer mon mot de passe' }));
    expect(await screen.findByText(/Ton mot de passe est changé/)).toBeInTheDocument();
  });

  it("l'écran de connexion propose l'inscription", async () => {
    render(<App />);
    expect(await screen.findByRole('link', { name: 'Créer un compte parent' })).toHaveAttribute('href', '#/inscription');
  });
});
