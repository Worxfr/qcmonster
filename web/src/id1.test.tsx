import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { leaveActivation } from './activation';

// ID1: activation avec surnom, identifiant visible (profil, parent). API simulee par un routeur local.
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | undefined> = {};
const TOKEN = 'jeton-de-test-a-usage-unique-0123456789';
const PW = 'Un-mot-de-passe-long-1';
const PROGRESS = { xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 12, pagesLimit: 30, resetDate: '2026-12-01' };
const student = { studentId: 's1', pseudo: 'lila-7k2fm', loginId: 'lila-7k2fm', displayName: 'Lila', schoolLevel: 'seconde', under15: false, status: 'actif', pageQuota: 20 };

beforeEach(() => {
  calls = [];
  routes = {};
  sessionStorage.clear();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const c = { url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body };
    calls.push(c);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const r = routes[`${method} ${path}`]?.(c);
    if (r) return r;
    if (path === '/me') return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'lila-7k2fm', loginId: 'lila-7k2fm', displayName: 'Lila' });
    if (path === '/me/progress') return json(PROGRESS);
    if (path === '/family/dashboard') return json({ students: [{ student, progress: PROGRESS }], familyPagesRemaining: 40, familyPagesLimit: 50 });
    if (path === '/family/leaderboard') return json({ week: '2026-W49', entries: [] });
    if (path.startsWith('/scans')) return json({ items: [], inProgress: 0, toReview: 0, facets: { subjects: [], topics: [] } });
    if (path.startsWith('/folders')) return json({ items: [] });
    return json({ code: 'introuvable', message: 'Introuvable' }, 404);
  });
});
afterEach(() => {
  leaveActivation(); // le jeton pris reste en memoire du module: on le libere entre les tests
  vi.unstubAllGlobals();
});

async function a11y(el: HTMLElement) {
  const r = await axe.run(el, { rules: { 'color-contrast': { enabled: false } } });
  expect(r.violations.map((v) => v.id)).toEqual([]);
}
async function fillActivation(user: ReturnType<typeof userEvent.setup>, nick?: string) {
  if (nick) await user.type(screen.getByLabelText('Ton surnom'), nick);
  await user.type(screen.getByLabelText('Mot de passe'), PW);
  await user.type(screen.getByLabelText(/encore une fois/), PW);
}
const activation = () => {
  window.history.replaceState(null, '', `/activer#token=${TOKEN}`);
  return render(<App />);
};

