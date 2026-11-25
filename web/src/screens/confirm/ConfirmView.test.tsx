import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { signOut } from '../../auth';

const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { 'content-type': 'application/json' } });
const sent: unknown[] = [];
const FILL = 'mot '.repeat(45).trim();
let jobAfter: Record<string, unknown> | null = null;
let confirmStatus = 200;
let trFails = 0;

function tr(pages: string[][]) {
  return {
    jobId: 'J1',
    docType: 'cours',
    pages: pages.map((ss, p) => ({ page: p + 1, sentences: ss.map((text, i) => ({ id: `p${p + 1}-s${i + 1}`, text })) })),
    suggestedSubject: 'svt',
    photoUrls: pages.map((_, p) => `https://photos.example/p${p + 1}.jpg`),
    photoUrlsExpireAt: '2026-12-01T10:05:00Z',
  };
}

function stub(t: unknown) {
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith('/me')) return json({ userId: 'u1', role: 'eleve', familyId: 'f1', studentId: 's1', pseudo: 'Test' });
    if (url.endsWith('/me/progress')) return json({ xp: 0, level: 0, streakDays: 0, freezes: 0, stage: 1, pagesRemaining: 5, pagesLimit: 10, resetDate: '2026-12-01' });
    if (url.endsWith('/transcription')) return trFails-- > 0 ? json({ code: 'erreur', message: 'Réseau coupé' }, 500) : json(t);
    if (url.endsWith('/confirm')) {
      sent.push(JSON.parse(String(init?.body)));
      if (confirmStatus !== 200) return json({ code: 'etat_invalide', message: "Le job n'est plus a confirmer" }, confirmStatus);
      return json({ jobId: 'J1', state: 'verification', pages: 1, createdAt: '2026-12-01T10:00:00Z' });
    }
    if (/\/jobs\/J1$/.test(url)) return json(jobAfter ?? { jobId: 'J1', state: 'a_confirmer', pages: 1, createdAt: '2026-12-01T10:00:00Z' });
    return json({}, 404);
  });
}
async function open() {
  sessionStorage.setItem('qcm.mockRole', 'eleve');
  window.location.hash = '#/job/J1';
  return render(<App />);
}

beforeEach(() => {
  sent.length = 0;
  jobAfter = null;
  confirmStatus = 200;
  trFails = 0;
  sessionStorage.clear();
  sessionStorage.setItem('qcm.mockRole', 'eleve');
});
afterEach(() => vi.unstubAllGlobals());

