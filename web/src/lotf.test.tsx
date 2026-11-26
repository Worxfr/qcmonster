import { StrictMode } from 'react';
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';

// Compte les rendus des zones de texte pour verifier que le decompte ne re-rend pas la relecture.
const renders = vi.hoisted(() => ({ n: 0 }));
vi.mock('./screens/confirm/AutoGrow', async (orig) => {
  const m = await orig<typeof import('./screens/confirm/AutoGrow')>();
  return { ...m, AutoGrow: (p: Parameters<typeof m.AutoGrow>[0]) => { renders.n++; return m.AutoGrow(p); } };
});

// Lot F: envoi de plusieurs photos, statut, sections, liste, dossiers, cours. API simulee par un routeur local.
const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
type Call = { url: string; method: string; body: unknown };
let calls: Call[] = [];
let routes: Record<string, (c: Call) => Response | undefined> = {};
const T0 = '2026-12-01T10:00:00Z';
const status = (stage: string, extra: object = {}) => ({ stage, pagesDone: 1, pagesTotal: 1, startedAt: T0, ...extra });
const scan = (n: number, extra: object = {}) => ({ scanId: `S${n}`, studentId: 's1', state: 'termine', docId: `D${n}`, title: `Fiche ${n}`, subject: 'svt', topic: `Sujet ${n}`, pages: 2, createdAt: T0, status: status('termine'), ...extra });
const list = (items: object[], extra: object = {}) => ({ items, inProgress: 0, toReview: 0, facets: { subjects: [{ subject: 'svt', count: items.length }], topics: [{ topic: 'Sujet 1', count: 1 }] }, ...extra });
const WORDS = 'mot '.repeat(45).trim();

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
const img = (n: number, type = 'image/jpeg') => new File(['x'], `p${n}.jpg`, { type });
const posts = () => calls.filter((c) => c.method === 'POST' && c.url.includes('s3.example'));

beforeEach(() => {
  calls = [];
  routes = {};
  sessionStorage.clear();
  install();
});
afterEach(() => vi.unstubAllGlobals());

