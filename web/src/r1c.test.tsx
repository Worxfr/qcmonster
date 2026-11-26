import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { normalizeExport } from './api';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const IMG = 'data:image/gif;base64,R0lGODlhAQABAAAAACw=';
let routes: Record<string, () => Response> = {};
const calls: string[] = [];

beforeEach(() => {
  routes = {};
  calls.length = 0;
  sessionStorage.setItem('qcm.mockRole', 'eleve');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/, '');
    const key = `${init?.method ?? 'GET'} ${url}`;
    calls.push(key);
    if (url === '/me') return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Test' });
    if (url === '/me/progress') return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 5, pagesLimit: 10, resetDate: '2026-12-01' });
    const r = routes[key] ?? Object.entries(routes).find(([k]) => k.endsWith('*') && key.startsWith(k.slice(0, -1)))?.[1];
    return r ? r() : json({}, 404);
  });
});
afterEach(() => vi.unstubAllGlobals());
const open = (hash: string) => { window.location.hash = hash; return render(<App />); };

const cours = {
  coursId: 'C1', jobId: 'J1', createdAt: '2026-12-01T10:00:00Z', pages: 1, sentenceCount: 3, subjects: ['svt'],
  sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Cellule', status: 'fiche', docId: 'D1' }],
  texts: [{ page: 1, sentences: [{ id: 'p1-s1', text: 'La cellule est $x^2$.' }, { id: 'p1-s2', text: 'Elle a 5 noyaux.' }, { id: 'p1-s3', text: 'Elle est ronde.' }] }],
  blocks: [{ id: 'b1', kind: 'paragraphe', sentenceIds: ['p1-s1', 'p1-s2'] }, { id: 'b2', kind: 'figure', figureId: 'f1' }, { id: 'b3', kind: 'paragraphe', sentenceIds: ['p1-s3'] }],
  figures: [{ figureId: 'f1', page: 1, kind: 'schema', alt: 'Une cellule', url: IMG }],
  marks: [{ sentenceId: 'p1-s1', status: 'verifiee', docId: 'D1', claimId: 'c1' }, { sentenceId: 'p1-s2', status: 'erreur', docId: 'D1', claimId: 'c2' }],
};