describe('écran de relecture', () => {
  it('compte les phrases et les corrections, avec numéros et état', async () => {
    stub(tr([['Une phrase.', 'Une autre phrase.']]));
    await open();
    expect(await screen.findByText('2 phrases, 0 corrigée')).toBeInTheDocument();
    const box = screen.getByLabelText('Phrase 1');
    await userEvent.type(box, ' Plus.');
    expect(screen.getByText('2 phrases, 1 corrigée')).toBeInTheDocument();
    expect(screen.getByText('Modifiée')).toBeInTheDocument();
    expect(screen.getByText('Inchangée')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Remettre la version lue/ }));
    expect(screen.getByText('2 phrases, 0 corrigée')).toBeInTheDocument();
    expect(box).toHaveValue('Une phrase.');
  });

  it('la zone de texte s\'agrandit avec son contenu (jamais de défilement interne)', async () => {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return Math.max(40, 24 * Math.ceil(((this as HTMLTextAreaElement).value ?? '').length / 40)); } });
    try {
      stub(tr([['x'.repeat(400)]]));
      await open();
      const box = (await screen.findByLabelText('Phrase 1')) as HTMLTextAreaElement;
      expect(box.style.height).toBe('240px');
      fireEvent.change(box, { target: { value: 'court' } });
      expect(box.style.height).toBe('40px');
    } finally {
      if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', orig);
    }
  });

  it('plusieurs pages: compteur, onglets, photo de la page choisie', async () => {
    stub(tr([['Page un.'], ['Page deux.'], ['Page trois.']]));
    await open();
    expect(await screen.findByText('Page 1 sur 3')).toBeInTheDocument();
    expect(screen.getByRole('img', { name: 'Photo de ta page 1' })).toHaveAttribute('src', 'https://photos.example/p1.jpg');
    await userEvent.click(screen.getByRole('tab', { name: /Page 3/ }));
    expect(screen.getByText('Page 3 sur 3')).toBeInTheDocument();
    expect(screen.getByLabelText('Phrase 3')).toHaveValue('Page trois.');
    expect(screen.getByRole('img', { name: 'Photo de ta page 3' })).toHaveAttribute('src', 'https://photos.example/p3.jpg');
  });

  it('les corrections survivent à un rechargement (sessionStorage) et sont effacées après l\'envoi', async () => {
    stub(tr([['Une phrase.', FILL]]));
    const first = await open();
    await userEvent.type(await screen.findByLabelText('Phrase 1'), ' Corrigée.');
    expect(JSON.parse(sessionStorage.getItem('qcm.confirm.J1') ?? '{}')).toEqual({ 'p1-s1': 'Une phrase. Corrigée.' });
    first.unmount();
    await open();
    expect(await screen.findByLabelText('Phrase 1')).toHaveValue('Une phrase. Corrigée.');
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    await vi.waitFor(() => expect(sent).toEqual([{ corrections: [{ id: 'p1-s1', text: 'Une phrase. Corrigée.' }], subject: 'svt' }]));
    expect(sessionStorage.getItem('qcm.confirm.J1')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('une phrase vidée bloque l\'envoi (le serveur refuse les phrases vides)', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    await userEvent.clear(await screen.findByLabelText('Phrase 1'));
    expect(screen.getByText('Une phrase ne peut pas être vide.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeDisabled();
  });

  it('le HTML reste du texte', async () => {
    stub(tr([['<img src=x onerror=alert(1)> & "guillemets" <b>gras</b>']]));
    const { container } = await open();
    expect(await screen.findByLabelText('Phrase 1')).toHaveValue('<img src=x onerror=alert(1)> & "guillemets" <b>gras</b>');
    expect(container.querySelector('b')).toBeNull();
  });

  it('page sans phrase: message clair', async () => {
    stub(tr([[]]));
    await open();
    expect(await screen.findByText(/Je n'ai rien lu sur ta photo/)).toBeInTheDocument();
  });

  it('photo qui ne charge pas: message et bouton pour recharger', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    fireEvent.error(await screen.findByRole('img', { name: /Photo de ta page 1/ }));
    expect(screen.getByText(/lien a peut-être expiré/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Recharger la photo' })).toBeInTheDocument();
    expect(screen.getByLabelText('Phrase 1')).toBeInTheDocument();
  });

  it('job plus a_confirmer au clic: on affiche son état réel, sans erreur brute', async () => {
    stub(tr([['Une phrase.', FILL]]));
    confirmStatus = 409;
    await open();
    await screen.findByLabelText('Phrase 1');
    jobAfter = { jobId: 'J1', state: 'rejete', pages: 1, createdAt: '2026-12-01T10:00:00Z', message: 'Ce traitement a été annulé.' };
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    expect(await screen.findByText('Ce traitement a été annulé.')).toBeInTheDocument();
  });

  it('erreur d\'envoi lisible, saisies conservées, bouton de nouveau actif', async () => {
    stub(tr([['Une phrase.', FILL]]));
    confirmStatus = 500;
    await open();
    await userEvent.type(await screen.findByLabelText('Phrase 1'), '!');
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/confirmer|erreur|job/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeEnabled();
    expect(screen.getByLabelText('Phrase 1')).toHaveValue('Une phrase.!');
  });

  it('zoom: boutons + et −', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    await userEvent.click(await screen.findByRole('button', { name: 'Zoomer' }));
    expect(screen.getByText('125 %')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Dézoomer' }));
    expect(screen.getByText('100 %')).toBeInTheDocument();
  });

  it('déconnexion: les corrections non envoyées sont effacées', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    await userEvent.type(await screen.findByLabelText('Phrase 1'), ' secret.');
    expect(sessionStorage.getItem('qcm.confirm.J1')).not.toBeNull();
    signOut();
    expect(sessionStorage.getItem('qcm.confirm.J1')).toBeNull();
  });

  it('plein écran: dialogue modal, focus piégé, reste de la page inerte, focus rendu à la fermeture', async () => {
    stub(tr([['Une phrase.']]));
    const { container } = await open();
    const opener = await screen.findByRole('button', { name: 'Plein écran' });
    await userEvent.click(opener);
    const dialog = screen.getByRole('dialog');
    expect(dialog.parentElement).toBe(document.body); // portail: hors du bloc sticky
    expect(screen.getByRole('button', { name: 'Fermer' })).toHaveFocus();
    expect((container as HTMLElement & { inert?: boolean }).inert).toBe(true);
    for (let i = 0; i < 6; i++) {
      await userEvent.tab();
      expect(dialog.contains(document.activeElement)).toBe(true);
    }
    await userEvent.keyboard('{Escape}');
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('button', { name: 'Plein écran' })).toHaveFocus();
    expect((container as HTMLElement & { inert?: boolean }).inert).toBe(false);
  });

  it('aucune phrase: envoi désactivé, explication et bouton pour refaire la photo', async () => {
    stub(tr([[]]));
    await open();
    expect(await screen.findByRole('button', { name: /vérifie/i })).toBeDisabled();
    expect(screen.getByText(/aucun texte à vérifier/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Refaire la photo' }));
    expect(window.location.hash).toBe('#/scan');
  });

  it('rechargement de la photo raté: l\'écran et les saisies restent, bouton Réessayer', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    await userEvent.type(await screen.findByLabelText('Phrase 1'), ' Gardée.');
    fireEvent.error(screen.getByRole('img', { name: /Photo de ta page 1/ }));
    trFails = 1;
    await userEvent.click(screen.getByRole('button', { name: 'Recharger la photo' }));
    expect(await screen.findByText(/Impossible de recharger la photo/)).toBeInTheDocument();
    expect(screen.getByLabelText('Phrase 1')).toHaveValue('Une phrase. Gardée.');
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('img', { name: /Photo de ta page 1/ })).toBeInTheDocument();
    expect(screen.getByLabelText('Phrase 1')).toHaveValue('Une phrase. Gardée.');
  });

  it('onglets de pages: flèches du clavier, état de la phrase lié au champ', async () => {
    stub(tr([['Un.'], ['Deux.'], ['Trois.']]));
    await open();
    const tab1 = await screen.findByRole('tab', { name: /Page 1/ });
    tab1.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Page 2/ })).toHaveFocus();
    expect(screen.getByRole('tab', { name: /Page 2/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Page 3/ })).toHaveAttribute('aria-selected', 'true');
    const box = screen.getByLabelText('Phrase 3');
    expect(box).toHaveAccessibleDescription('Inchangée');
  });

  it('petit écran: la photo est repliée par défaut', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    stub(tr([['Une phrase.']]));
    await open();
    expect(await screen.findByRole('button', { name: 'Voir la photo' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('img', { name: /Photo de ta page 1/ })).toBeNull();
  });
});