describe('envoi de plusieurs photos', () => {
  const created = () => json({ jobId: 'J1', upload: { url: 'https://s3.example/0', fields: {} }, uploads: [0, 1, 2].map((i) => ({ page: i + 1, url: `https://s3.example/${i}`, fields: { k: String(i) } })), expiresAt: T0, pagesRemaining: 9 });

  it('3 photos: un POST /scans avec les types dans l\'ordre, 3 envois S3, puis l\'écran de statut', async () => {
    routes['POST /scans'] = created;
    routes['POST https://s3.example/*'] = () => new Response(null, { status: 204 });
    await open('#/scan');
    const input = await screen.findByLabelText('Prendre ou choisir des photos');
    await userEvent.upload(input, [img(1), img(2, 'image/png'), img(3)]);
    expect(screen.getAllByRole('img')).toHaveLength(3);
    await userEvent.click(screen.getAllByRole('button', { name: /Descendre/ })[0]); // la page 1 passe en 2
    await userEvent.click(screen.getByRole('button', { name: /Envoyer 3 pages/ }));
    await waitFor(() => expect(window.location.hash).toBe('#/job/J1'));
    const create = calls.find((c) => c.url.endsWith('/scans') && c.method === 'POST')!;
    expect(create.body).toEqual({ pages: 3, contentType: 'image/png', contentTypes: ['image/png', 'image/jpeg', 'image/jpeg'] });
    expect(posts()).toHaveLength(3);
  });

  it('un envoi qui échoue: annulation, pages rendues, vignettes gardées', async () => {
    routes['POST /scans'] = created;
    routes['POST https://s3.example/*'] = (c) => (c.url.endsWith('/1') ? new Response(null, { status: 500 }) : new Response(null, { status: 204 }));
    routes['POST /jobs/J1/cancel'] = () => json({ jobId: 'J1', state: 'rejete', pages: 3, createdAt: T0 });
    await open('#/scan');
    await userEvent.upload(await screen.findByLabelText('Prendre ou choisir des photos'), [img(1), img(2), img(3)]);
    await userEvent.click(screen.getByRole('button', { name: /Envoyer 3 pages/ }));
    expect(await screen.findByText("L'envoi a échoué, tes pages sont rendues. Réessaie.")).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/jobs/J1/cancel'))).toBe(true);
    expect(screen.getAllByRole('img')).toHaveLength(3);
  });

  it('la 11e photo est refusée; un fichier de plus de 5 Mo et un GIF aussi', async () => {
    await open('#/scan');
    const user = userEvent.setup({ applyAccept: false });
    const input = await screen.findByLabelText('Prendre ou choisir des photos');
    const big = new File(['x'], 'gros.jpg', { type: 'image/jpeg' });
    Object.defineProperty(big, 'size', { value: 6 * 1024 * 1024 });
    await user.upload(input, [...Array.from({ length: 11 }, (_, i) => img(i)), big, new File(['x'], 'a.gif', { type: 'image/gif' })]);
    expect(screen.getAllByRole('img')).toHaveLength(10);
    expect(screen.getByText(/10 pages au maximum/)).toBeInTheDocument();
    expect(screen.getByText(/« gros.jpg » est trop lourde/)).toBeInTheDocument();
    expect(screen.getByText(/« a.gif » n'est pas une photo JPEG ou PNG/)).toBeInTheDocument();
  });

  it('plus de pages choisies que de pages restantes: envoi désactivé', async () => {
    routes['GET /me/progress'] = () => json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 2, pagesLimit: 30, resetDate: '2026-12-01' });
    await open('#/scan');
    await userEvent.upload(await screen.findByLabelText('Prendre ou choisir des photos'), [img(1), img(2), img(3)]);
    expect(await screen.findByRole('button', { name: /Envoyer 3 pages/ })).toBeDisabled();
    expect(screen.getByText(/il ne t'en reste que 2/)).toBeInTheDocument();
  });
});

describe('statut d\'un scan', () => {
  it('mode strict (effets montés deux fois): le statut s\'affiche et l\'interrogation repart', async () => {
    routes['GET /jobs/J1'] = () => json({ jobId: 'J1', state: 'transcription', pages: 2, createdAt: T0, status: status('lecture', { pagesDone: 1, pagesTotal: 2 }) });
    sessionStorage.setItem('qcm.mockRole', 'eleve');
    window.location.hash = '#/job/J1';
    render(<StrictMode><App /></StrictMode>);
    expect(await screen.findByText('Pages lues 1 sur 2')).toBeInTheDocument();
  });

  it('frise, pages lues, interrogation qui s\'arrête à terminé, une carte par fiche', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let n = 0;
      routes['GET /jobs/J1'] = () => {
        n++;
        if (n === 1) return json({ jobId: 'J1', state: 'transcription', pages: 5, createdAt: T0, status: status('lecture', { pagesDone: 2, pagesTotal: 5 }) });
        return json({ jobId: 'J1', state: 'termine', pages: 5, createdAt: T0, docId: 'D1', docIds: ['D1', 'D2'], status: status('termine') });
      };
      routes['GET /docs/D1'] = () => json({ docId: 'D1', title: 'Les volcans', subject: 'svt', createdAt: T0, coursId: 'C1', summary: '', claims: [] });
      routes['GET /docs/D2'] = () => json({ docId: 'D2', title: 'La Révolution', subject: 'histoire_geo', createdAt: T0, coursId: 'C1', summary: '', claims: [] });
      await open('#/job/J1');
      expect(await screen.findByText('Pages lues 2 sur 5')).toBeInTheDocument();
      expect(screen.getByText('Lecture').closest('li')).toHaveAttribute('aria-current', 'step');
      await vi.advanceTimersByTimeAsync(3000);
      expect(await screen.findByText(/2 fiches sont prêtes/, undefined, { timeout: 5000 })).toBeInTheDocument();
      expect(screen.getAllByRole('button', { name: /Lire la fiche/ })).toHaveLength(2);
      expect(screen.getByRole('button', { name: 'Voir le cours complet' })).toBeInTheDocument();
      await vi.advanceTimersByTimeAsync(10000);
      expect(n).toBe(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('annulé, délai dépassé et échec se distinguent; « Recommencer » mène au scan', async () => {
    routes['GET /jobs/J1'] = () => json({ jobId: 'J1', state: 'rejete', pages: 1, createdAt: T0, status: status('echec', { message: "Annulé par l'élève" }) });
    await open('#/job/J1');
    expect(await screen.findByText('Annulé')).toBeInTheDocument();
    expect(screen.getByText('Tes pages ont été rendues.')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Recommencer' }));
    expect(window.location.hash).toBe('#/scan');
  });

  it('délai dépassé: message du serveur', async () => {
    routes['GET /jobs/J1'] = () => json({ jobId: 'J1', state: 'expire', pages: 1, createdAt: T0, status: status('echec', { message: 'Pas de confirmation après 12 heures, la photo est supprimée' }) });
    await open('#/job/J1');
    expect(await screen.findByText('Délai dépassé')).toBeInTheDocument();
    expect(screen.getByText(/Pas de confirmation après 12 heures/)).toBeInTheDocument();
  });
});

// ---- relecture avec sections ----
const sent: { corrections: unknown; sections?: Record<string, unknown>[]; subject?: string }[] = [];
function review(opts: { pages: { sentences: { id: string; text: string; pages?: number[] }[] }[]; sug?: object[]; subject?: string }) {
  routes['GET /jobs/J1'] = () => json({ jobId: 'J1', state: 'a_confirmer', pages: opts.pages.length, createdAt: T0, status: status('a_confirmer', { expiresAt: new Date(Date.now() + 9 * 3600e3).toISOString(), expiresSoon: false }) });
  routes['GET /jobs/J1/transcription'] = () => json({
    jobId: 'J1', docType: 'cours', suggestedSubject: opts.subject, suggestedSections: opts.sug,
    pages: opts.pages.map((p, i) => ({ page: i + 1, sentences: p.sentences })),
    photoUrls: opts.pages.map((_, i) => `https://photos.example/${i}.jpg`), photoUrlsExpireAt: T0,
  });
  routes['POST /jobs/J1/confirm'] = (c) => {
    sent.push(c.body as (typeof sent)[number]);
    return json({ jobId: 'J1', state: 'verification', pages: 1, createdAt: T0 });
  };
}
const sn = (p: number, n: number, text = `Phrase ${p}.${n} ${WORDS}`) => ({ id: `p${p}-s${n}`, text });
const cutButtons = () => screen.queryAllByRole('button', { name: /^Couper ici/ });

describe('découper en sections', () => {
  beforeEach(() => { sent.length = 0; });

  it('sans coupe: une section, envoi avec les raccourcis (comportement actuel)', async () => {
    review({ pages: [{ sentences: [sn(1, 1), sn(1, 2)] }], subject: 'svt' });
    await open('#/job/J1');
    await userEvent.click(await screen.findByRole('button', { name: "C'est bon, vérifie !" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0]).toEqual({ corrections: [], subject: 'svt' });
    expect(sent[0].sections).toBeUndefined();
  });

  it('coupe au milieu d\'une page: 2 fiches, sections ordonnées, ignore seulement si vrai', async () => {
    review({ pages: [{ sentences: [sn(1, 1), sn(1, 2), sn(1, 3)] }], subject: 'svt' });
    await open('#/job/J1');
    const bars = await screen.findAllByRole('button', { name: /^Couper ici/ });
    expect(bars).toHaveLength(2);
    await userEvent.click(bars[1]); // avant la phrase 3
    const band2 = screen.getByRole('listitem', { name: 'Fiche 2' });
    await userEvent.selectOptions(within(band2).getByLabelText('Matière'), 'histoire_geo');
    await userEvent.type(within(band2).getByLabelText('Sujet'), 'Rome');
    expect(screen.getByRole('button', { name: "C'est bon, fais 2 fiches" })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: "C'est bon, fais 2 fiches" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].sections).toEqual([{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p1-s3', subject: 'histoire_geo', topic: 'Rome' }]);
    expect(sent[0].subject).toBeUndefined();
  });

  it('une coupe sur la frontière de deux pages: focus sur la matière de la nouvelle fiche; la retirer rend le focus à la coupe', async () => {
    review({ pages: [{ sentences: [sn(1, 1), sn(1, 2)] }, { sentences: [sn(2, 1)] }], subject: 'svt' });
    await open('#/job/J1');
    await screen.findByRole('tab', { name: /Page 2/ });
    await userEvent.click(screen.getByRole('button', { name: /entre deux pages/ }));
    // on passe sur la page de la nouvelle fiche et le focus suit
    expect(screen.getByRole('tab', { name: /Page 2/ })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getAllByLabelText('Matière')[0]).toHaveFocus();
    await userEvent.click(screen.getByRole('button', { name: /Retirer cette coupe/ }));
    expect(screen.getByRole('button', { name: /^Couper ici/ })).toHaveFocus();
    await userEvent.click(screen.getByRole('tab', { name: /Page 1/ }));
    expect(screen.getByRole('button', { name: /entre deux pages/ })).toBeInTheDocument();
  });

  it('coupe au milieu d\'une page: le focus va sur la matière de la nouvelle fiche', async () => {
    review({ pages: [{ sentences: [sn(1, 1), sn(1, 2), sn(1, 3)] }], subject: 'svt' });
    await open('#/job/J1');
    await userEvent.click((await screen.findAllByRole('button', { name: /^Couper ici/ }))[1]);
    expect(screen.getAllByLabelText('Matière')[1]).toHaveFocus();
  });

  it('les dossiers ne sont chargés qu\'une fois, même avec 3 fiches', async () => {
    review({
      pages: [{ sentences: [sn(1, 1), sn(1, 2)] }, { sentences: [sn(2, 1)] }],
      sug: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p1-s2', subject: 'maths' }, { fromSentenceId: 'p2-s1', subject: 'francais' }],
    });
    await open('#/job/J1');
    await screen.findByText("J'ai proposé 3 fiches, change-les si besoin.");
    expect(calls.filter((c) => c.method === 'GET' && c.url.endsWith('/folders'))).toHaveLength(1);
  });

  it('le décompte ne re-rend pas la relecture (ni chaque seconde, ni à chaque interrogation)', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      review({ pages: [{ sentences: [sn(1, 1), sn(1, 2)] }], subject: 'svt' });
      await open('#/job/J1');
      await screen.findByLabelText('Phrase 2');
      await vi.advanceTimersByTimeAsync(3000);
      const before = renders.n;
      await vi.advanceTimersByTimeAsync(8000);
      expect(calls.filter((c) => c.url.endsWith('/jobs/J1')).length).toBeGreaterThan(2);
      expect(renders.n).toBe(before);
    } finally {
      vi.useRealTimers();
    }
  });

  it('annuler le scan efface le texte non envoyé', async () => {
    review({ pages: [{ sentences: [sn(1, 1)] }], subject: 'svt' });
    routes['POST /jobs/J1/cancel'] = () => json({ jobId: 'J1', state: 'rejete', pages: 1, createdAt: T0, status: status('echec', { message: "Annulé par l'élève" }) });
    await open('#/job/J1');
    await userEvent.type(await screen.findByLabelText('Phrase 1'), ' ajout');
    expect(sessionStorage.getItem('qcm.confirm.J1')).not.toBeNull();
    await userEvent.click(screen.getByRole('button', { name: 'Annuler et récupérer mes pages' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Oui, annuler le scan' }));
    expect(await screen.findByText('Annulé')).toBeInTheDocument();
    expect(sessionStorage.getItem('qcm.confirm.J1')).toBeNull();
    expect(sessionStorage.getItem('qcm.confirm.sections.J1')).toBeNull();
  });

  it("FIX-T4 B1: un premier clic sur « Annuler » demande confirmation et n'annule rien; « Non » garde le scan", async () => {
    review({ pages: [{ sentences: [sn(1, 1)] }], subject: 'svt' });
    routes['POST /jobs/J1/cancel'] = () => json({ jobId: 'J1', state: 'rejete', pages: 1, createdAt: T0, status: status('echec', { message: "Annulé par l'élève" }) });
    await open('#/job/J1');
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler et récupérer mes pages' }));
    expect(screen.getByText(/La lecture déjà faite sera perdue/)).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/jobs/J1/cancel'))).toBe(false);
    await userEvent.click(screen.getByRole('button', { name: 'Non, continuer' }));
    expect(screen.getByRole('button', { name: 'Annuler et récupérer mes pages' })).toBeInTheDocument();
    expect(calls.some((c) => c.url.endsWith('/jobs/J1/cancel'))).toBe(false);
  });

  it("FIX-T4: après l'annulation, le compteur de pages est relu", async () => {
    review({ pages: [{ sentences: [sn(1, 1)] }], subject: 'svt' });
    routes['POST /jobs/J1/cancel'] = () => json({ jobId: 'J1', state: 'rejete', pages: 1, createdAt: T0, status: status('echec', { message: "Annulé par l'élève" }) });
    await open('#/job/J1');
    const before = calls.filter((c) => c.url.endsWith('/me/progress')).length;
    await userEvent.click(await screen.findByRole('button', { name: 'Annuler et récupérer mes pages' }));
    await userEvent.click(await screen.findByRole('button', { name: 'Oui, annuler le scan' }));
    await screen.findByText('Annulé');
    await waitFor(() => expect(calls.filter((c) => c.url.endsWith('/me/progress')).length).toBeGreaterThan(before));
  });

  it('un scan expiré efface le texte gardé dans l\'onglet', async () => {
    sessionStorage.setItem('qcm.confirm.J1', JSON.stringify({ 'p1-s1': 'texte' }));
    sessionStorage.setItem('qcm.confirm.sections.J1', '[]');
    routes['GET /jobs/J1'] = () => json({ jobId: 'J1', state: 'expire', pages: 1, createdAt: T0, status: status('echec', { message: 'Pas de confirmation après 12 heures' }) });
    await open('#/job/J1');
    await screen.findByText('Délai dépassé');
    expect(sessionStorage.getItem('qcm.confirm.J1')).toBeNull();
    expect(sessionStorage.getItem('qcm.confirm.sections.J1')).toBeNull();
  });

  it('proposition automatique reprise, modifiable; une partie ignorée; tout ignorer bloque', async () => {
    review({
      pages: [{ sentences: [sn(1, 1), sn(1, 2)] }, { sentences: [sn(2, 1), sn(2, 2)] }],
      sug: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Cellule' }, { fromSentenceId: 'p2-s1', subject: 'histoire_geo' }],
    });
    await open('#/job/J1');
    expect(await screen.findByText("J'ai proposé 2 fiches, change-les si besoin.")).toBeInTheDocument();
    expect(screen.getByDisplayValue('Cellule')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Page 2/ }));
    await userEvent.click(screen.getByLabelText('Ne pas faire de fiche pour cette partie'));
    expect(screen.getByText('Ignorée = gardée dans ton cours complet, sans fiche.')).toBeInTheDocument();
    expect(screen.getByText(/1 fiche \(SVT\), 1 partie ignorée/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('tab', { name: /Page 1/ }));
    await userEvent.click(screen.getByLabelText('Ne pas faire de fiche pour cette partie'));
    expect(screen.getByText('Garde au moins une fiche.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Ne pas faire de fiche pour cette partie'));
    await userEvent.click(screen.getByRole('button', { name: "C'est bon, vérifie !" }));
    await waitFor(() => expect(sent).toHaveLength(1));
    expect(sent[0].sections).toEqual([{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Cellule' }, { fromSentenceId: 'p2-s1', subject: 'histoire_geo', ignore: true }]);
  });

  it('moins de 40 mots gardés: bouton désactivé avec explication', async () => {
    review({ pages: [{ sentences: [{ id: 'p1-s1', text: 'Trop court.' }] }], subject: 'svt' });
    await open('#/job/J1');
    expect(await screen.findByText('Il faut au moins 40 mots dans les parties gardées.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeDisabled();
  });

  it('plafond: 2 fiches pour 1 page, la coupe en trop est grisée avec le motif', async () => {
    review({ pages: [{ sentences: [sn(1, 1), sn(1, 2), sn(1, 3), sn(1, 4)] }], subject: 'svt' });
    await open('#/job/J1');
    await userEvent.click((await screen.findAllByRole('button', { name: /^Couper ici/ }))[0]);
    expect(screen.getAllByText('2 fiches au maximum pour 1 page').length).toBeGreaterThan(0);
    for (const b of cutButtons()) expect(b).toBeDisabled();
  });

  it('6 fiches pour 3 pages, la 7e est refusée', async () => {
    const pages = [1, 2, 3].map((p) => ({ sentences: [1, 2, 3].map((n) => sn(p, n)) }));
    review({ pages, subject: 'svt' });
    await open('#/job/J1');
    await screen.findByRole('tab', { name: /Page 3/ });
    for (const p of [1, 2, 3]) {
      await userEvent.click(screen.getByRole('tab', { name: new RegExp(`Page ${p}`) }));
      for (let k = 0; k < 3; k++) {
        const b = screen.queryAllByRole('button', { name: /^Couper ici/ }).find((x) => !(x as HTMLButtonElement).disabled);
        if (b) await userEvent.click(b);
      }
    }
    expect(screen.getAllByText('6 fiches au maximum pour 3 pages').length).toBeGreaterThan(0);
    expect(cutButtons().every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
  });

  it('phrase sur deux pages: une seule zone de texte, étiquette, ligne de suite, page vide prolongée', async () => {
    review({
      pages: [{ sentences: [sn(1, 1), { id: 'p1-s2', text: `Une phrase coupée ${WORDS}`, pages: [1, 2, 3] }] }, { sentences: [] }, { sentences: [sn(3, 1)] }],
      subject: 'svt',
    });
    await open('#/job/J1');
    expect(await screen.findByText('Pages 1 à 3')).toBeInTheDocument();
    expect(screen.getByText(/on ne la coupe pas/)).toBeInTheDocument();
    expect(screen.getAllByRole('textbox', { name: /Phrase/ })).toHaveLength(2);
    await userEvent.click(screen.getByRole('tab', { name: /Page 2/ }));
    expect(screen.getByText('Cette page prolonge la phrase de la page 1.')).toBeInTheDocument();
    expect(screen.getByText('La première phrase continue la page 1')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Voir la phrase' }));
    expect(screen.getByRole('tab', { name: /Page 1/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('rechargement: coupes et noms gardés dans l\'onglet', async () => {
    review({ pages: [{ sentences: [sn(1, 1), sn(1, 2)] }], subject: 'svt' });
    const first = await open('#/job/J1');
    await userEvent.click((await screen.findAllByRole('button', { name: /^Couper ici/ }))[0]);
    await userEvent.type(screen.getAllByLabelText('Sujet')[1], 'Volcans');
    first.unmount();
    await open('#/job/J1');
    expect(await screen.findByDisplayValue('Volcans')).toBeInTheDocument();
  });
});

describe('liste Mes cours', () => {
  it('filtres et tri dans l\'URL; fiches d\'un même scan regroupées; curseur', async () => {
    const items = [scan(1, { sectionIndex: 0, sectionCount: 2, scanId: 'SG', docIds: ['D1', 'D2'], coursId: 'C1' }), scan(2, { sectionIndex: 1, sectionCount: 2, scanId: 'SG', docId: 'D2', coursId: 'C1' })];
    routes['GET /scans*'] = () => json(list(items, { nextCursor: 'abc' }));
    await open('#/docs');
    expect(await screen.findByRole('link', { name: /Cours du .*, 2 fiches/ })).toHaveAttribute('href', '#/cours/C1');
    await userEvent.selectOptions(screen.getByLabelText('Trier'), 'subject');
    await waitFor(() => expect(window.location.hash).toBe('#/docs?sort=subject'));
    expect(await screen.findByRole('heading', { name: 'SVT' })).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Filtres/ }));
    await userEvent.selectOptions(screen.getByLabelText('Matière'), 'svt');
    await waitFor(() => expect(window.location.hash).toBe('#/docs?subject=svt&sort=subject'));
    const last = calls.filter((c) => c.url.includes('/scans?')).pop()!;
    expect(last.url).toContain('subject=svt');
    expect(last.url).toContain('sort=subject');
    await userEvent.click(screen.getByRole('button', { name: 'Voir plus' }));
    expect(calls.some((c) => c.url.includes('cursor=abc'))).toBe(true);
  });

  it('états vides: aucun cours, aucun résultat (effacer les filtres)', async () => {
    await open('#/docs');
    expect(await screen.findByText(/Scanne ton premier cours/)).toBeInTheDocument();
    window.location.hash = '#/docs?subject=maths';
    expect(await screen.findByText(/Aucun cours ne correspond/)).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Effacer les filtres' })[0]);
    await waitFor(() => expect(window.location.hash).toBe('#/docs'));
  });

  it('sélection multiple: ranger dans un dossier envoie les docIds, dit les cours déplacés', async () => {
    routes['GET /scans*'] = () => json(list([scan(1), scan(2, { folderId: 'F9' })]));
    routes['POST /folders/F1/scans'] = () => new Response(null, { status: 204 });
    await open('#/docs');
    await userEvent.click(await screen.findByRole('button', { name: 'Choisir des cours' }));
    await userEvent.click(screen.getByLabelText('Choisir Fiche 1'));
    await userEvent.click(screen.getByLabelText('Choisir Fiche 2'));
    expect(screen.getByText('2 choisis')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Ranger dans un dossier/ }));
    const bar = screen.getByRole('region', { name: /Actions/ });
    await userEvent.selectOptions(within(bar).getByLabelText('Dossier'), 'F1');
    expect(within(bar).getByText(/1 cours sera déplacé/)).toBeInTheDocument();
    await userEvent.click(within(bar).getByRole('button', { name: 'Ranger ici' }));
    await waitFor(() => expect(calls.find((c) => c.url.endsWith('/folders/F1/scans'))?.body).toEqual({ docIds: ['D1', 'D2'] }));
  });

  it('Mes cours ne demande que les scans terminés (jamais en cours, à relire ni ratés)', async () => {
    routes['GET /scans*'] = () => json(list([scan(1)]));
    await open('#/docs');
    expect(await screen.findByText('Fiche 1')).toBeInTheDocument();
    const urls = calls.filter((c) => c.url.includes('/scans?')).map((c) => c.url);
    expect(urls.length).toBeGreaterThan(0);
    for (const u of urls) expect(u).toContain('status=termine');
    expect(screen.queryByRole('region', { name: /En cours/ })).toBeNull();
  });

  it('Scanner: scans en cours, à relire et ratés; suppression avec confirmation, 404 toléré', async () => {
    let gone = false;
    routes['GET /scans*'] = (c) => json(list(gone ? [] : c.url.includes('status=en_cours')
      ? [{ ...scan(3), scanId: 'S3', state: 'a_confirmer', docId: undefined, title: 'À relire', status: status('a_confirmer', { expiresAt: new Date(Date.now() + 3 * 3600e3).toISOString() }) }]
      : [scan(4, { scanId: 'S4', state: 'echec', docId: undefined, title: 'Raté', status: status('echec', { message: 'Le texte est trop court' }) })]));
    routes['DELETE /scans/S4'] = () => { gone = true; return new Response(null, { status: 204 }); };
    await open('#/scan');
    const box = await screen.findByRole('region', { name: 'Mes scans en cours' });
    expect(within(box).getByText('Le texte est trop court')).toBeInTheDocument();
    expect(within(box).getByRole('button', { name: /Vérifier/ })).toBeInTheDocument();
    await userEvent.click(within(box).getAllByRole('button', { name: /Supprimer/ })[1]);
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false); // rien avant la confirmation
    await userEvent.click(within(box).getByRole('button', { name: 'Non, garder' }));
    expect(calls.some((c) => c.method === 'DELETE')).toBe(false);
    await userEvent.click(within(box).getAllByRole('button', { name: /Supprimer/ })[1]);
    await userEvent.click(within(box).getByRole('button', { name: 'Oui, supprimer' }));
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/scans/S4'))).toBe(true));
    await waitFor(() => expect(screen.queryByText('Le texte est trop court')).toBeNull());
  });

  it('parent: voit l\'étape et les pages des scans en cours de l\'élève, sans bouton ni texte', async () => {
    routes['GET /family/dashboard'] = () => json({ familyPagesLimit: 30, familyPagesRemaining: 20, students: [{ student: { studentId: 's1', pseudo: 'Léo', status: 'actif', pageQuota: 10, schoolLevel: '5eme' }, progress: { xp: 0, level: 1, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 5, pagesLimit: 10, resetDate: '2026-12-01' } }] });
    routes['GET /me'] = () => json({ userId: 'u1', role: 'parent', familyId: 'f1' });
    routes['GET /scans*'] = (c) => json(c.url.includes('status=en_cours')
      ? list([{ ...scan(5), scanId: 'S5', docId: undefined, title: undefined, status: status('lecture', { pagesDone: 1, pagesTotal: 3 }), pages: 3 }])
      : list([]));
    await open('#/eleve/s1', 'parent');
    const box = await screen.findByRole('region', { name: /Scans en cours de l'élève/ });
    expect(within(box).getByText(/1 sur 3 pages/)).toBeInTheDocument();
    expect(within(box).queryByRole('button')).toBeNull();
  });

  it('accueil: les derniers cours ne demandent que les scans terminés', async () => {
    routes['GET /scans*'] = () => json(list([scan(1)]));
    await open('#/');
    await waitFor(() => expect(calls.some((c) => c.url.includes('limit=5') && c.url.includes('status=termine'))).toBe(true));
  });

  it('parent: lecture seule, aucune sélection ni lien vers le texte', async () => {
    routes['GET /family/dashboard'] = () => json({ familyPagesLimit: 30, familyPagesRemaining: 20, students: [{ student: { studentId: 's1', pseudo: 'Léo', status: 'actif', pageQuota: 10, schoolLevel: '5eme' }, progress: { xp: 0, level: 1, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 5, pagesLimit: 10, resetDate: '2026-12-01' } }] });
    routes['GET /me'] = () => json({ userId: 'u1', role: 'parent', familyId: 'f1' });
    routes['GET /scans*'] = (c) => json(list(c.url.includes('status=termine') ? [scan(1)] : []));
    await open('#/eleve/s1', 'parent');
    expect(await screen.findByText('Fiche 1')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Choisir des cours' })).toBeNull();
    expect(calls.some((c) => c.url.includes('/scans?') && c.url.includes('studentId=s1'))).toBe(true);
  });
});

describe('accueil: à relire', () => {
  it('carte absente sans scan à relire; ligne en avant quand l\'échéance approche', async () => {
    await open('#/');
    await screen.findByText(/Salut Test/);
    expect(screen.queryByRole('region', { name: 'À relire' })).toBeNull();
  });
  it('2 scans à relire, le plus pressé en avant', async () => {
    const soon = { ...scan(1), state: 'a_confirmer', docId: undefined, title: undefined, status: status('a_confirmer', { expiresAt: new Date(Date.now() + 81 * 60000).toISOString(), expiresSoon: true }) };
    const later = { ...scan(2), state: 'a_confirmer', docId: undefined, title: undefined, status: status('a_confirmer', { expiresAt: new Date(Date.now() + 9 * 3600e3 + 90000).toISOString(), expiresSoon: false }) };
    routes['GET /scans*'] = (c) => (c.url.includes('a_confirmer') ? json(list([soon, later], { toReview: 2 })) : undefined);
    await open('#/');
    const card = await screen.findByRole('region', { name: 'À relire' });
    expect(within(card).getAllByRole('button', { name: /Relire/ })).toHaveLength(2);
    expect(within(card).getByRole('status')).toHaveTextContent(/Plus que 1 h 20, relis-le vite/);
    expect(within(card).getByText(/Il reste 9 h/)).toBeInTheDocument();
  });
});

describe('cours complet', () => {
  const cours = {
    coursId: 'C1', createdAt: T0, pages: 2,
    sections: [
      { fromSentenceId: 'p1-s1', subject: 'svt', topic: 'Cellule', status: 'fiche', docId: 'D1' },
      { fromSentenceId: 'p2-s1', subject: 'maths', status: 'ignoree' },
    ],
    texts: [{ page: 1, sentences: [{ id: 'p1-s1', text: 'Une cellule.' }] }, { page: 2, sentences: [{ id: 'p2-s1', text: 'Un théorème.' }] }],
  };
  it('supprimer le cours: deux choix explicites, aucun par défaut', async () => {
    routes['GET /cours/C1'] = () => json(cours);
    routes['DELETE /cours/C1*'] = () => new Response(null, { status: 204 });
    await open('#/cours/C1');
    expect(await screen.findByText('Une cellule.')).toBeInTheDocument();
    expect(screen.getByText('Ignorée')).toBeInTheDocument();
    await userEvent.click(screen.getAllByRole('button', { name: 'Supprimer ce cours' })[0]);
    const del = screen.getByRole('button', { name: 'Supprimer' });
    expect(del).toBeDisabled();
    await userEvent.click(screen.getByLabelText('Supprimer le cours ET ses fiches'));
    expect(del).toBeEnabled();
    await userEvent.click(screen.getByLabelText('Supprimer le cours et garder mes fiches'));
    await userEvent.click(del);
    await waitFor(() => expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/cours/C1?fiches=garder'))).toBe(true));
    await waitFor(() => expect(window.location.hash).toBe('#/docs'));
  });
});

describe('dossiers', () => {
  it('nom déjà pris: le code d\'erreur est lu, pas le texte', async () => {
    routes['POST /folders'] = () => json({ code: 'dossier_nom_pris', message: 'x' }, 409);
    await open('#/folders');
    await userEvent.type(await screen.findByLabelText('Nouveau dossier'), 'Maths');
    await userEvent.click(screen.getByRole('button', { name: 'Créer' }));
    expect(await screen.findByText('Tu as déjà un dossier avec ce nom.')).toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: /Contrôle de juin/ })[0]);
    expect(window.location.hash).toBe('#/docs?folderId=F1');
  });
});

describe('liste: interrogation et appui long', () => {
  const running = () => json(list([{ ...scan(1), state: 'transcription', docId: undefined, title: undefined, status: status('lecture', { pagesDone: 1, pagesTotal: 3 }) }], { inProgress: 1 }));

  it('plus aucun appel à /scans après avoir quitté l\'écran, même pendant un chargement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      routes['GET /scans*'] = running;
      const base = globalThis.fetch;
      // seules les requetes de la liste sont lentes: un tour d'interrogation dure 3 s
      vi.stubGlobal('fetch', (...a: Parameters<typeof fetch>) => (String(a[0]).includes('/scans') ? new Promise((res) => setTimeout(() => res(base(...a)), 1500)) : base(...a)));
      const view = await open('#/docs');
      await vi.advanceTimersByTimeAsync(4000); // premier chargement fini
      const scansCalls = () => calls.filter((c) => c.url.includes('/scans')).length;
      await vi.advanceTimersByTimeAsync(3000 + 600); // un tour d'interrogation commence
      view.unmount(); // quitte l'ecran pendant le chargement
      const atUnmount = scansCalls();
      await vi.advanceTimersByTimeAsync(60000);
      expect(scansCalls()).toBeLessThanOrEqual(atUnmount + 2); // au plus les 2 requetes du tour deja en vol
    } finally {
      vi.useRealTimers();
    }
  });

  it('appui long: mode sélection, la carte est choisie et la fiche ne s\'ouvre pas au relâchement', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      routes['GET /scans*'] = () => json(list([scan(1), scan(2)]));
      await open('#/docs');
      const card = (await screen.findByText('Fiche 1')).closest('button')!;
      fireEvent.pointerDown(card);
      await act(async () => { await vi.advanceTimersByTimeAsync(700); });
      fireEvent.pointerUp(card);
      fireEvent.click(card);
      expect(window.location.hash).toBe('#/docs');
      expect(screen.getByLabelText('Choisir Fiche 1')).toBeChecked();
      expect(screen.getByLabelText('Choisir Fiche 2')).not.toBeChecked();
      expect(screen.getByText('1 choisi')).toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });

  it('un clic simple ouvre toujours la fiche', async () => {
    routes['GET /scans*'] = () => json(list([scan(1)]));
    await open('#/docs');
    await userEvent.click((await screen.findByText('Fiche 1')).closest('button')!);
    expect(window.location.hash).toBe('#/doc/D1');
  });
});
