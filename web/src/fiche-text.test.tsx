import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { buildParas } from './screens/FicheText';
import type { Claim } from './types';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
let reports: unknown[] = [];
let doc: Record<string, unknown> = {};

const src = { passageId: 'x1', titre: 'Cellule', site: 'fr.wikipedia.org', url: 'https://fr.wikipedia.org/wiki/Cellule', extrait: 'La cellule est l\'unité de base.', niveau: 1 };
const claim = (claimId: string, text: string, status: Claim['status'], sources = [src]): Claim => ({ claimId, text, status, aRisque: false, sources });
const claims = [
  claim('c1', 'La cellule est l\'unité du vivant.', 'verifiee'),
  claim('c2', 'Elle contient $E=mc^2$ environ.', 'non_verifiable', []),
  claim('c3', 'Le noyau porte l\'ADN.', 'verifiee'),
  claim('c4', 'Je pense que c\'est joli.', 'non_factuelle', []),
  claim('c5', 'Une cellule a 9 noyaux.', 'erreur'),
];

beforeEach(() => {
  reports = [];
  doc = { docId: 'D1', title: 'La cellule', subject: 'svt', createdAt: '2026-12-01T10:00:00Z', summary: 'Résumé modèle.', claims,
    body: [{ heading: 'Début', text: 'TEXTE LIBRE DU MODELE', claimIds: ['c1', 'c2', 'zz'] }, { text: 'Seconde partie.', claimIds: ['c3', 'c4'] }, { text: 'Paragraphe sans affirmation.' }] };
  sessionStorage.setItem('qcm.mockRole', 'eleve');
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input).replace(/^https?:\/\/[^/]+/, '');
    if (url === '/me') return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Test' });
    if (url === '/me/progress') return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 5, pagesLimit: 10, resetDate: '2026-12-01' });
    if (url === '/docs/D1') return json(doc);
    if (url === '/docs/D1/report' && init?.method === 'POST') { reports.push(JSON.parse(String(init.body))); return json({ reportId: 'r1', status: 'ouvert' }, 201); }
    return json({ items: [] });
  });
});
afterEach(() => vi.unstubAllGlobals());
const open = (hash: string) => { window.location.hash = hash; return render(<App />); };

describe('buildParas', () => {
  it('rend chaque paragraphe depuis ses claimIds, dans l\'ordre, sans id inconnu ni doublon; reste en fin de fiche', () => {
    const p = buildParas({ summary: 's', claims, body: [{ text: 'x', claimIds: ['c2', 'c1', 'c2', 'zz'] }, { text: 'libre' }] } as never);
    expect(p.map((q) => q.claims.map((c) => c.claimId))).toEqual([['c2', 'c1'], [], ['c3', 'c4', 'c5']]);
    expect(p[1].plain).toBe('libre');
    expect(p[2].heading).toBe('Autres points contrôlés');
  });
  it('affirmation citée par deux paragraphes: première occurrence seulement; paragraphe entièrement répété omis', () => {
    const p = buildParas({ summary: 's', claims, body: [{ text: 'a', claimIds: ['c1', 'c2'] }, { text: 'b', claimIds: ['c2', 'c3'] }, { text: 'c', claimIds: ['c1'] }] } as never);
    expect(p.map((q) => q.claims.map((c) => c.claimId))).toEqual([['c1', 'c2'], ['c3'], ['c4', 'c5']]);
  });
  it('ancien format: un seul paragraphe fait des affirmations; sans affirmation, le résumé', () => {
    expect(buildParas({ summary: 's', claims } as never)).toHaveLength(1);
    expect(buildParas({ summary: 'seul', claims: [] } as never)).toEqual([{ key: 'p0', claims: [], plain: 'seul' }]);
  });
});

