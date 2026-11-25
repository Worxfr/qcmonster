import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { POLICY_VERSION } from '../../shared/policy';
import { BADGES, badgeLabel } from './game';
import { passwordProblem } from './screens/Activate';
import { MOCK_URL, startMock, stopMock } from './test/mock-server';

// Parcours des ecrans contre l'API simulee (Prism). Seuls l'envoi S3 et l'etat d'un job sont substitues:
// Prism renvoie des exemples fixes, donc l'etat "a_confirmer" ne peut pas venir du mock.
const realFetch = globalThis.fetch;
let uploads = 0;
let jobState: string | null = null;
let noFamily = false;
let noFamilyStatus = 404;
let progressBadges: string[] | null = null;
const calls: { url: string; method: string; auth: string | null; body: string | null }[] = [];
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
beforeAll(async () => {
  await startMock();
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.includes('s3.eu-west-3.amazonaws.com') && init?.method === 'POST') {
      uploads++;
      return new Response(null, { status: 204 });
    }
    if (jobState && /\/jobs\/[^/]+$/.test(url) && (!init || !init.method || init.method === 'GET')) {
      return new Response(JSON.stringify({ jobId: 'j1', state: jobState, pages: 1, createdAt: '2026-12-01T10:00:00Z', docId: 'd1' }), { status: 200, headers: { 'content-type': 'application/json' } });
    }
    const method = init?.method ?? 'GET';
    calls.push({ url, method, auth: new Headers(init?.headers).get('authorization'), body: typeof init?.body === 'string' ? init.body : null });
    if (noFamily && url.endsWith('/me') && method === 'GET') return json({ code: noFamilyStatus === 404 ? 'introuvable' : 'interdit', message: 'Pas de famille' }, noFamilyStatus);
    if (noFamily && url.endsWith('/family') && method === 'POST') {
      noFamily = false;
      return json({ userId: 'u1', role: 'parent', familyId: 'f1' }, 201);
    }
    if (progressBadges && url.endsWith('/me/progress')) {
      const r = await realFetch(input, init);
      return json({ ...(await r.json()), badges: progressBadges });
    }
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  stopMock();
});
beforeEach(() => {
  jobState = null;
  noFamily = false;
  noFamilyStatus = 404;
  progressBadges = null;
  calls.length = 0;
  uploads = 0;
  vi.stubGlobal('confirm', () => true);
});

async function a11y(container: HTMLElement) {
  const r = await axe.run(container, { rules: { 'color-contrast': { enabled: false }, region: { enabled: false } } });
  expect(r.violations.map((v) => `${v.id}: ${v.nodes.map((n) => n.html).join(' | ')}`)).toEqual([]);
}
const goTo = (path: string) => act(() => { window.location.hash = path; });
async function enter(role: 'eleve' | 'parent') {
  const user = userEvent.setup();
  const view = render(<App />);
  await user.click(await screen.findByRole('button', { name: role === 'eleve' ? /élève/i : /parent/i }));
  return { user, view };
}