describe('cours: couleurs de vérification', () => {
  it('marques avec icône et mot, lien vers l\'affirmation, interrupteur, figure gardée', async () => {
    routes['GET /cours/C1'] = () => json(cours);
    const { container } = open('#/cours/C1') && { container: document.body };
    expect(await screen.findByRole('link', { name: /Vérifié : voir l'affirmation/ })).toHaveAttribute('href', '#/doc/D1/c1');
    expect(screen.getByRole('link', { name: /Erreur trouvée/ })).toHaveAttribute('href', '#/doc/D1/c2');
    expect(screen.getByRole('img', { name: 'Une cellule' })).toBeInTheDocument();
    expect(container.querySelector('.doc math')).not.toBeNull();
    await userEvent.click(screen.getByRole('checkbox', { name: 'Montrer la vérification' }));
    expect(screen.queryByRole('link', { name: /Vérifié/ })).toBeNull();
    expect(screen.getByText(/Elle a 5 noyaux/)).toBeInTheDocument();
  });

  it('cours ancien (sans blocs, ni marques): les phrases s\'affichent, sans interrupteur', async () => {
    routes['GET /cours/C1'] = () => json({ ...cours, blocks: undefined, figures: undefined, marks: undefined });
    open('#/cours/C1');
    expect(await screen.findByText(/Elle est ronde/)).toBeInTheDocument();
    expect(screen.queryByRole('checkbox', { name: 'Montrer la vérification' })).toBeNull();
    expect(screen.queryByRole('img', { name: 'Une cellule' })).toBeNull();
  });
});

describe('fiche: paragraphes, rappel, figures', () => {
  const doc = {
    docId: 'D1', title: 'La cellule', subject: 'svt', createdAt: '2026-12-01T10:00:00Z', summary: 'Résumé ancien.',
    body: [{ heading: 'Le noyau', text: 'Le noyau contient l\'ADN.' }, { text: 'La formule est $E=mc^2$.' }],
    recall: [{ kind: 'date', text: 'En 1665, Hooke observe des cellules.', claimId: 'c1', verified: true }, { kind: 'nombre', text: 'Une cellule a 1 noyau.', claimId: 'c2', verified: false }],
    figures: [{ figureId: 'f1', page: 1, kind: 'schema', alt: 'Une cellule', url: IMG }],
    claims: [{ claimId: 'c1', text: 'En 1665, Hooke observe des cellules.', status: 'verifiee', aRisque: false, sources: [] }, { claimId: 'c2', text: 'Une cellule a 1 noyau.', status: 'non_verifiable', aRisque: false, sources: [] }],
  };
  it('affiche le corps, le rappel avec « non vérifié », la figure; l\'affirmation ciblée est ouverte', async () => {
    routes['GET /docs/D1'] = () => json(doc);
    open('#/doc/D1/c2');
    expect(await screen.findByRole('heading', { name: 'Le noyau' })).toBeInTheDocument();
    expect(screen.queryByText('Résumé ancien.')).toBeNull();
    const recall = screen.getByRole('region', { name: 'À retenir' });
    expect(within(recall).getAllByRole('listitem')).toHaveLength(2);
    expect(within(recall).getByText('non vérifié')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Une cellule' })).toBeInTheDocument();
    expect(document.querySelector('.card math')).not.toBeNull();
    expect(document.querySelector('.claim.focus')).toHaveTextContent('Une cellule a 1 noyau.');
  });
  it('fiche ancienne: le résumé seul', async () => {
    routes['GET /docs/D1'] = () => json({ ...doc, body: undefined, recall: undefined, figures: undefined });
    open('#/doc/D1');
    expect(await screen.findByText('Résumé ancien.')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'À retenir' })).toBeNull();
  });
});

describe('Télécharger mes données (élève)', () => {
  it('demande, attend, puis donne le lien', async () => {
    routes['GET /scans*'] = () => json({ items: [], inProgress: 0, toReview: 0, facets: { subjects: [], topics: [] } });
    routes['GET /folders*'] = () => json({ items: [] });
    routes['POST /me/export/archive'] = () => json({ exportId: 'E1' }, 202);
    let n = 0;
    routes['GET /me/export/archive/E1'] = () => (n++ < 1 ? json({ status: 'en_cours' }) : json({ status: 'pret', archive: { url: 'https://exports.example/a.zip', expiresAt: '2026-12-01T10:10:00Z', format: 'zip', sizeBytes: 2048000, students: 1, tests: 3, truncated: false, courses: 2, figures: 4 } }));
    open('#/docs');
    await userEvent.click(await screen.findByRole('button', { name: 'Télécharger mes données' }));
    expect(await screen.findByText(/Je prépare ton archive/)).toBeInTheDocument();
    const link = await screen.findByRole('link', { name: /Télécharger l'archive/ }, { timeout: 15000 });
    expect(link).toHaveAttribute('href', 'https://exports.example/a.zip');
    expect(screen.getByText(/2 cours, 4 images/)).toBeInTheDocument();
  }, 30000);
  it('429: message clair', async () => {
    routes['GET /scans*'] = () => json({ items: [], inProgress: 0, toReview: 0, facets: { subjects: [], topics: [] } });
    routes['GET /folders*'] = () => json({ items: [] });
    routes['POST /me/export/archive'] = () => json({ code: 'quota_epuise', message: 'trop' }, 429);
    open('#/docs');
    await userEvent.click(await screen.findByRole('button', { name: 'Télécharger mes données' }));
    expect(await screen.findByText(/3 archives cette heure/)).toBeInTheDocument();
  });
  it('normalizeExport tolère l\'archive à plat', () => {
    expect(normalizeExport({ url: 'https://x/a.zip' }).status).toBe('pret');
    expect(normalizeExport({ status: 'echec' }).status).toBe('echec');
    expect(normalizeExport({ status: 'en_cours' }).status).toBe('en_cours');
  });
});
