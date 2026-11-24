import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import axe from 'axe-core';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from './App';
import { MOCK_URL, startMock, stopMock } from './test/mock-server';

// Parcours des ecrans contre l'API simulee (Prism). Seuls l'envoi S3 et l'etat d'un job sont substitues:
// Prism renvoie des exemples fixes, donc l'etat "a_confirmer" ne peut pas venir du mock.
const realFetch = globalThis.fetch;
let uploads = 0;
let jobState: string | null = null;
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
    return realFetch(input, init);
  }) as typeof fetch;
});
afterAll(() => {
  globalThis.fetch = realFetch;
  stopMock();
});
beforeEach(() => {
  jobState = null;
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
    expect(await screen.findByText('La photosynthese')).toBeInTheDocument();
    // l'exemple du contrat (110 XP au niveau 2) est sous le seuil 150: la barre est a 0, sans sortir de [0, 100]
    expect(screen.getByRole('progressbar', { name: /niveau suivant/i })).toHaveAttribute('aria-valuenow', '0');
    await a11y(view.container);
  });

  it('scan: envoi d\'une photo puis suivi du traitement', async () => {
    const { user, view } = await enter('eleve');
    await goTo('/scan');
    const input = await screen.findByLabelText(/Choisir une photo/i);
    await user.upload(input, new File(['x'], 'cours.jpg', { type: 'image/jpeg' }));
    await waitFor(() => expect(window.location.hash).toMatch(/^#\/job\//));
    expect(uploads).toBe(1);
    expect(await screen.findByRole('list', { name: /Étapes/ })).toBeInTheDocument();
    expect(screen.getByText(/Lecture du cours/)).toHaveAttribute('aria-current', 'step');
    await a11y(view.container);
  });

  it('refuse un fichier d\'un mauvais type sans appeler l\'API', async () => {
    const { view } = await enter('eleve');
    await goTo('/scan');
    const input = await screen.findByLabelText(/Choisir une photo/i);
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
    await user.type(box, ' Oui.');
    await a11y(view.container);
    jobState = 'verification';
    await user.click(screen.getByRole('button', { name: /vérifie/i }));
    expect(await screen.findByText(/Vérification des faits/)).toHaveAttribute('aria-current', 'step');
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
    expect(screen.getByText(/Premier scan/)).toBeInTheDocument();
    await a11y(view.container);
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
    const box = await screen.findByLabelText("Lien d'activation");
    expect(box).toHaveValue('https://app.example.invalid/activer#token=example');
  });
});

describe('donnees du front', () => {
  it('aucune reponse correcte dans la session avant de repondre', async () => {
    const r = await realFetch(`${MOCK_URL}/docs/d1/session`, { headers: { authorization: 'Bearer x' } });
    const text = JSON.stringify(await r.json());
    expect(text).not.toMatch(/correctAnswer|"answer"|"solution"|"correct"/);
  });
});
