import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { archiveError, groupByYear, toneOf, verdict } from './history';
import { ApiError } from './api';
import { POLICY_VERSION } from '../../shared/policy';

// H1-W: historique des tests (élève, parent), archive, ré-acceptation de la politique. API simulée par un routeur local.
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Call = { path: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | undefined> = {};
let me: object = { userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Lila' };

const T = (n: number, year: string, extra: object = {}) => ({
  testId: `T${n}`, docId: 'D1', titre: `Fiche ${n}`, matiere: 'svt', mode: 'mixte', schoolYear: year, startedAt: '2026-11-20T17:00:00Z', endedAt: '2026-11-20T17:02:00Z',
  total: 3, answered: 3, correct: 2, firstTry: 2, scorePct: 67, xpGained: 10, status: 'complet', ...extra,
});
const Q = { questionId: 'qcm-01', rank: 1, kind: 'qcm', correct: false, attempts: 2, firstTry: false, xpGained: 0, answeredAt: '2026-11-20T17:00:30Z' };

beforeEach(() => {
  calls = [];
  routes = {};
  me = { userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Lila' };
  sessionStorage.clear();
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : undefined;
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    calls.push({ path, method, body });
    for (const [k, fn] of Object.entries(routes)) {
      const [m, p] = k.split(' ');
      if (m === method && (p === path || (p.endsWith('*') && path.startsWith(p.slice(0, -1))))) {
        const r = fn({ path, method, body });
        if (r) return r;
      }
    }
    if (path === '/me') return json(me);
    if (path === '/me/progress') return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 12, pagesLimit: 30, resetDate: '2026-12-01' });
    if (path === '/family/dashboard') return json({ students: [{ student: { studentId: 's1', pseudo: 'lila-7k2fm', loginId: 'lila-7k2fm', displayName: 'Lila', schoolLevel: 'seconde', under15: false, status: 'actif', pageQuota: 20 }, progress: { xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 12, pagesLimit: 30, resetDate: '2026-12-01' } }], familyPagesRemaining: 40, familyPagesLimit: 50 });
    if (path === '/family/leaderboard') return json({ week: '2026-W48', entries: [] });
    return json({ code: 'introuvable', message: 'Introuvable' }, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function open(hash: string, role: 'eleve' | 'parent' = 'eleve') {
  sessionStorage.setItem('qcm.mockRole', role);
  window.location.hash = hash;
  return render(<App />);
}

describe('aides', () => {
  it('paliers de score, verdict par question et regroupement par année (ordre conservé)', () => {
    expect([toneOf(80), toneOf(79), toneOf(50), toneOf(49)]).toEqual(['top', 'mid', 'mid', 'low']);
    expect(verdict({ correct: true, attempts: 1, firstTry: true }).text).toBe('Juste du premier coup');
    expect(verdict({ correct: true, attempts: 2, firstTry: false }).text).toBe('Juste au 2e essai');
    expect(verdict({ correct: false, attempts: 2, firstTry: false }).text).toMatch(/À revoir/);
    const g = groupByYear([T(1, '2026-2027'), T(2, '2026-2027'), T(3, '2025-2026')] as never);
    expect(g.map((x) => [x.year, x.items.length])).toEqual([['2026-2027', 2], ['2025-2026', 1]]);
  });
  it('message d\'archive: quota horaire et limite de débit se distinguent', () => {
    expect(archiveError(new ApiError(429, 'quota_epuise', 'x'))).toMatch(/3 archives/);
    expect(archiveError(new ApiError(429, 'erreur', 'Too Many Requests'))).toMatch(/Patiente/);
  });
});

describe('Mes tests (élève)', () => {
  it('liste par année, filtre par année scolaire et page suivante par curseur', async () => {
    routes['GET /me/tests*'] = (c) => {
      const q = new URLSearchParams(c.path.split('?')[1]);
      if (q.get('schoolYear') === '2025-2026') return json({ items: [T(9, '2025-2026')] });
      if (q.get('cursor') === 'CUR') return json({ items: [T(3, '2025-2026')] });
      return json({ items: [T(1, '2026-2027'), T(2, '2026-2027')], nextCursor: 'CUR', schoolYears: ['2026-2027', '2025-2026'] });
    };
    await open('/tests');
    expect(await screen.findByRole('heading', { name: /Année 2026 - 2027/ })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Voir les tests plus anciens' }));
    expect(await screen.findByRole('heading', { name: /Année 2025 - 2026/ })).toBeInTheDocument();
    expect(calls.some((c) => c.path.includes('cursor=CUR'))).toBe(true);
    await userEvent.click(screen.getByRole('button', { name: '2025 - 2026' }));
    await waitFor(() => expect(screen.queryByRole('heading', { name: /Année 2026 - 2027/ })).toBeNull());
    expect(calls.some((c) => c.path.includes('schoolYear=2025-2026'))).toBe(true);
    expect(screen.getByRole('button', { name: '2025 - 2026' })).toHaveAttribute('aria-pressed', 'true');
  });

  it("le détail montre ma réponse et la bonne réponse; une question retirée est signalée", async () => {
    routes['GET /me/tests/T1'] = () => json({
      ...T(1, '2026-2027'),
      questions: [
        { ...Q, prompt: 'Que produit la photosynthèse ?', choices: ['Du dioxygène', 'Du CO2'], choice: 'Du CO2', correctAnswer: 'Du dioxygène' },
        { ...Q, questionId: 'gap-9', rank: 2, kind: 'gap', correct: true, attempts: 1, firstTry: true, choice: 'x' },
      ],
    });
    await open('/tests/T1');
    expect(await screen.findByText('Que produit la photosynthèse ?')).toBeInTheDocument();
    expect(screen.getAllByText('Ta réponse')).toHaveLength(2); // le choix coché du QCM et la ligne du texte à trous
    expect(screen.getByText('Bonne réponse')).toBeInTheDocument();
    expect(screen.getByText("Cette question n'existe plus dans la fiche.")).toBeInTheDocument();
  });
});

describe('Suivi (parent)', () => {
  beforeEach(() => { me = { userId: 'p1', role: 'parent', familyId: 'f1' }; });

  it("le résultat par question n'affiche ni texte, ni choix, ni réponse, même si le serveur en envoyait", async () => {
    routes['GET /students/s1/tests/T1'] = () => json({ ...T(1, '2026-2027'), questions: [{ ...Q, prompt: 'TEXTE-SECRET', choice: 'REPONSE-SECRETE', correctAnswer: 'BONNE-SECRETE' }] });
    await open('/suivi/s1/T1', 'parent');
    expect(await screen.findByText(/À revoir/)).toBeInTheDocument();
    expect(screen.getByText('Question 1')).toBeInTheDocument();
    const main = screen.getByRole('main');
    expect(main.textContent).not.toMatch(/SECRET/);
    expect(within(main).getByText(/restent privés/)).toBeInTheDocument();
  });

  it('le tableau de bord mène au suivi de chaque élève', async () => {
    await open('/', 'parent');
    expect(await screen.findByRole('link', { name: /Suivi de Lila/ })).toHaveAttribute('href', '#/suivi/s1');
  });
});

describe('Archive', () => {
  beforeEach(() => { me = { userId: 'p1', role: 'parent', familyId: 'f1' }; });

  it('donne le lien et son heure limite', async () => {
    routes['POST /family/export/archive'] = () => json({ url: 'https://exemple.invalid/a.zip', expiresAt: '2026-12-01T10:10:00Z', format: 'zip', sizeBytes: 482113, students: 1, tests: 30, truncated: false });
    await open('/', 'parent');
    await userEvent.click(await screen.findByRole('button', { name: "Préparer l'archive" }));
    expect(await screen.findByRole('link', { name: /Télécharger l'archive/ })).toHaveAttribute('href', 'https://exemple.invalid/a.zip');
    expect(screen.getByText(/30 tests/)).toBeInTheDocument();
  });

  it('429 après une archive prête: le lien encore valable reste affiché avec le message', async () => {
    let n = 0;
    routes['POST /family/export/archive'] = () => (++n === 1 ? json({ url: 'https://exemple.invalid/a.zip', expiresAt: '2026-12-01T10:10:00Z', format: 'zip', sizeBytes: 1000, students: 1, tests: 3, truncated: false }) : json({ code: 'quota_epuise', message: 'brut' }, 429));
    await open('/', 'parent');
    const ask = await screen.findByRole('button', { name: "Préparer l'archive" });
    await userEvent.click(ask);
    await screen.findByRole('link', { name: /Télécharger l'archive/ });
    await userEvent.click(ask);
    expect(await screen.findByRole('alert')).toHaveTextContent(/3 archives cette heure/);
    expect(screen.getByRole('link', { name: /Télécharger l'archive/ })).toHaveAttribute('href', 'https://exemple.invalid/a.zip');
  });

  it('429 quota_epuise: message clair, pas de lien', async () => {
    routes['POST /family/export/archive'] = () => json({ code: 'quota_epuise', message: 'brut' }, 429);
    await open('/', 'parent');
    await userEvent.click(await screen.findByRole('button', { name: "Préparer l'archive" }));
    expect(await screen.findByRole('alert')).toHaveTextContent(/3 archives cette heure/);
    expect(screen.queryByRole('link', { name: /Télécharger l'archive/ })).toBeNull();
  });
});

describe('Ré-acceptation de la politique', () => {
  beforeEach(() => { me = { userId: 'p1', role: 'parent', familyId: 'f1', policyOutdated: true }; });

  it("bloque le tableau de bord jusqu'à l'acceptation, qui envoie la version en vigueur", async () => {
    routes['POST /family/policy'] = () => new Response(null, { status: 204 });
    await open('/', 'parent');
    expect(await screen.findByRole('heading', { name: 'La politique de confidentialité a changé' })).toBeInTheDocument();
    expect(screen.getByText(/schémas de ses cours, un par un et seulement s'il le choisit/)).toBeInTheDocument();
    expect(screen.getByText(/identifiant de connexion et un surnom/)).toBeInTheDocument();
    expect(screen.getByText(/Nous gardons l'historique des tests/)).toBeInTheDocument();
    expect(screen.queryByText('Pages de la famille')).toBeNull();
    const ok = screen.getByRole('button', { name: "J'accepte la nouvelle politique" });
    expect(ok).toBeDisabled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(ok);
    expect(await screen.findByText('Pages de la famille')).toBeInTheDocument();
    expect(calls.find((c) => c.path === '/family/policy')?.body).toEqual({ consent: true, policyVersion: POLICY_VERSION });
  });

  it("une erreur du serveur s'affiche et l'écran reste", async () => {
    routes['POST /family/policy'] = () => json({ code: 'requete_invalide', message: 'Consentement requis' }, 400);
    await open('/', 'parent');
    await userEvent.click(await screen.findByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: "J'accepte la nouvelle politique" }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Consentement requis');
    expect(screen.queryByText('Pages de la famille')).toBeNull();
  });

  it("permet de retirer l'accord: export, puis suppression de la famille après confirmation", async () => {
    routes['GET /family/export'] = () => json({ familyId: 'f1', exportedAt: '2026-12-01T10:00:00Z', students: [], docs: [], reports: [] });
    routes['DELETE /family'] = () => new Response(null, { status: 204 });
    URL.createObjectURL = vi.fn(() => 'blob:x');
    URL.revokeObjectURL = vi.fn();
    const confirm = vi.spyOn(window, 'confirm').mockReturnValueOnce(false).mockReturnValueOnce(true);
    await open('/', 'parent');
    await userEvent.click(await screen.findByRole('button', { name: 'Télécharger mes données' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'GET' && c.path === '/family/export')).toBe(true));
    const del = screen.getByRole('button', { name: 'Supprimer la famille et les comptes' });
    await userEvent.click(del); // refus de la confirmation: rien n'est supprimé
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(del);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.path === '/family')).toBe(true));
    expect(confirm).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.queryByRole('heading', { name: 'La politique de confidentialité a changé' })).toBeNull()); // déconnecté
  });

  it('un élève ne voit jamais cet écran', async () => {
    me = { userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Lila', policyOutdated: true };
    await open('/', 'eleve');
    expect(await screen.findByText(/Salut Lila/)).toBeInTheDocument();
  });
});
