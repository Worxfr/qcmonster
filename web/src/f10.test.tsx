import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// F10: ajout de pages a un cours. API simulee par un routeur local.
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | undefined> = {};
const T0 = '2026-12-01T10:00:00Z';
const cours = (pages: number, nSec = 1) => ({
  coursId: 'C1', createdAt: T0, pages, texts: [{ page: 1, sentences: [{ id: 'p1-s1', text: 'La photosynthese produit du dioxygene.' }] }],
  sections: Array.from({ length: nSec }, (_, n) => ({ fromSentenceId: 'p1-s1', subject: 'svt', topic: n === 0 ? 'Photosynthese' : undefined, status: 'fiche', docId: `D${n}` })),
});

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
    for (const [k, fn] of Object.entries(routes)) {
      const [m, p] = k.split(' ');
      if (m === method && (p === path || (p.endsWith('*') && (path.startsWith(p.slice(0, -1)) || url.startsWith(p.slice(0, -1)))))) {
        const r = fn(c);
        if (r) return r;
      }
    }
    if (path === '/me') return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Test' });
    if (path === '/me/progress') return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 12, pagesLimit: 30, resetDate: '2026-12-01' });
    if (path.startsWith('/folders')) return json({ items: [] });
    if (path.startsWith('/scans')) return json({ items: [], inProgress: 0, toReview: 0, facets: { subjects: [], topics: [] } });
    return json({ code: 'introuvable', message: 'Introuvable' }, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());

async function open(hash: string) {
  sessionStorage.setItem('qcm.mockRole', 'eleve');
  window.location.hash = hash;
  return render(<App />);
}

describe('ajout de pages (F10)', () => {
  it('le cours propose « Ajouter des pages » vers l ecran d ajout', async () => {
    routes['GET /cours/C1'] = () => json(cours(4));
    await open('#/cours/C1');
    expect(await screen.findByRole('link', { name: /Ajouter des pages/ })).toHaveAttribute('href', '#/scan/ajout/C1');
    expect(screen.getByText(/26 pages possibles/)).toBeInTheDocument();
  });

  it('cours complet (30 pages): pas de bouton, un message', async () => {
    routes['GET /cours/C1'] = () => json(cours(30));
    await open('#/cours/C1');
    expect(await screen.findByText(/Ce cours est complet/)).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /Ajouter des pages/ })).toBeNull();
  });

  it('envoi: POST /scans avec le coursId, 3 pages au plus ici (28 pages dans le cours: 2 possibles)', async () => {
    routes['GET /cours/C1'] = () => json(cours(28));
    routes['POST /scans'] = () => json({ jobId: 'J9', upload: { url: 'https://s3.example/0', fields: {} }, uploads: [0, 1].map((i) => ({ page: i + 1, url: `https://s3.example/${i}`, fields: {} })), expiresAt: T0, pagesRemaining: 9 });
    routes['POST https://s3.example/*'] = () => new Response(null, { status: 204 });
    await open('#/scan/ajout/C1');
    expect(await screen.findByText(/Tes nouvelles pages seront ajoutées à la/)).toBeInTheDocument();
    const input = await screen.findByLabelText('Prendre ou choisir des photos');
    const f = (n: number) => new File(['x'], `p${n}.jpg`, { type: 'image/jpeg' });
    await userEvent.upload(input, [f(1), f(2), f(3)]);
    expect(await screen.findByText(/2 pages au maximum pour cet ajout/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ajouter 2 pages au cours/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/job/J9'));
    expect(calls.find((c) => c.url.endsWith('/scans') && c.method === 'POST')!.body).toMatchObject({ pages: 2, coursId: 'C1' });
  });

  it('cours_plein (409) et ajout deja ouvert (409): messages clairs', async () => {
    routes['GET /cours/C1'] = () => json(cours(4));
    routes['POST /scans'] = () => json({ code: 'etat_invalide', message: 'Un autre ajout est en cours pour ce cours' }, 409);
    await open('#/scan/ajout/C1');
    await userEvent.upload(await screen.findByLabelText('Prendre ou choisir des photos'), [new File(['x'], 'a.jpg', { type: 'image/jpeg' })]);
    await userEvent.click(screen.getByRole('button', { name: /Ajouter 1 page au cours/ }));
    expect(await screen.findByText('Un autre ajout est en cours pour ce cours')).toBeInTheDocument();
    routes['POST /scans'] = () => json({ code: 'cours_plein', message: 'Ce cours est complet' }, 409);
    await userEvent.click(screen.getByRole('button', { name: /Ajouter 1 page au cours/ }));
    expect(await screen.findByText(/Ce cours est complet : 30 pages/)).toBeInTheDocument();
  });

  it('relecture: la fin du cours est montree en lecture seule, les pages sont numerotees a la suite', async () => {
    routes['GET /jobs/J9'] = () => json({ jobId: 'J9', state: 'a_confirmer', pages: 1, createdAt: T0, coursId: 'C1', status: { stage: 'a_confirmer', pagesDone: 1, pagesTotal: 1, startedAt: T0, expiresAt: '2026-12-02T10:00:00Z', expiresSoon: false } });
    routes['GET /jobs/J9/transcription'] = () => json({
      jobId: 'J9', docType: 'cours', photoUrls: ['https://s3.example/p'], photoUrlsExpireAt: '2026-12-01T10:05:00Z',
      context: [{ id: 'p4-s8', text: 'Avant derniere phrase du cours.' }, { id: 'p4-s9', text: 'Derniere phrase du cours' }],
      pages: [{ page: 5, sentences: [{ id: 'p5-s1', continuesId: 'p4-s9', text: 'qui continue ici et ajoute assez de mots pour le test ' + 'mot '.repeat(45) }] }],
    });
    await open('#/job/J9');
    expect(await screen.findByText('Vérifie les nouvelles pages')).toBeInTheDocument();
    expect(screen.getByText('Derniere phrase du cours')).toBeInTheDocument();
    expect(screen.getByText(/continue cette fin/)).toBeInTheDocument();
    expect(screen.getAllByText(/Tu ajoutes ces pages à la/).length).toBeGreaterThan(0);
  });
});
