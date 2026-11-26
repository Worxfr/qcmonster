import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';


// #74: gestion des dossiers (lien mort, en-tete du dossier, fiche). API simulee par un routeur local (meme gabarit que lotf.test.tsx).
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | undefined> = {};
const T0 = '2026-12-01T10:00:00Z';
const status = (stage: string, extra: object = {}) => ({ stage, pagesDone: 1, pagesTotal: 1, startedAt: T0, ...extra });
const scan = (n: number, extra: object = {}) => ({ scanId: `S${n}`, studentId: 's1', state: 'termine', docId: `D${n}`, title: `Fiche ${n}`, subject: 'svt', topic: `Sujet ${n}`, pages: 2, createdAt: T0, status: status('termine'), ...extra });
const list = (items: object[], extra: object = {}) => ({ items, inProgress: 0, toReview: 0, facets: { subjects: [{ subject: 'svt', count: items.length }], topics: [{ topic: 'Sujet 1', count: 1 }] }, ...extra });

function install() {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    const method = init?.method ?? 'GET';
    const body = typeof init?.body === 'string' ? JSON.parse(init.body) : init?.body;
    const c = { url, method, body };
    calls.push(c);
    const path = url.replace(/^https?:\/\/[^/]+/, '');
    for (const [k, fn] of Object.entries(routes)) {
      const [m, p] = k.split(' ');
      if (m === method && (p === path || p === url || (p.endsWith('*') && (path.startsWith(p.slice(0, -1)) || url.startsWith(p.slice(0, -1)))))) {
        const r = fn(c);
        if (r) return r;
      }
    }
    if (path === '/me') return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Test' });
    if (path === '/me/progress') return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 12, pagesLimit: 30, resetDate: '2026-12-01' });
    if (path.startsWith('/folders') && method === 'GET') return json({ items: [{ folderId: 'F1', name: 'Contrôle de juin', createdAt: T0, scanCount: 2 }] });
    if (path.startsWith('/scans')) return json(list([]));
    return json({ code: 'introuvable', message: 'Introuvable' }, 404);
  });
}
async function open(hash: string, role: 'eleve' | 'parent' = 'eleve') {
  sessionStorage.setItem('qcm.mockRole', role);
  window.location.hash = hash;
  return render(<App />);
}

beforeEach(() => {
  calls = [];
  routes = {};
  sessionStorage.clear();
  install();
});
afterEach(() => vi.unstubAllGlobals());


const F1 = { folderId: 'F1', name: 'Contrôle de juin', createdAt: T0, scanCount: 2 };
const F2 = { folderId: 'F2', name: 'Brevet blanc', createdAt: T0, scanCount: 0 };

describe('dossiers (#74)', () => {
  it('lien vers un dossier supprimé (404): pas d\'erreur, tous les cours, un mot d\'explication', async () => {
    routes['GET /scans*'] = (c) => (c.url.includes('folderId=GONE') ? json({ code: 'introuvable', message: 'Introuvable' }, 404) : json(list([scan(1)])));
    await open('#/docs?folderId=GONE');
    expect(await screen.findByText('Fiche 1')).toBeInTheDocument();
    expect(screen.getByText(/Ce dossier n'existe plus/)).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(window.location.hash).toBe('#/docs');
  });

  it('dossier ouvert: renommer puis supprimer sans quitter la liste, les cours restent', async () => {
    let name = F1.name;
    routes['GET /folders'] = () => json({ items: [{ ...F1, name }] });
    routes['GET /scans*'] = () => json(list([scan(1, { folderId: 'F1' })]));
    routes['PATCH /folders/F1'] = (c) => { name = (c.body as { name: string }).name; return json({ ...F1, name }); };
    routes['DELETE /folders/F1'] = () => new Response(null, { status: 204 });
    await open('#/docs?folderId=F1');
    await userEvent.click(await screen.findByRole('button', { name: 'Renommer le dossier' }));
    const input = screen.getByLabelText('Nouveau nom du dossier');
    await userEvent.clear(input);
    await userEvent.type(input, 'Brevet');
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('heading', { name: /Brevet/ })).toBeInTheDocument();
    expect(calls.find((c) => c.method === 'PATCH')?.body).toEqual({ name: 'Brevet' });
    await userEvent.click(screen.getByRole('button', { name: 'Supprimer le dossier' }));
    expect(screen.getByText(/Les cours restent/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Oui, supprimer le dossier' }));
    await waitFor(() => expect(window.location.hash).toBe('#/docs'));
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/folders/F1'))).toBe(true);
  });

  it('dossier déjà pris au renommage: message clair', async () => {
    routes['GET /folders'] = () => json({ items: [F1, F2] });
    routes['GET /scans*'] = () => json(list([scan(1, { folderId: 'F1' })]));
    routes['PATCH /folders/F1'] = () => json({ code: 'dossier_nom_pris', message: 'Nom déjà pris' }, 409);
    await open('#/docs?folderId=F1');
    await userEvent.click(await screen.findByRole('button', { name: 'Renommer le dossier' }));
    await userEvent.click(screen.getByRole('button', { name: 'Enregistrer' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Tu as déjà un dossier avec ce nom');
  });

  it('Tout choisir sélectionne toutes les fiches de la liste', async () => {
    routes['GET /scans*'] = () => json(list([scan(1), scan(2), scan(3)]));
    await open('#/docs');
    await userEvent.click(await screen.findByRole('button', { name: 'Choisir des cours' }));
    await userEvent.click(screen.getByRole('button', { name: /Tout choisir \(3\)/ }));
    expect(screen.getByText('3 choisis')).toBeInTheDocument();
  });

  it('la fiche: changer de dossier puis sortir du dossier', async () => {
    routes['GET /folders'] = () => json({ items: [F1, F2] });
    routes['GET /docs/D1'] = () => json({ docId: 'D1', title: 'Les volcans', subject: 'svt', createdAt: T0, folderId: 'F1', summary: '', claims: [] });
    routes['POST /folders/F2/scans'] = () => json(F2);
    routes['DELETE /folders/F2/scans/D1'] = () => new Response(null, { status: 204 });
    await open('#/doc/D1');
    const sel = await screen.findByLabelText('Cette fiche est dans');
    await waitFor(() => expect(sel).toHaveValue('F1'));
    await userEvent.selectOptions(sel, 'F2');
    expect(await screen.findByRole('status')).toHaveTextContent('Rangée dans « Brevet blanc »');
    expect(calls.find((c) => c.url.endsWith('/folders/F2/scans'))?.body).toEqual({ docIds: ['D1'] });
    await userEvent.selectOptions(sel, '');
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/folders/F2/scans/D1'))).toBe(true));
  });

  it('nouveau dossier: la touche Entrée le crée et le choisit', async () => {
    routes['GET /folders'] = () => json({ items: [] });
    routes['GET /docs/D1'] = () => json({ docId: 'D1', title: 'Les volcans', subject: 'svt', createdAt: T0, summary: '', claims: [] });
    routes['POST /folders'] = () => json(F2, 201);
    routes['POST /folders/F2/scans'] = () => json(F2);
    await open('#/doc/D1');
    await userEvent.selectOptions(await screen.findByLabelText('Cette fiche est dans'), '__new__');
    expect(screen.getByText(/n'existe qu'après « Créer »/)).toBeInTheDocument();
    await userEvent.type(screen.getByLabelText('Nom du nouveau dossier'), 'Brevet blanc{Enter}');
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/folders/F2/scans'))?.body).toEqual({ docIds: ['D1'] }));
  });
});