describe('fiche en texte continu', () => {
  it('états colorés avec libellé, texte du modèle remplacé par les affirmations, formule rendue, pas de lien sous chaque phrase', async () => {
    open('#/doc/D1');
    expect(await screen.findByRole('heading', { name: 'Début' })).toBeInTheDocument();
    expect(screen.queryByText(/TEXTE LIBRE DU MODELE/)).toBeNull();
    expect(screen.getByRole('button', { name: /unité du vivant.*vérifié, ouvrir/ })).toHaveClass('seg-verifiee');
    expect(screen.getByRole('button', { name: /environ.*non vérifiable/ })).toHaveClass('seg-non_verifiable');
    expect(screen.getByRole('button', { name: /9 noyaux.*erreur/ })).toHaveClass('seg-erreur');
    expect(screen.getByText(/Je pense que c'est joli/).closest('.seg')).toBeNull(); // non factuelle: texte simple
    expect(screen.getByText('Paragraphe sans affirmation.')).toBeInTheDocument();
    expect(document.querySelector('.fiche-body math')).not.toBeNull();
    expect(screen.queryByText(/Voir les sources/)).toBeNull();
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('clic: surimpression avec état, sources sûres, signalement; Echap rend le focus au segment', async () => {
    const user = userEvent.setup();
    open('#/doc/D1');
    const seg = await screen.findByRole('button', { name: /unité du vivant/ });
    await user.click(seg);
    const dlg = screen.getByRole('dialog');
    expect(seg).toHaveAttribute('aria-expanded', 'true');
    expect(within(dlg).getByText('Vérifié')).toBeInTheDocument();
    const link = within(dlg).getByRole('link', { name: /Cellule/ });
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    await user.click(within(dlg).getByRole('button', { name: 'Signaler une erreur' }));
    await user.type(screen.getByLabelText(/Qu'est-ce qui est faux/), 'Faux.');
    await user.click(screen.getByRole('button', { name: 'Envoyer' }));
    expect(await screen.findByText(/Merci/)).toBeInTheDocument();
    expect(reports).toEqual([{ comment: 'Faux.', claimId: 'c1' }]);
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    await vi.waitFor(() => expect(seg).toHaveFocus());
    expect(seg).toHaveAttribute('aria-expanded', 'false');
  });

  it('clavier: Entrée ouvre, un autre segment remplace, clic à l\'extérieur ferme; non vérifiable sans source', async () => {
    const user = userEvent.setup();
    open('#/doc/D1');
    const a = await screen.findByRole('button', { name: /environ/ });
    a.focus();
    await user.keyboard('{Enter}');
    expect(screen.getByRole('dialog')).toHaveTextContent(/Non vérifiable/);
    expect(screen.getByRole('dialog')).toHaveTextContent(/Pas de source/);
    await user.click(screen.getByRole('button', { name: /porte l'ADN/ }));
    expect(screen.getAllByRole('dialog')).toHaveLength(1);
    expect(screen.getByRole('dialog')).toHaveTextContent(/Vérifié/);
    await user.click(document.body);
    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('source dont l\'URL est javascript: affichée en texte, sans lien', async () => {
    doc.claims = [claim('c1', 'La cellule est l\'unité du vivant.', 'verifiee', [{ ...src, url: 'javascript:alert(1)', titre: 'Piège' }])];
    doc.body = [{ text: 'x', claimIds: ['c1'] }];
    const user = userEvent.setup();
    open('#/doc/D1');
    await user.click(await screen.findByRole('button', { name: /unité du vivant/ }));
    const dlg = screen.getByRole('dialog');
    expect(within(dlg).getByText(/Piège/)).toBeInTheDocument();
    expect(within(dlg).queryByRole('link')).toBeNull();
    expect(dlg.querySelector('a')).toBeNull();
  });

  it('légende: ✓, ? et ✗ expliqués', async () => {
    open('#/doc/D1');
    expect(await screen.findByText(/erreur\./)).toBeInTheDocument();
  });

  it('ancien format (sans body): texte continu à partir des affirmations, même interaction', async () => {
    delete doc.body;
    const user = userEvent.setup();
    open('#/doc/D1');
    await user.click(await screen.findByRole('button', { name: /porte l'ADN/ }));
    expect(screen.getByRole('dialog')).toHaveTextContent(/Vérifié/);
    expect(document.querySelectorAll('.fiche-body > div')).toHaveLength(1);
  });
});
