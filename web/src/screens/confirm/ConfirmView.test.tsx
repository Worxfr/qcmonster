import { fireEvent, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { App } from '../../App';
import { signOut } from '../../auth';
import { appendTo, findSentence, openSentence, sentenceBtn } from '../../test/review';

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


const blocks = (...ids: string[][]) => ids.map((s, i) => ({ id: `b${i + 1}`, kind: 'paragraphe', sentenceIds: s }));
const fig = (over: Record<string, unknown> = {}) => ({ figureId: 'f1', page: 1, kind: 'schema', alt: 'Une cellule', url: 'data:image/gif;base64,R0lGODlhAQABAAAAACw=', ...over });
const lastSent = () => sent[sent.length - 1] as Record<string, unknown>;

describe('écran de relecture', () => {
  it('compte les phrases et les corrections; corriger se fait à la place de la phrase', async () => {
    stub(tr([['Une phrase.', 'Une autre phrase.']]));
    await open();
    expect(await screen.findByText('2 phrases, 0 corrigée')).toBeInTheDocument();
    await appendTo(1, ' Plus.');
    expect(screen.getByText('2 phrases, 1 corrigée')).toBeInTheDocument();
    expect(sentenceBtn(1)).toHaveAccessibleName(/corrigée/);
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase. Plus.');
    expect(sentenceBtn(1)).toHaveFocus(); // le focus revient sur la phrase
    const box = await openSentence(1);
    await userEvent.click(screen.getByRole('button', { name: /Remettre la version lue/ }));
    expect(screen.getByText('2 phrases, 0 corrigée')).toBeInTheDocument();
    expect(box).not.toBeInTheDocument();
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase.');
  });

  it('Échap annule, Entrée valide, quitter le champ valide; Maj+Entrée ne valide pas', async () => {
    stub(tr([['Une phrase.', 'Une autre phrase.']]));
    await open();
    let box = await openSentence(1);
    await userEvent.type(box, ' ratée{Escape}');
    expect(screen.queryByLabelText('Phrase 1')).toBeNull();
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase.');
    expect(screen.getByText('2 phrases, 0 corrigée')).toBeInTheDocument();
    box = await openSentence(2);
    await userEvent.type(box, ' bis');
    await userEvent.tab(); // perte du focus (vers « Valider ») : brouillon gardé tant qu'on reste dans l'éditeur
    expect(screen.getByLabelText('Phrase 2')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /^Valider/ }));
    expect(sentenceBtn(2)).toHaveTextContent('Une autre phrase. bis');
    box = await openSentence(1);
    await userEvent.type(box, '!');
    await userEvent.click(document.body); // hors de l'éditeur
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase.!');
  });

  it('la zone de texte s\'agrandit avec son contenu (jamais de défilement interne)', async () => {
    const orig = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'scrollHeight');
    Object.defineProperty(HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return Math.max(40, 24 * Math.ceil(((this as HTMLTextAreaElement).value ?? '').length / 40)); } });
    try {
      stub(tr([['x'.repeat(400)]]));
      await open();
      await screen.findByText('1 phrase, 0 corrigée');
      const box = await openSentence(1);
      expect(box.style.height).toBe('240px');
      fireEvent.change(box, { target: { value: 'court' } });
      expect(box.style.height).toBe('40px');
    } finally {
      if (orig) Object.defineProperty(HTMLElement.prototype, 'scrollHeight', orig);
    }
  });

  it('plusieurs pages: tout le texte est un seul document, onglets pour la photo', async () => {
    stub(tr([['Page un.'], ['Page deux.'], ['Page trois.']]));
    await open();
    expect(await screen.findByRole('img', { name: 'Photo de ta page 1' })).toHaveAttribute('src', 'https://photos.example/p1.jpg');
    expect(screen.queryByText(/Page 1 sur/)).toBeNull(); // pas de compteur en double avec les onglets
    expect(await findSentence(3)).toHaveTextContent('Page trois.'); // visible sans changer de page
    await userEvent.click(screen.getByRole('tab', { name: /Page 3/ }));
    expect(screen.getByRole('img', { name: 'Photo de ta page 3' })).toHaveAttribute('src', 'https://photos.example/p3.jpg');
  });

  it('mise en forme gardée: titre, paragraphe sur deux pages, liste, formule', async () => {
    const t = tr([['Le titre', 'Une phrase.'], ['Suite du paragraphe.', 'Premier point', 'Second point', 'a^2+b^2=c^2']]);
    stub({ ...t, blocks: [
      { id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] },
      { id: 'b2', kind: 'paragraphe', sentenceIds: ['p1-s2', 'p2-s1'] },
      { id: 'b3', kind: 'liste', ordered: false, sentenceIds: ['p2-s2', 'p2-s3'] },
      { id: 'b4', kind: 'formule', sentenceIds: ['p2-s4'] },
    ] });
    const { container } = await open();
    await screen.findByText('6 phrases, 0 corrigée');
    expect(container.querySelector('h3.doc-h')).toHaveTextContent('Le titre');
    expect(container.querySelector('p.doc-p')?.querySelectorAll('button.cf-sent')).toHaveLength(2); // un seul paragraphe, deux pages
    expect(container.querySelectorAll('ul.doc-list > li')).toHaveLength(2);
    expect(container.querySelector('.doc-formula math')).not.toBeNull(); // MathML, pas du HTML de KaTeX
    expect(container.querySelector('.doc [style]')).toBeNull(); // la politique de sécurité refuse les styles en ligne
  });

  it('passages douteux: signal avec icône et mot, « C\'est bon » l\'éteint, corriger l\'éteint', async () => {
    const t = tr([['Une phrase.', 'Un mot illisible.', 'Un autre doute.']]);
    stub({ ...t, pages: [{ page: 1, sentences: [{ id: 'p1-s1', text: 'Une phrase.' }, { id: 'p1-s2', text: 'Un mot illisible.', doubt: true }, { id: 'p1-s3', text: 'Un autre doute.', doubt: true }] }] });
    await open();
    expect(await screen.findByText(/2 passages douteux à relire/)).toBeInTheDocument();
    expect(sentenceBtn(2)).toHaveAccessibleName(/lecture douteuse/);
    expect(sentenceBtn(1)).not.toHaveAccessibleName(/douteuse/);
    expect(screen.queryByText(/vérifié/i)).toBeNull(); // jamais le mot « vérifié » à la relecture (sauf le bouton d'envoi)
    await userEvent.click(screen.getByRole('button', { name: /C'est bon pour la phrase 2/ }));
    expect(screen.getByText(/1 passage douteux à relire/)).toBeInTheDocument();
    expect(sentenceBtn(2)).not.toHaveAccessibleName(/douteuse/);
    await appendTo(3, ' voilà');
    expect(screen.queryByText(/passage douteux à relire/)).toBeNull();
    expect(sentenceBtn(3)).toHaveAccessibleName(/corrigée/);
  });

  it('retirer une phrase: barrée, comptée, envoyée dans `removed`, sans correction; la remettre', async () => {
    stub(tr([['Une phrase.', FILL, 'Encore.']]));
    await open();
    await appendTo(3, ' Plus.');
    await openSentence(3);
    await userEvent.click(screen.getByRole('button', { name: /Retirer cette phrase/ }));
    expect(sentenceBtn(3)).toHaveAccessibleName(/retirée/);
    expect(screen.getByText('3 phrases, 0 corrigée, 1 retirée')).toBeInTheDocument();
    await userEvent.click(await findSentence(1));
    await userEvent.click(screen.getByRole('button', { name: /Retirer cette phrase/ }));
    await userEvent.click(await findSentence(1));
    await userEvent.click(screen.getByRole('button', { name: /Remettre cette phrase/ }));
    expect(screen.getByText('3 phrases, 0 corrigée, 1 retirée')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(lastSent()).toEqual({ corrections: [], subject: 'svt', removed: ['p1-s3'] });
  });

  it('retirer la première phrase: la section commence à la première phrase gardée', async () => {
    stub(tr([['Un.', FILL, 'Trois.']]));
    await open();
    await userEvent.click(await findSentence(1));
    await userEvent.click(screen.getByRole('button', { name: /Retirer cette phrase/ }));
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(lastSent()).toMatchObject({ removed: ['p1-s1'], subject: 'svt' });
  });

  it('tout retirer bloque l\'envoi', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    await userEvent.click(await findSentence(1));
    await userEvent.click(screen.getByRole('button', { name: /Retirer cette phrase/ }));
    expect(screen.getByText(/Tu as retiré toutes les phrases/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeDisabled();
  });

  it('les corrections, retraits et choix survivent à un rechargement (sessionStorage) et sont effacés après l\'envoi', async () => {
    stub({ ...tr([['Une phrase.', FILL, 'Trois.']]), figures: [fig()], blocks: [...blocks(['p1-s1'], ['p1-s2'], ['p1-s3']), { id: 'b4', kind: 'figure', figureId: 'f1' }] });
    const first = await open();
    await appendTo(1, ' Corrigée.');
    await userEvent.click(await findSentence(3));
    await userEvent.click(screen.getByRole('button', { name: /Retirer cette phrase/ }));
    await userEvent.click(await screen.findByRole('checkbox', { name: /Garder cette image/ }));
    expect(JSON.parse(sessionStorage.getItem('qcm.confirm.J1') ?? '{}')).toEqual({ 'p1-s1': 'Une phrase. Corrigée.' });
    first.unmount();
    await open();
    expect(await screen.findByText('3 phrases, 1 corrigée, 1 retirée')).toBeInTheDocument();
    expect(screen.getByRole('checkbox', { name: /Garder cette image/ })).toBeChecked();
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(lastSent()).toEqual({ corrections: [{ id: 'p1-s1', text: 'Une phrase. Corrigée.' }], subject: 'svt', removed: ['p1-s3'], figures: [{ figureId: 'f1', keep: true }] });
    expect(sessionStorage.getItem('qcm.confirm.J1')).toBeNull();
    expect(sessionStorage.getItem('qcm.confirm.removed.J1')).toBeNull();
    expect(sessionStorage.getItem('qcm.confirm.figs.J1')).toBeNull();
    expect(localStorage.length).toBe(0);
  });

  it('une phrase vidée est refusée dans le champ et ne change rien', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    const box = await openSentence(1);
    await userEvent.clear(box);
    expect(screen.getByText(/ne peut pas être vide/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Valider/ })).toBeDisabled();
    await userEvent.keyboard('{Enter}');
    expect(screen.getByLabelText('Phrase 1')).toBeInTheDocument(); // Entrée ne valide pas une phrase vide
    await userEvent.click(document.body); // quitter: on revient à la phrase d'origine
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase.');
  });

  it('le HTML reste du texte', async () => {
    stub(tr([['<img src=x onerror=alert(1)> & "guillemets" <b>gras</b>']]));
    const { container } = await open();
    expect(await screen.findByText(/<img src=x onerror=alert\(1\)> & "guillemets" <b>gras<\/b>/)).toBeInTheDocument();
    expect(container.querySelector('b, img.x')).toBeNull();
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
    expect(sentenceBtn(1)).toBeInTheDocument();
  });

  it('job plus a_confirmer au clic: on affiche son état réel, sans erreur brute', async () => {
    stub(tr([['Une phrase.', FILL]]));
    confirmStatus = 409;
    await open();
    await screen.findByText('2 phrases, 0 corrigée');
    jobAfter = { jobId: 'J1', state: 'rejete', pages: 1, createdAt: '2026-12-01T10:00:00Z', message: 'Ce traitement a été annulé.' };
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    expect(await screen.findByText('Ce traitement a été annulé.')).toBeInTheDocument();
  });

  it('erreur d\'envoi lisible, saisies conservées, bouton de nouveau actif', async () => {
    stub(tr([['Une phrase.', FILL]]));
    confirmStatus = 500;
    await open();
    await screen.findByText('2 phrases, 0 corrigée');
    await appendTo(1, '!');
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    const alert = await screen.findByRole('alert');
    expect(within(alert).getByText(/confirmer|erreur|job/i)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeEnabled();
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase.!');
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
    await screen.findByText('1 phrase, 0 corrigée');
    await appendTo(1, ' secret.');
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
    await screen.findByText('1 phrase, 0 corrigée');
    await appendTo(1, ' Gardée.');
    fireEvent.error(screen.getByRole('img', { name: /Photo de ta page 1/ }));
    trFails = 1;
    await userEvent.click(screen.getByRole('button', { name: 'Recharger la photo' }));
    expect(await screen.findByText(/Impossible de recharger la photo/)).toBeInTheDocument();
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase. Gardée.');
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    expect(await screen.findByRole('img', { name: /Photo de ta page 1/ })).toBeInTheDocument();
    expect(sentenceBtn(1)).toHaveTextContent('Une phrase. Gardée.');
  });

  it('onglets de pages: flèches du clavier', async () => {
    stub(tr([['Un.'], ['Deux.'], ['Trois.']]));
    await open();
    const tab1 = await screen.findByRole('tab', { name: /Page 1/ });
    tab1.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(screen.getByRole('tab', { name: /Page 2/ })).toHaveFocus();
    expect(screen.getByRole('tab', { name: /Page 2/ })).toHaveAttribute('aria-selected', 'true');
    await userEvent.keyboard('{End}');
    expect(screen.getByRole('tab', { name: /Page 3/ })).toHaveAttribute('aria-selected', 'true');
  });

  it('petit écran: la photo est repliée par défaut', async () => {
    vi.stubGlobal('matchMedia', () => ({ matches: false, addEventListener() {}, removeEventListener() {} }));
    stub(tr([['Une phrase.']]));
    await open();
    expect(await screen.findByRole('button', { name: 'Voir la photo' })).toHaveAttribute('aria-expanded', 'false');
    expect(screen.queryByRole('img', { name: /Photo de ta page 1/ })).toBeNull();
  });
});

describe('formules à la relecture', () => {
  it('une formule entre $ est rendue en MathML; l\'aperçu suit la frappe', async () => {
    stub(tr([['Soit $x^2$ un carré.']]));
    const { container } = await open();
    await screen.findByText('1 phrase, 0 corrigée');
    expect(container.querySelector('.doc math')).not.toBeNull();
    const box = await openSentence(1);
    await userEvent.type(box, ' Puis $\\frac{{a}{{b}$');
    expect(container.querySelector('.cf-preview math')).not.toBeNull();
  });

  it('une correction avec \\href ou un $ seul est refusée avec un message', async () => {
    stub(tr([['Une phrase.']]));
    await open();
    const box = await openSentence(1);
    await userEvent.type(box, ' $\\href{{javascript:alert(1)}{{x}$');
    expect(await screen.findByText(/« \\href » n'est pas permise/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /^Valider/ })).toBeDisabled();
    await userEvent.clear(box);
    await userEvent.type(box, 'Ça coûte 5 $');
    expect(screen.getByText(/un « \$ » tout seul/)).toBeInTheDocument();
  });

  it('un bloc formule: le champ montre le LaTeX brut', async () => {
    stub({ ...tr([['Un titre', 'E = mc^{2}']]), blocks: [{ id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] }, { id: 'b2', kind: 'formule', sentenceIds: ['p1-s2'] }] });
    const { container } = await open();
    await screen.findByText('2 phrases, 0 corrigée');
    expect(container.querySelector('.doc-formula math')).not.toBeNull();
    const box = await openSentence(2);
    expect(box).toHaveValue('E = mc^{2}');
    expect(container.querySelector('.cf-preview math')).not.toBeNull();
  });
});

describe('figures à la relecture', () => {
  const withFig = (over: Record<string, unknown> = {}) => ({
    ...tr([['Une phrase.', FILL]]),
    figures: [fig(over)],
    blocks: [...blocks(['p1-s1']), { id: 'b2', kind: 'figure', figureId: 'f1' }, ...blocks(['p1-s2']).map((b) => ({ ...b, id: 'b3' }))],
  });

  it('rien n\'est gardé par défaut: figure envoyée avec keep false', async () => {
    stub(withFig());
    await open();
    const box = await screen.findByRole('checkbox', { name: /Garder cette image/ });
    expect(box).not.toBeChecked();
    expect(screen.getByRole('img', { name: 'Une cellule' })).toBeInTheDocument();
    expect(screen.getByText(/effacée avec la photo/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(lastSent()).toEqual({ corrections: [], subject: 'svt', figures: [{ figureId: 'f1', keep: false }] });
  });

  it('figure gardée avec une description corrigée', async () => {
    stub(withFig());
    await open();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Garder cette image/ }));
    const alt = screen.getByLabelText(/Description de l'image/);
    await userEvent.clear(alt);
    await userEvent.type(alt, 'Schéma de la cellule');
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(lastSent()).toMatchObject({ figures: [{ figureId: 'f1', keep: true, alt: 'Schéma de la cellule' }] });
  });

  it('page entière: dite comme telle; image qui ne charge pas: jamais de texte à la place', async () => {
    stub(withFig());
    await open();
    expect(await screen.findByText('Page entière')).toBeInTheDocument();
    fireEvent.error(screen.getByRole('img', { name: 'Une cellule' }));
    expect(screen.getByText(/L'image ne s'affiche pas/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: "Recharger l'image" })).toBeInTheDocument();
  });

  it('figure avec cadre: étiquette du genre', async () => {
    stub(withFig({ box: { x: 0.1, y: 0.1, w: 0.5, h: 0.4 }, caption: 'Fig. 1' }));
    await open();
    expect(await screen.findByText('Schéma')).toBeInTheDocument();
    expect(screen.getByText('Fig. 1')).toBeInTheDocument();
  });
});

describe('503 à la confirmation avec images gardées', () => {
  const withFig = () => ({ ...tr([['Une phrase.', FILL]]), figures: [fig()], blocks: [...blocks(['p1-s1']), { id: 'b2', kind: 'figure', figureId: 'f1' }, { id: 'b3', kind: 'paragraphe', sentenceIds: ['p1-s2'] }] });
  it('message dédié, Réessayer renvoie les mêmes choix, « sans les images » envoie keep false', async () => {
    stub(withFig());
    confirmStatus = 503;
    await open();
    await userEvent.click(await screen.findByRole('checkbox', { name: /Garder cette image/ }));
    await userEvent.click(screen.getByRole('button', { name: /vérifie/i }));
    expect(await screen.findByText(/pas réussi à garder tes images/)).toBeInTheDocument();
    expect(screen.queryByText(/Le job n'est plus/)).toBeNull();
    expect(screen.getByRole('button', { name: /vérifie/i })).toBeEnabled();
    await userEvent.click(screen.getByRole('button', { name: 'Réessayer' }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect((sent[1] as { figures: unknown[] }).figures).toEqual([{ figureId: 'f1', keep: true }]);
    await userEvent.click(screen.getByRole('button', { name: 'Continuer sans garder les images' }));
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect((sent[2] as { figures: unknown[] }).figures).toEqual([{ figureId: 'f1', keep: false }]);
  });
});
