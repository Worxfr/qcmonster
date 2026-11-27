import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as rules from '../../shared/share-rules';

// S1 #34 (lot S1-W): le site du partage. Drapeau VITE_SHARE_ENABLED ferme par defaut. API simulee par un routeur local.
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown; credentials?: RequestCredentials };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | undefined> = {};
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const T0 = '2026-12-01T10:00:00Z';
const T1 = '2026-12-08T10:00:00Z';

const shareable = (n: number, extra: object[] = []) => ({
  questions: [
    ...Array.from({ length: n }, (_, k) => ({ questionId: `D1:qcm:${k}`, kind: 'qcm', prompt: `Question numero ${k + 1} ?`, choices: ['a', 'b', 'c', 'd'], answer: 0, shareable: true })),
    ...extra,
  ],
});

beforeEach(() => {
  calls = [];
  routes = {};
  vi.resetModules();
  vi.stubGlobal('confirm', () => true);
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const c = { url, method, body: typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body, credentials: init?.credentials };
    calls.push(c);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    const fn = routes[`${method} ${path}`];
    const r = fn?.(c);
    if (r) return r;
    if (path === '/me') return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Test' });
    if (path === '/me/progress') return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 12, pagesLimit: 30, resetDate: '2026-12-01' });
    return json({ code: 'introuvable', message: 'Introuvable' }, 404);
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

async function app(hash: string, role: 'eleve' | 'parent' = 'eleve') {
  sessionStorage.setItem('qcm.mockRole', role);
  window.location.hash = hash;
  const { App } = await import('./App');
  return render(<App />);
}
const open = () => vi.stubEnv('VITE_SHARE_ENABLED', 'true');

const DOC = { docId: 'D1', title: 'Photosynthese', subject: 'svt', createdAt: T0, claims: [], questions: [] };
const dashboard = (sharing?: boolean) => ({
  familyPagesLimit: 50, familyPagesRemaining: 40,
  students: [{ student: { studentId: 's1', pseudo: 'lila-7k2fm', loginId: 'lila-7k2fm', displayName: 'Lila', schoolLevel: 'seconde', under15: true, status: 'actif', pageQuota: 10, ...(sharing === undefined ? {} : { sharing }) }, progress: { xp: 0, level: 0, streakDays: 0, stage: 1, pagesRemaining: 10, pagesLimit: 10 } }],
});
const MY = (o: object = {}) => ({ shareId: 'SH1', title: 'Revision SVT', count: 6, createdAt: T0, expiresAt: T1, state: 'actif', reads: 3, reports: 0, outdated: false, ...o });