describe('parcours eleve contre l\'API simulee', () => {
  it('connexion mock, accueil avec progression et fiches', async () => {
    const { view } = await enter('eleve');
    expect(await screen.findByText(/Niveau 2/)).toBeInTheDocument();
    expect(await screen.findByText('La Revolution francaise')).toBeInTheDocument();
    // l'exemple du contrat (110 XP au niveau 2) est sous le seuil 150: la barre est a 0, sans sortir de [0, 100]
    expect(screen.getByRole('progressbar', { name: /niveau suivant/i })).toHaveAttribute('aria-valuenow', '0');
    await a11y(view.container);
  });

  it('scan: envoi d\'une photo puis suivi du traitement', async () => {
    const { user, view } = await enter('eleve');
    await goTo('/scan');
    const input = await screen.findByLabelText(/Prendre ou choisir des photos/i);
    await user.upload(input, new File(['x'], 'cours.jpg', { type: 'image/jpeg' }));
    await user.click(screen.getByRole('button', { name: /Envoyer 1 page/ }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/job\//));
    expect(uploads).toBe(1);
    expect(await screen.findByRole('list', { name: /Étapes/ })).toBeInTheDocument();
    expect(screen.getByText('Lecture').closest('li')).toHaveAttribute('aria-current', 'step');
    await a11y(view.container);
  });

  it('refuse un fichier d\'un mauvais type sans appeler l\'API', async () => {
    const { view } = await enter('eleve');
    await goTo('/scan');
    const input = await screen.findByLabelText(/Prendre ou choisir des photos/i);
    await act(async () => {
      const f = new File(['x'], 'a.gif', { type: 'image/gif' });
      Object.defineProperty(input, 'files', { value: [f], configurable: true });
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(/JPEG ou PNG/);
    expect(uploads).toBe(0);
    await a11y(view.container);
  });

  it('confirmation: photo et texte cote a cote, puis reprise du workflow', async () => {
    jobState = 'a_confirmer';
    const { user, view } = await enter('eleve');
    await goTo('/job/j1');
    expect(await screen.findByRole('img', { name: /Photo de ta page 1/ })).toBeInTheDocument();
    const box = await screen.findByDisplayValue('La photosynthese produit du dioxygene.');
    fireEvent.change(box, { target: { value: `La photosynthese produit du dioxygene. ${'mot '.repeat(45)}` } });
    await user.selectOptions(screen.getByLabelText('Matière'), 'svt');
    await a11y(view.container);
    jobState = 'verification';
    await user.click(screen.getByRole('button', { name: /vérifie/i }));
    expect((await screen.findByText('Fiche')).closest('li')).toHaveAttribute('aria-current', 'step');
  });

  it('fiche: pastilles, sources cliquables, signalement', async () => {
    const { user, view } = await enter('eleve');
    await goTo('/doc/d1');
    expect(await screen.findByText('Vérifié')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: /Voir les sources/ }));
    const link = screen.getByRole('link', { name: /Photosynthese/ });
    expect(link).toHaveAttribute('href', 'https://fr.wikipedia.org/wiki/Photosynth%C3%A8se');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await a11y(view.container);
    await user.click(screen.getByRole('button', { name: /Signaler/ }));
    await user.type(screen.getByLabelText(/Qu'est-ce qui est faux/), 'La date est fausse.');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(await screen.findByText(/Merci/)).toBeInTheDocument();
  });

  it('quiz: QCM puis texte a trous, XP affiches', async () => {
    const { user, view } = await enter('eleve');
    await goTo('/quiz/d1');
    expect(await screen.findByText(/Que produit la photosynthese/)).toBeInTheDocument();
    await a11y(view.container);
    await user.click(screen.getByRole('button', { name: 'Du dioxygene' }));
    expect(await screen.findByText(/Bravo/)).toBeInTheDocument();
    expect(screen.getByText(/\+10 XP/)).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Suivant' }));
    await user.type(await screen.findByLabelText('Ta réponse'), 'dioxygene');
    await user.click(screen.getByRole('button', { name: 'Valider' }));
    await user.click(await screen.findByRole('button', { name: 'Terminer' }));
    expect(await screen.findByText(/sur 2, \+20 XP/)).toBeInTheDocument();
  });

  it('jeu: stades, badges, classement', async () => {
    const { view } = await enter('eleve');
    await goTo('/jeu');
    expect(await screen.findByText('Les stades du monstre')).toBeInTheDocument();
    expect(await screen.findByText('Lila-7k2f')).toBeInTheDocument();
    expect(screen.getByText('310 XP')).toBeInTheDocument();
    expect(screen.getByText(/dès que tu gagnes 30 XP/)).toBeInTheDocument(); // B4: règle de la série expliquée (docs/game-rules.md §3)
    expect(screen.getByRole('heading', { name: /Mes badges/ })).toBeInTheDocument();
    await a11y(view.container);
  });

  it('jeu: badges obtenus (Progress.badges) avec libelles lisibles, les autres verrouilles', async () => {
    progressBadges = ['premier_scan', 'serie_7', 'badge_inconnu'];
    const { view } = await enter('eleve');
    await goTo('/jeu');
    expect(await screen.findByRole('heading', { name: 'Mes badges (3)' })).toBeInTheDocument();
    expect(screen.getByText('Premier scan')).toBeInTheDocument();
    expect(screen.getByText('Série de 7 jours')).toBeInTheDocument();
    expect(screen.getByText('badge inconnu')).toBeInTheDocument();
    expect(screen.getByText(/Maître des maths/)).toBeInTheDocument();
    await a11y(view.container);
  });

  it('fiche lue: envoie POST /docs/{id}/read et affiche les XP', async () => {
    const { user } = await enter('eleve');
    await goTo('/doc/d1');
    await user.click(await screen.findByRole('button', { name: /J'ai tout lu/ }));
    expect(await screen.findByText(/Bien lu ! \+10 XP/)).toBeInTheDocument();
    expect(calls.some((c) => c.method === 'POST' && c.url.endsWith('/docs/d1/read'))).toBe(true);
  });
});

describe('parcours parent', () => {
  it('tableau de bord, quotas et invitation d\'un eleve', async () => {
    const { user, view } = await enter('parent');
    expect(await screen.findByText(/12 pages utilisées sur 50/)).toBeInTheDocument();
    const list = await screen.findByRole('heading', { name: /Lila-7k2f/ });
    expect(list).toBeInTheDocument();
    await a11y(view.container);
    const submit = screen.getByRole('button', { name: /Créer et obtenir le lien/ });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText(/Pseudo \(sans nom de famille\)/), 'Lila');
    await user.click(screen.getByLabelText(/autorité parentale/));
    expect(submit).toBeEnabled();
    await user.click(submit);
    const sent = JSON.parse(calls.filter((x) => x.method === 'POST' && x.url.endsWith('/students')).at(-1)?.body ?? '{}');
    expect(sent).toMatchObject({ parentalAuthority: true, policyVersion: POLICY_VERSION });
    const box = await screen.findByLabelText("Lien d'activation");
    expect(box).toHaveValue('https://app.example.invalid/activer#token=example');
  });

  it('B2: un quota au-dessus du plafond de la famille affiche un message et n\'envoie rien', async () => {
    const { user } = await enter('parent');
    const input = await screen.findByLabelText(/Quota mensuel/);
    const before = calls.length;
    await user.clear(input);
    await user.type(input, '9999');
    await user.tab();
    expect(await screen.findByText(/entre 0 et 50/)).toBeInTheDocument();
    expect(calls.slice(before).filter((x) => x.method === 'PATCH')).toEqual([]);
  });
});

describe('activation et famille', () => {
  const TOKEN = 'jeton-de-test-a-usage-unique-0123456789';
  it('activation: jeton retire de l\'URL, mot de passe choisi, appel public sans Authorization', async () => {
    window.history.replaceState(null, '', `/activer#token=${TOKEN}`);
    const user = userEvent.setup();
    const view = render(<App />);
    expect(window.location.hash).toBe('');
    expect(window.location.pathname).toBe('/activer');
    const submit = screen.getByRole('button', { name: 'Activer mon compte' });
    expect(submit).toBeDisabled();
    await user.type(screen.getByLabelText('Mot de passe'), 'court');
    expect(screen.getByText('Au moins 12 caractères.')).toBeInTheDocument();
    await user.clear(screen.getByLabelText('Mot de passe'));
    await user.type(screen.getByLabelText('Mot de passe'), 'Un-mot-de-passe-long-1');
    await user.type(screen.getByLabelText(/encore une fois/), 'Un-mot-de-passe-long-2');
    expect(screen.getByText(/pas les mêmes/)).toBeInTheDocument();
    expect(submit).toBeDisabled();
    await user.clear(screen.getByLabelText(/encore une fois/));
    await user.type(screen.getByLabelText(/encore une fois/), 'Un-mot-de-passe-long-1');
    await a11y(view.container);
    await user.click(submit);
    expect(await screen.findByText(/Ton compte est activé/)).toBeInTheDocument();
    const c = calls.find((x) => x.url.endsWith('/activation'));
    expect(c?.method).toBe('POST');
    expect(c?.auth).toBeNull();
    expect(JSON.parse(c!.body!)).toEqual({ token: TOKEN, password: 'Un-mot-de-passe-long-1' });
    // le jeton n'est ni dans l'URL ni dans un stockage
    expect(window.location.href).not.toContain(TOKEN);
    expect(JSON.stringify({ ...sessionStorage, ...localStorage })).not.toContain(TOKEN);
    await user.click(screen.getByRole('button', { name: /connexion/ }));
    expect(await screen.findByRole('button', { name: /élève/i })).toBeInTheDocument();
    expect(window.location.pathname).toBe('/');
  });

  it('activation: jeton trop court = lien incomplet, aucun appel', async () => {
    window.history.replaceState(null, '', '/activer#token=court');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplet/);
    expect(calls.some((x) => x.url.endsWith('/activation'))).toBe(false);
    await user.click(screen.getByRole('button', { name: /connexion/ }));
  });

  it('activation: lien sans jeton, aucun appel', async () => {
    window.history.replaceState(null, '', '/activer');
    const user = userEvent.setup();
    render(<App />);
    expect(await screen.findByRole('alert')).toHaveTextContent(/incomplet/);
    expect(calls.some((x) => x.url.endsWith('/activation'))).toBe(false);
    await user.click(screen.getByRole('button', { name: /connexion/ }));
  });

  it('parent invite sans famille: crée la famille puis charge le tableau de bord', async () => {
    noFamily = true;
    const { user } = await enter('parent');
    const create = await screen.findByRole('button', { name: 'Créer ma famille' });
    expect(create).toBeDisabled(); // pas de création sans la case de consentement
    await user.click(screen.getByLabelText(/J'ai lu la politique de confidentialité/));
    await user.click(create);
    expect(await screen.findByText(/pages utilisées sur 50/)).toBeInTheDocument();
    const posts = calls.filter((x) => x.method === 'POST' && x.url.endsWith('/family'));
    expect(posts).toHaveLength(1);
    expect(JSON.parse(posts[0].body ?? '{}')).toEqual({ consent: true, policyVersion: POLICY_VERSION });
  });
});

describe('famille: cas limites', () => {
  it('403 sur /me: erreur affichee, pas d\'ecran de creation', async () => {
    noFamily = true;
    noFamilyStatus = 403;
    await enter('parent');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Pas de famille/);
    expect(screen.queryByRole('button', { name: 'Créer ma famille' })).toBeNull();
  });
});

describe('catalogue de badges', () => {
  it('libelles lisibles, repli sur l\'identifiant', () => {
    expect(badgeLabel('chasseur_d_erreurs')).toBe("Chasseur d'erreurs");
    expect(badgeLabel('nouveau_truc')).toBe('nouveau truc');
    expect(BADGES.every((b) => b.hint !== b.label)).toBe(true);
    expect(BADGES.map((b) => b.id)).toContain('maitre_histoire_geo');
  });
  it('regle du mot de passe', () => {
    expect(passwordProblem('abc')).not.toBeNull();
    expect(passwordProblem('toutenminuscules1')).not.toBeNull();
    expect(passwordProblem('Un-mot-de-passe-long-1')).toBeNull();
  });
});

describe('donnees du front', () => {
  it('aucune reponse correcte dans la session avant de repondre', async () => {
    const r = await realFetch(`${MOCK_URL}/docs/d1/session`, { headers: { authorization: 'Bearer x' } });
    const text = JSON.stringify(await r.json());
    expect(text).not.toMatch(/correctAnswer|"answer"|"solution"|"correct"/);
  });
});

describe('configuration', () => {
  it('jamais de mock par defaut: sans variable explicite, MOCK_AUTH est faux', async () => {
    vi.resetModules();
    vi.stubEnv('VITE_AUTH_MODE', '');
    const env = await import('./env');
    expect(env.MOCK_AUTH).toBe(false);
    expect(env.CONFIG_ERROR).toMatch(/COGNITO/);
    vi.unstubAllEnvs();
  });
});
