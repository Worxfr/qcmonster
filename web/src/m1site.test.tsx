import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// M1 #90: le bouton « Modifier ce cours » est absent tant que le drapeau du site est ferme (defaut). API simulee par un routeur local.
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

describe('modifier un cours (M1 #90), drapeau du site', () => {
  it('par defaut (VITE_REVISE_ENABLED absent): pas de bouton « Modifier ce cours »', async () => {
    routes['GET /cours/C1'] = () => json(cours(4));
    await open('#/cours/C1');
    expect(await screen.findByRole('link', { name: /Ajouter des pages/ })).toBeInTheDocument(); // le cours est affiche
    expect(screen.queryByRole('link', { name: /Modifier ce cours/ })).toBeNull();
  });
  it('une modification deja ouverte reste visible meme drapeau ferme (autre appareil)', async () => {
    routes['GET /cours/C1'] = () => json({ ...cours(4), revision: { revisionId: 'R1', etat: 'en_cours' } });
    await open('#/cours/C1');
    expect(await screen.findByText(/Une modification de ton cours est en cours/)).toBeInTheDocument();
  });
});