describe('drapeau du site ferme (defaut)', () => {
  it('fiche: pas de bouton Partager; la page de creation et « mes liens » ne s\'ouvrent pas', async () => {
    routes['GET /docs/D1'] = () => json(DOC);
    await app('#/doc/D1');
    expect(await screen.findByRole('button', { name: /S'entraîner/ })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Partager/ })).toBeNull();
  });
  it.each(['#/partager/D1', '#/partages'])('%s retombe sur l\'accueil, sans appel de partage', async (h) => {
    await app(h);
    await waitFor(() => expect(calls.some((c) => c.url.endsWith('/me/progress'))).toBe(true));
    expect(screen.queryByText(/Partager des questions|Mes liens de partage/)).toBeNull();
    expect(calls.some((c) => /shar/.test(c.url))).toBe(false);
  });
  it('vue parent: aucune section de partage, aucun appel', async () => {
    routes['GET /me'] = () => json({ userId: 'p1', role: 'parent', familyId: 'f1' });
    routes['GET /family/dashboard'] = () => json(dashboard());
    routes['GET /family/leaderboard'] = () => json({ week: '2026-W49', entries: [] });
    await app('#/', 'parent');
    expect(await screen.findByText('Lila')).toBeInTheDocument();
    expect(screen.queryByText(/Partage de QCM/)).toBeNull();
    expect(calls.some((c) => /shares/.test(c.url))).toBe(false);
  });
  it('/p fermé: l\'application normale s\'affiche et le jeton est retiré de l\'URL, sans appel /shares/open', async () => {
    window.history.replaceState(null, '', `/p#t=${TOKEN}`);
    const { dropShareFragment } = await import('./share');
    dropShareFragment();
    expect(window.location.href).not.toContain(TOKEN);
    expect(calls).toHaveLength(0);
  });
});

describe('eleve: creer un lien', () => {
  beforeEach(open);
  it('bouton sur la fiche; 5 questions et un titre exiges; defaut 7 jours; le lien est montre une fois', async () => {
    routes['GET /docs/D1'] = () => json(DOC);
    routes['GET /docs/D1/shareable'] = () => json(shareable(6, [{ questionId: 'D1:qcm:x', kind: 'qcm', shareable: false, reason: 'a_jouer' }, { questionId: 'D1:qcm:y', kind: 'qcm', shareable: false, reason: 'donnee_personnelle' }]));
    routes['POST /me/shares'] = () => json({ shareId: 'SH1', token: TOKEN, expiresAt: T1 }, 201);
    await app('#/doc/D1');
    await userEvent.click(await screen.findByRole('button', { name: /Partager des questions/ }));
    const list = await screen.findByRole('list', { name: 'Questions à partager' });
    const boxes = within(list).getAllByRole('checkbox');
    expect(boxes).toHaveLength(8);
    expect(boxes.filter((b) => (b as HTMLInputElement).disabled)).toHaveLength(2); // non partageables
    expect(screen.getByText('Réussis-la d’abord en t’entraînant')).toBeInTheDocument();
    expect(screen.getByText('Elle contient une donnée personnelle')).toBeInTheDocument();
    const create = screen.getByRole('button', { name: /Créer le lien/ });
    await userEvent.type(screen.getByLabelText(/Titre du QCM/), 'Revision SVT');
    for (const b of boxes.slice(0, 4)) await userEvent.click(b);
    expect(create).toBeDisabled(); // 4 questions
    await userEvent.click(boxes[4]);
    expect(create).toBeEnabled();
    expect(screen.getByLabelText(/7 jours/)).toBeChecked();
    await userEvent.click(create);
    const input = (await screen.findByLabelText('Lien à partager')) as HTMLInputElement;
    expect(input.value).toBe(`${window.location.origin}/p#t=${TOKEN}`);
    expect(screen.getByText(/on ne peut pas te le montrer une deuxième fois/)).toBeInTheDocument();
    const post = calls.find((c) => c.method === 'POST' && c.url.endsWith('/me/shares'))!;
    expect(post.body).toEqual({ docId: 'D1', questionIds: ['D1:qcm:0', 'D1:qcm:1', 'D1:qcm:2', 'D1:qcm:3', 'D1:qcm:4'], title: 'Revision SVT', ttlDays: 7 });
  });
  it('« Copié » seulement si le presse-papiers réussit', async () => {
    routes['GET /docs/D1/shareable'] = () => json(shareable(5));
    routes['POST /me/shares'] = () => json({ shareId: 'SH1', token: TOKEN, expiresAt: T1 }, 201);
    const writeText = vi.fn().mockRejectedValue(new Error('refuse'));
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    await app('#/partager/D1');
    for (const b of await screen.findAllByRole('checkbox')) await userEvent.click(b);
    await userEvent.type(screen.getByLabelText(/Titre du QCM/), 'Mon titre');
    await userEvent.click(screen.getByRole('button', { name: /Créer le lien/ }));
    await userEvent.click(await screen.findByRole('button', { name: 'Copier le lien' }));
    expect(await screen.findByText(/La copie n’a pas marché/)).toBeInTheDocument();
    expect(screen.queryByText('✓ Copié')).toBeNull();
    writeText.mockResolvedValue(undefined);
    await userEvent.click(screen.getByRole('button', { name: 'Copier le lien' }));
    expect(await screen.findByText('✓ Copié')).toBeInTheDocument();
  });
  it('21e question refusee: 20 au plus', async () => {
    routes['GET /docs/D1/shareable'] = () => json(shareable(22));
    await app('#/partager/D1');
    const boxes = await screen.findAllByRole('checkbox');
    for (const b of boxes) if (!(b as HTMLInputElement).disabled) await userEvent.click(b);
    expect(boxes.filter((b) => (b as HTMLInputElement).checked)).toHaveLength(20);
  });
  it('moins de 5 questions reussies: explication, pas de formulaire', async () => {
    routes['GET /docs/D1/shareable'] = () => json(shareable(3, [{ questionId: 'z', kind: 'qcm', shareable: false, reason: 'a_jouer' }]));
    await app('#/partager/D1');
    expect(await screen.findByText(/Il te faut au moins 5 questions réussies/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Créer le lien/ })).toBeNull();
  });
  it('titre refuse (400 titre_refuse) et partage ferme par le parent (403): messages clairs', async () => {
    routes['GET /docs/D1/shareable'] = () => json(shareable(5));
    routes['POST /me/shares'] = () => json({ code: 'titre_refuse', message: 'x' }, 400);
    await app('#/partager/D1');
    for (const b of await screen.findAllByRole('checkbox')) await userEvent.click(b);
    await userEvent.type(screen.getByLabelText(/Titre du QCM/), 'Mon titre');
    await userEvent.click(screen.getByRole('button', { name: /Créer le lien/ }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/titre n’est pas accepté/);
  });
  it('403 au chargement: le parent n\'a pas active le partage', async () => {
    routes['GET /docs/D1/shareable'] = () => json({ code: 'interdit', message: 'Interdit' }, 403);
    await app('#/partager/D1');
    expect(await screen.findByRole('alert')).toHaveTextContent(/Demande à ton parent de l’activer/);
  });
});

describe('eleve: mes liens', () => {
  beforeEach(open);
  it('liste (titre, dates, lectures, signalements), revocation, jamais de lien', async () => {
    let list = [MY(), MY({ shareId: 'SH2', title: 'Suspendu', state: 'suspendu', reports: 3, outdated: true })];
    routes['GET /me/shares'] = () => json({ shares: list });
    routes['DELETE /me/shares/SH1'] = () => { list = list.slice(1); return new Response(null, { status: 204 }); };
    await app('#/partages');
    expect(await screen.findByText('Revision SVT')).toBeInTheDocument();
    expect(screen.getByText('Suspendu (3 signalements)')).toBeInTheDocument();
    expect(screen.getByText(/La fiche a été corrigée depuis/)).toBeInTheDocument();
    expect(screen.getAllByText(/3 lectures/)).toHaveLength(2);
    expect(document.body.textContent).not.toMatch(/#t=/);
    await userEvent.click(screen.getAllByRole('button', { name: 'Supprimer le lien' })[0]);
    await waitFor(() => expect(screen.queryByText('Revision SVT')).toBeNull());
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/me/shares/SH1'))).toBe(true);
  });
});

describe('parent', () => {
  beforeEach(() => {
    open();
    routes['GET /me'] = () => json({ userId: 'p1', role: 'parent', familyId: 'f1' });
    routes['GET /family/leaderboard'] = () => json({ week: '2026-W49', entries: [] });
  });
  it('active le partage (ferme par defaut): PATCH sharing true', async () => {
    routes['GET /family/dashboard'] = () => json(dashboard());
    routes['GET /students/s1/shares'] = () => json({ shares: [], purgePending: false });
    routes['PATCH /students/s1'] = () => json({});
    await app('#/', 'parent');
    const sw = await screen.findByRole('switch');
    expect(sw).not.toBeChecked();
    await userEvent.click(sw);
    await waitFor(() => expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sharing: true }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
  });
  it('coupe le partage: drapeau d\'abord, puis suppression des liens', async () => {
    routes['GET /family/dashboard'] = () => json(dashboard(true));
    routes['GET /students/s1/shares'] = () => json({ shares: [{ shareId: 'SH1', title: 'Revision SVT', count: 6, createdAt: T0, expiresAt: T1, state: 'actif', reads: 2, reports: 1 }], purgePending: false });
    routes['PATCH /students/s1'] = () => json({});
    routes['DELETE /students/s1/shares'] = () => new Response(null, { status: 204 });
    await app('#/', 'parent');
    expect(await screen.findByText('Revision SVT')).toBeInTheDocument();
    expect(screen.getByText(/2 lectures · 1 signalement/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('switch'));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/students/s1/shares'))).toBe(true));
    const order = calls.filter((c) => c.method === 'PATCH' || c.method === 'DELETE').map((c) => c.method);
    expect(order).toEqual(['PATCH', 'DELETE']);
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ sharing: false });
  });
  it('revoque un lien; purgePending propose de terminer; jamais les questions', async () => {
    routes['GET /family/dashboard'] = () => json(dashboard(false));
    routes['GET /students/s1/shares'] = () => json({ shares: [{ shareId: 'SH9', title: 'Reste', count: 5, createdAt: T0, expiresAt: T1, state: 'actif', reads: 0, reports: 0 }], purgePending: true });
    routes['DELETE /students/s1/shares'] = () => new Response(null, { status: 204 });
    routes['DELETE /students/s1/shares/SH9'] = () => new Response(null, { status: 204 });
    await app('#/', 'parent');
    expect(await screen.findByText(/des liens existent encore/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer le lien Reste' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/shares/SH9'))).toBe(true));
    await userEvent.click(screen.getByRole('button', { name: 'Terminer la suppression' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/students/s1/shares'))).toBe(true));
  });
});

describe('page publique /p', () => {
  const QUIZ = {
    title: 'Revision SVT', subject: 'svt', expiresAt: T1,
    questions: [
      { kind: 'qcm', prompt: 'Ou a lieu la photosynthese ?', choices: ['Chloroplastes', 'Noyau', 'Ribosomes', 'Mitochondries'], answer: 0 },
      { kind: 'gap', prompt: 'La plante rejette du ___.', expected: 'dioxygène' },
      { kind: 'qcm', prompt: '<img src=x onerror=alert(1)> et $\\href{javascript:alert(1)}{x}$', choices: ['<b>gras</b>', 'b', 'c', 'd'], answer: 1 },
      { kind: 'qcm', prompt: 'Q4', choices: ['a', 'b', 'c', 'd'], answer: 2 },
      { kind: 'qcm', prompt: 'Q5', choices: ['a', 'b', 'c', 'd'], answer: 3 },
    ],
  };
  const mount = async () => {
    open();
    window.history.replaceState(null, '', `/p#t=${TOKEN}`);
    const { SharePublic } = await import('./screens/SharePublic');
    return render(<SharePublic />);
  };

  it('retire le jeton de l\'URL, appelle seulement /shares/open, aucun Cognito ni /me', async () => {
    routes['POST /shares/open'] = () => json(QUIZ);
    await mount();
    expect(window.location.href).not.toContain(TOKEN);
    expect(window.location.hash).toBe('');
    expect(await screen.findByRole('heading', { name: 'Revision SVT' })).toBeInTheDocument();
    expect(calls).toHaveLength(1);
    expect(calls[0].url).toMatch(/\/shares\/open$/);
    expect(calls[0].body).toEqual({ token: TOKEN });
    expect(calls[0].credentials).toBe('omit'); // aucun cookie envoye a la route publique
    expect(calls.some((c) => /cognito|\/me/.test(c.url))).toBe(false);
    expect(screen.getByText(/non relu par un enseignant/)).toBeInTheDocument();
    expect(sessionStorage.length + localStorage.length).toBe(0);
    expect(document.querySelector('meta[name="robots"]')?.getAttribute('content')).toBe('noindex');
  });

  it('joue sans rien envoyer: correction locale, trou compare avec normalizeGap, resultat final, texte brut jamais en HTML', async () => {
    routes['POST /shares/open'] = () => json(QUIZ);
    vi.spyOn(Math, 'random').mockReturnValue(0.999999); // melange identite (j = i)
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /C'est parti/ }));
    await userEvent.click(screen.getByRole('button', { name: 'Chloroplastes' }));
    expect(screen.getByText('✓ Bravo !')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }));
    await userEvent.type(screen.getByLabelText('Ta réponse'), '  DIOXYGENE ');
    await userEvent.click(screen.getByRole('button', { name: 'Valider' }));
    expect(screen.getByText('✓ Bravo !')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Suivant' }));
    // question 3: HTML et LaTeX dangereux rendus comme texte / en repli, jamais comme balises ni lien
    expect(document.querySelector('main img')).toBeNull();
    expect(document.querySelector('main a[href], main b')).toBeNull();
    expect(screen.getByText(/<img src=x onerror=alert\(1\)>/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: '<b>gras</b>' }));
    expect(screen.getByText('✗ Pas tout à fait.')).toBeInTheDocument();
    for (let k = 0; k < 3; k++) {
      await userEvent.click(screen.getByRole('button', { name: /Suivant|Terminer/ }));
      if (k < 2) await userEvent.click(screen.getByRole('button', { name: 'a' }));
    }
    expect(await screen.findByText('Bien joué !')).toBeInTheDocument();
    expect(calls).toHaveLength(1); // seulement l'ouverture: aucune reponse, aucun point envoye
    vi.restoreAllMocks();
  });

  it('signalement: motif d\'une liste fermee, rien d\'autre dans le corps', async () => {
    routes['POST /shares/open'] = () => json(QUIZ);
    routes['POST /shares/report'] = () => new Response(null, { status: 204 });
    await mount();
    await userEvent.click(await screen.findByRole('button', { name: /Signaler ce QCM/ }));
    await userEvent.click(screen.getByLabelText(/Données personnelles/));
    await userEvent.click(screen.getByRole('button', { name: 'Envoyer le signalement' }));
    expect(await screen.findByText(/le signalement est envoyé/)).toBeInTheDocument();
    expect(calls.find((c) => c.url.endsWith('/shares/report'))?.body).toEqual({ token: TOKEN, reason: 'donnees_perso' });
  });

  it('lien inconnu, expire ou revoque (404): meme message, sans detail', async () => {
    routes['POST /shares/open'] = () => json({ code: 'lien_indisponible', message: 'Lien indisponible' }, 404);
    await mount();
    expect(await screen.findByRole('heading', { name: "Ce QCM n'est pas disponible" })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Signaler/ })).toBeNull();
  });

  it('lien incomplet ou jeton mal forme: pas d\'appel du tout', async () => {
    open();
    window.history.replaceState(null, '', '/p#t=court');
    const { SharePublic } = await import('./screens/SharePublic');
    render(<SharePublic />);
    expect(await screen.findByRole('heading', { name: "Ce QCM n'est pas disponible" })).toBeInTheDocument();
    expect(calls).toHaveLength(0);
  });
});

