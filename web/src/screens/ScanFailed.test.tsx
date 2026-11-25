import { render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { App } from '../App';

// Écran d'un traitement en échec (T2 B2): plus de « en route » ni d'étapes vides, message accentué.
describe('écran d\'échec du traitement', () => {
  afterEach(() => vi.unstubAllGlobals());
  it('titre d\'échec, aucune étape, message du serveur, bouton Réessayer', async () => {
    sessionStorage.setItem('qcm.mockRole', 'eleve');
    vi.stubGlobal('fetch', async () => new Response(JSON.stringify({ jobId: 'J1', state: 'echec', message: 'Le traitement a échoué, réessaie', costCents: 1 }), { status: 200, headers: { 'content-type': 'application/json' } }));
    window.location.hash = '#/job/J1';
    render(<App />);
    expect(await screen.findByText('Le traitement a échoué, réessaie')).toBeInTheDocument();
    expect(screen.queryByText('Ton cours est en route')).toBeNull();
    expect(screen.getByRole('heading', { name: /pas pu être traité/ })).toBeInTheDocument();
    expect(screen.queryByRole('list', { name: /Étapes/ })).toBeNull();
    expect(screen.getByRole('button', { name: 'Réessayer' })).toBeInTheDocument();
  });
});
