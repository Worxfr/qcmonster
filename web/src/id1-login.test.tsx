import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ID1: ecran de connexion hors mode simule; seul signIn est remplace pour lire ce qui est envoye a Cognito.
vi.mock('./env', () => ({ MOCK_AUTH: false, CONFIG_ERROR: null, COGNITO_POOL_ID: 'eu-west-3_x', COGNITO_CLIENT_ID: 'web', COGNITO_SIGNUP_CLIENT_ID: '', SIGNUP_ENABLED: false, API_URL: 'http://x.invalid' }));
const signIn = vi.fn(async (..._a: unknown[]) => ({ kind: 'ok' as const }));
vi.mock('./auth', () => ({ signIn: (...a: unknown[]) => signIn(...a), mockSignIn: vi.fn(), mockAdminSignIn: vi.fn() }));
const { Login } = await import('./screens/Login');
const { normalizeLoginInput } = await import('./loginId');
const { rememberLoginId } = await import('./activation');

beforeEach(() => signIn.mockClear());

describe('ID1: connexion', () => {
  it('le champ identifiant coupe la majuscule automatique, la correction et le correcteur', () => {
    render(<Login onDone={() => undefined} />);
    const f = screen.getByLabelText(/Identifiant ou e-mail/);
    expect(f).toHaveAttribute('autocapitalize', 'none');
    expect(f).toHaveAttribute('autocorrect', 'off');
    expect(f).toHaveAttribute('spellcheck', 'false');
    expect(screen.getByText(/ressemble à lila-7k2fm/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/Pseudo/)).toBeNull();
  });
  it('une saisie au format neuf est envoyee en minuscules, espaces retires; un ancien identifiant tel quel; un e-mail tel quel', async () => {
    const user = userEvent.setup();
    const { unmount } = render(<Login onDone={() => undefined} />);
    await user.type(screen.getByLabelText(/Identifiant ou e-mail/), '  Lila-7K2FM ');
    await user.type(screen.getByLabelText('Mot de passe'), 'Un-mot-de-passe-long-1');
    await user.click(screen.getByRole('button', { name: 'Se connecter' }));
    expect(signIn).toHaveBeenLastCalledWith('lila-7k2fm', 'Un-mot-de-passe-long-1');
    unmount();
    expect(normalizeLoginInput('Lila-7k2f')).toBe('Lila-7k2f'); // ancien format (suffixe de 4): le pool distingue probablement les majuscules
    expect(normalizeLoginInput(' Marie-Rose-7K2FM')).toBe('marie-rose-7k2fm');
    expect(normalizeLoginInput('Parent@Example.invalid')).toBe('Parent@Example.invalid');
    expect(normalizeLoginInput('Lila-70K2F')).toBe('Lila-70K2F'); // 0 n'existe pas dans l'alphabet: pas un identifiant neuf
  });
  it('apres une activation, l\'identifiant est pre-rempli (memoire de la session, une seule fois)', () => {
    rememberLoginId('lila-7k2fm');
    const a = render(<Login onDone={() => undefined} />);
    expect(screen.getByLabelText(/Identifiant ou e-mail/)).toHaveValue('lila-7k2fm');
    a.unmount();
    render(<Login onDone={() => undefined} />);
    expect(screen.getByLabelText(/Identifiant ou e-mail/)).toHaveValue('');
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('lila-7k2fm');
    expect(window.location.href).not.toContain('lila-7k2fm');
  });
});