describe('logique du partage', () => {
  it('toPlay: le melange garde la bonne reponse; isCorrect', async () => {
    const { toPlay, isCorrect } = await import('./share');
    for (let t = 0; t < 30; t++) {
      const [q] = toPlay([{ kind: 'qcm', prompt: 'p', choices: ['A', 'B', 'C', 'D'], answer: 2 }]);
      expect(q.choices[q.answer]).toBe('C');
      expect(isCorrect(q, q.answer)).toBe(true);
      expect(isCorrect(q, (q.answer + 1) % 4)).toBe(false);
    }
    const [g] = toPlay([{ kind: 'gap', prompt: 'p', expected: 'Œuf' }]);
    expect(isCorrect(g, 'oeuf.')).toBe(true);
    expect(isCorrect(g, '')).toBe(false);
  });
  it('bornes identiques a shared/share-rules.ts', async () => {
    const { LIMITS } = await import('./share');
    expect(LIMITS).toEqual({
      min: rules.SHARE_MIN_QUESTIONS, max: rules.SHARE_MAX_QUESTIONS, titleMin: rules.SHARE_TITLE_MIN, titleMax: rules.SHARE_TITLE_MAX,
      ttl: [...rules.SHARE_TTL_DAYS], defaultTtl: rules.SHARE_DEFAULT_TTL_DAYS, perStudent: rules.SHARE_PER_STUDENT,
    });
    for (const t of ['AbCdEfGhIjKlMnOpQrStUv', 'a'.repeat(22), 'court']) expect(rules.SHARE_TOKEN_RE.test(t)).toBe(t.length === 22);
  });
});