describe('ID1: activation', () => {
  it('surnom choisi: envoye avec le mot de passe, identifiant affiche en gros avec « Copier », jamais dans l\'URL ni le stockage', async () => {
    routes['POST /activation'] = () => json({ loginId: 'lila-7k2fm', displayName: 'Lila Rose' });
    const user = userEvent.setup();
    const view = activation();
    expect(screen.getByLabelText('Ton surnom')).toBeInTheDocument();
    expect(screen.getByText(/Pas ton nom de famille, ni ton école, ni ta date de naissance/)).toBeInTheDocument();
    await fillActivation(user, 'Lila Rose');
    await a11y(view.container);
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    expect(await screen.findByTestId('login-id')).toHaveTextContent('lila-7k2fm');
    expect(screen.getByRole('button', { name: /Copier/ })).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/activation'))?.body).toEqual({ token: TOKEN, password: PW, displayName: 'Lila Rose' });
    expect(window.location.href).not.toContain('lila-7k2fm');
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain('lila-7k2fm');
    await a11y(view.container);
  });
  it('sans surnom saisi, aucun displayName n\'est envoye (on garde celui du parent)', async () => {
    routes['POST /activation'] = () => json({ loginId: 'lila-7k2fm', displayName: 'Lila' });
    const user = userEvent.setup();
    activation();
    await fillActivation(user);
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    await screen.findByTestId('login-id');
    expect(calls.find((c) => c.url.endsWith('/activation'))?.body).toEqual({ token: TOKEN, password: PW });
  });
  it('surnom refuse (400 pseudo_refuse): message neutre pres du champ, le formulaire reste actif et le lien reste utilisable', async () => {
    let n = 0;
    routes['POST /activation'] = () => (n++ === 0 ? json({ code: 'pseudo_refuse', message: 'x' }, 400) : json({ loginId: 'lila-7k2fm', displayName: 'Zoe' }));
    const user = userEvent.setup();
    activation();
    await fillActivation(user, 'Zoe');
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    const alert = await screen.findByText("Ce surnom n'est pas possible, essaie-en un autre.");
    expect(alert).toHaveAttribute('role', 'alert');
    expect(screen.queryByText(/Vérifie ton mot de passe/)).toBeNull(); // pas confondu avec un mot de passe refuse
    expect(screen.getByRole('button', { name: 'Activer mon compte' })).toBeEnabled();
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    expect(await screen.findByTestId('login-id')).toBeInTheDocument();
  });
  it('surnom deja pris (409 pseudo_pris): message pres du champ', async () => {
    routes['POST /activation'] = () => json({ code: 'pseudo_pris', message: 'x' }, 409);
    const user = userEvent.setup();
    activation();
    await fillActivation(user, 'Zoe');
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    expect(await screen.findByText(/déjà pris dans ta famille/)).toBeInTheDocument();
  });
  it('400 sans code: toujours le message sur le mot de passe', async () => {
    routes['POST /activation'] = () => json({ code: 'requete_invalide', message: 'x' }, 400);
    const user = userEvent.setup();
    activation();
    await fillActivation(user, 'Zoe');
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    expect(await screen.findByText(/Vérifie ton mot de passe/)).toBeInTheDocument();
  });
  it('forme du surnom verifiee en direct; la liste de mots n\'est jamais consultee ici', async () => {
    const user = userEvent.setup();
    activation();
    await user.type(screen.getByLabelText('Ton surnom'), 'Lila2012');
    expect(screen.getByText(/2 à 20 caractères/)).toBeInTheDocument();
    expect(screen.getByLabelText('Ton surnom')).toHaveAttribute('aria-invalid', 'true');
    await user.clear(screen.getByLabelText('Ton surnom'));
    await user.type(screen.getByLabelText('Ton surnom'), 'Porn');
    expect(screen.getByLabelText('Ton surnom')).toHaveAttribute('aria-invalid', 'false'); // seul le serveur refuse un mot
  });
  it('surnom devenu indisponible: l\'ecran le dit avec le nom donne', async () => {
    routes['POST /activation'] = () => json({ loginId: 'lila-7k2fm', displayName: 'Lila', displayNameChanged: true });
    const user = userEvent.setup();
    activation();
    await fillActivation(user, 'Kim');
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    expect(await screen.findByText(/Ton surnom était déjà pris/)).toBeInTheDocument();
    expect(screen.getByText('Lila', { selector: 'strong' })).toBeInTheDocument();
  });
  it('nouveau site contre ancienne API (204 sans corps): pas de « undefined », on renvoie au parent', async () => {
    routes['POST /activation'] = () => new Response(null, { status: 204 });
    const user = userEvent.setup();
    activation();
    await fillActivation(user, 'Lila');
    await user.click(screen.getByRole('button', { name: 'Activer mon compte' }));
    expect(await screen.findByText(/Demande ton identifiant à ton parent/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('undefined');
    expect(screen.queryByTestId('login-id')).toBeNull();
  });
});

describe('ID1: profil de l\'eleve', () => {
  it('accueil: « Salut » avec le surnom; « Mon profil » montre le surnom et l\'identifiant, en lecture seule', async () => {
    sessionStorage.setItem('qcm.mockRole', 'eleve');
    window.location.hash = '/';
    const view = render(<App />);
    expect(await screen.findByRole('heading', { name: 'Salut Lila !' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('lila-7k2fm');
    await userEvent.setup().click(screen.getByRole('link', { name: 'Mon profil' }));
    expect(await screen.findByTestId('login-id')).toHaveTextContent('lila-7k2fm');
    expect(screen.getByText('Lila', { selector: 'strong' })).toBeInTheDocument();
    expect(screen.queryByRole('textbox')).toBeNull();
    await a11y(view.container);
  });
});

describe('ID1: espace parent', () => {
  const enter = async () => {
    sessionStorage.setItem('qcm.mockRole', 'parent');
    window.location.hash = '/';
    routes['GET /me'] = () => json({ userId: 'u1', role: 'parent', familyId: 'f1' });
    const view = render(<App />);
    await screen.findByRole('heading', { name: /Lila/ });
    return view;
  };
  it('la liste montre le surnom, et l\'identifiant en petit', async () => {
    const view = await enter();
    expect(screen.getByTestId('login-s1')).toHaveTextContent('lila-7k2fm');
    expect(screen.getByRole('link', { name: /Suivi de Lila/ })).toBeInTheDocument();
    await a11y(view.container);
  });
  it('« Changer le surnom » envoie displayName; un 409 affiche le message', async () => {
    let n = 0;
    routes['PATCH /students/s1'] = () => (n++ === 0 ? json({ code: 'pseudo_pris', message: 'Ce surnom est déjà pris dans ta famille, essaie-en un autre' }, 409) : json({ ...student, displayName: 'Lilou' }));
    const user = userEvent.setup();
    await enter();
    await user.click(screen.getByRole('button', { name: 'Changer le surnom' }));
    const input = screen.getByLabelText(/Nouveau surnom pour Lila/);
    await user.clear(input);
    await user.type(input, 'Lilou');
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    const msg = await screen.findByText(/déjà pris dans ta famille/);
    expect(msg).toHaveAttribute('role', 'alert');
    expect(msg.closest('form')).not.toBeNull(); // m5: l'erreur est dans le formulaire de renommage, pres du champ
    expect(calls.filter((c) => c.method === 'PATCH').at(-1)?.body).toEqual({ displayName: 'Lilou' });
    await user.click(screen.getByRole('button', { name: 'Enregistrer' }));
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Enregistrer' })).toBeNull());
  });
  it('« Nouvel identifiant de connexion » demande confirmation, puis montre le nouvel identifiant', async () => {
    let release: (r: Response) => void = () => undefined;
    const pending = new Promise<Response>((res) => { release = res; });
    const real = globalThis.fetch;
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => (String(input).endsWith('/students/s1/login-id') ? (calls.push({ url: String(input), method: init?.method ?? 'GET', body: undefined }), pending) : real(input, init)));
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    const user = userEvent.setup();
    await enter();
    await user.click(screen.getByRole('button', { name: 'Nouvel identifiant de connexion' }));
    expect(calls.some((c) => c.url.endsWith('/login-id'))).toBe(false); // refus: rien n'est envoye
    await user.click(screen.getByRole('button', { name: 'Nouvel identifiant de connexion' }));
    // m2: pendant l'appel le bouton est desactive, un second clic n'envoie rien
    const busy = await screen.findByRole('button', { name: 'Un instant…' });
    expect(busy).toBeDisabled();
    await user.click(busy);
    expect(calls.filter((c) => c.url.endsWith('/login-id'))).toHaveLength(1);
    release(json({ loginId: 'lila-m4kx7' }));
    expect(await screen.findByTestId('login-id')).toHaveTextContent('lila-m4kx7');
    expect(confirm.mock.calls[0][0]).toMatch(/mot de passe reste le même/);
  });
  it('creation: le surnom de depart est guide, la carte du lien montre l\'identifiant qui sera cree', async () => {
    routes['POST /students'] = () => json({ student: { ...student, studentId: 's2' }, activationLink: { url: 'https://app.example.invalid/activer#token=example', expiresAt: '2026-12-02T10:00:00Z' } }, 201);
    const user = userEvent.setup();
    await enter();
    expect(screen.getByLabelText(/Surnom de départ \(l'élève pourra en choisir un autre\)/)).toBeInTheDocument();
    await user.type(screen.getByLabelText(/Surnom de départ/), 'Lila');
    await user.click(screen.getByLabelText(/autorité parentale/));
    await user.click(screen.getByRole('button', { name: /Créer et obtenir le lien/ }));
    expect(await screen.findByLabelText("Lien d'activation")).toBeInTheDocument();
    expect(screen.getAllByTestId('login-id')[0]).toHaveTextContent('lila-7k2fm');
  });
});
