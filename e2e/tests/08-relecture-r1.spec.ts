import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// R1-C: relecture en paragraphes, couleurs, édition en place, figures, formules, cours coloré, fiche, export.
// Les réponses de l'API sont fabriquées ici (page.route) à partir du contrat 1.5.0: aucune photo ni donnée réelle.
const SHOTS = process.env.R1C_SHOTS; // dossier de captures facultatif (relues à la main)
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

const svg = (body: string, w = 600, h = 400) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${body}</svg>`)}`;
const PAGE = svg('<rect width="600" height="400" fill="#fffdf5"/><g fill="#cbd5e1"><rect x="40" y="40" width="300" height="14" rx="7"/><rect x="40" y="80" width="500" height="10" rx="5"/><rect x="40" y="105" width="480" height="10" rx="5"/><rect x="40" y="130" width="510" height="10" rx="5"/><rect x="40" y="155" width="420" height="10" rx="5"/></g><ellipse cx="300" cy="290" rx="130" ry="80" fill="#d1fae5" stroke="#0f766e" stroke-width="5"/><circle cx="300" cy="290" r="34" fill="#a78bfa" stroke="#6d28d9" stroke-width="4"/>');
const CELL = svg('<rect width="600" height="400" fill="#ffffff"/><ellipse cx="300" cy="200" rx="250" ry="160" fill="#d1fae5" stroke="#0f766e" stroke-width="6"/><circle cx="300" cy="200" r="62" fill="#c4b5fd" stroke="#6d28d9" stroke-width="5"/><text x="300" y="206" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#2b2150">noyau</text><text x="300" y="60" font-family="sans-serif" font-size="22" text-anchor="middle" fill="#2b2150">membrane</text><text x="470" y="270" font-family="sans-serif" font-size="22" fill="#2b2150">cytoplasme</text>');

const S = (id: string, text: string, extra: object = {}) => ({ id, text, ...extra });
const SENTENCES = [
  S('p1-s1', 'La cellule'),
  S('p1-s2', 'La cellule est la plus petite unité du vivant. Elle est entourée par une membrane qui protège son contenu.'),
  S('p1-s3', 'Le noyau contient l\'ADN et il dirige la vie de la cellule.', { doubt: true }),
  S('p1-s4', 'Les cellules animales et végétales ont des tailles très différentes et on les observe avec un microscope.'),
  S('p1-s5', 'Parties d\'une cellule'),
  S('p2-s1', 'la membrane'),
  S('p2-s2', 'le cytoplasme'),
  S('p2-s3', 'le noyau'),
  S('p2-s4', 'Pour mesurer, on utilise $1\\ \\mu m = 10^{-6}\\ m$ comme unité de longueur.'),
  S('p2-s5', 'E = mc^{2}'),
  S('p2-s6', 'Une cellule végétale possède aussi une paroi rigide et des chloroplastes, ce qui lui donne sa couleur verte.'),
];
const BLOCKS = [
  { id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] },
  { id: 'b2', kind: 'paragraphe', sentenceIds: ['p1-s2', 'p1-s3', 'p1-s4'] },
  { id: 'b3', kind: 'figure', figureId: 'f1' },
  { id: 'b4', kind: 'titre', level: 2, sentenceIds: ['p1-s5'] },
  { id: 'b5', kind: 'liste', ordered: false, sentenceIds: ['p2-s1', 'p2-s2', 'p2-s3'] },
  { id: 'b6', kind: 'paragraphe', sentenceIds: ['p2-s4'] },
  { id: 'b7', kind: 'formule', sentenceIds: ['p2-s5'] },
  { id: 'b8', kind: 'paragraphe', sentenceIds: ['p2-s6'] },
];
const TRANSCRIPTION = {
  jobId: 'J1', docType: 'cours', suggestedSubject: 'svt', suggestedTopic: 'La cellule',
  pages: [{ page: 1, sentences: SENTENCES.slice(0, 5) }, { page: 2, sentences: SENTENCES.slice(5) }],
  blocks: BLOCKS,
  figures: [{ figureId: 'f1', page: 1, kind: 'schema', alt: 'Schéma d\'une cellule avec sa membrane, son cytoplasme et son noyau', caption: 'Fig. 1 : une cellule', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.35 }, url: CELL }],
  photoUrls: [PAGE, PAGE], photoUrlsExpireAt: '2099-01-01T00:00:00Z',
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
const ok = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });

async function routes(page: Page, confirmBodies: unknown[]) {
  await page.route('**/jobs/J1', (r) => r.fulfill(ok({ jobId: 'J1', state: 'a_confirmer', pages: 2, createdAt: '2026-12-01T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', status: { stage: 'a_confirmer', pagesDone: 2, pagesTotal: 2, startedAt: '2026-12-01T10:00:00Z' } })));
  await page.route('**/jobs/J1/transcription', (r) => r.fulfill(ok(TRANSCRIPTION)));
  await page.route('**/jobs/J1/confirm', (r) => {
    confirmBodies.push(r.request().postDataJSON());
    return r.fulfill(ok({ jobId: 'J1', state: 'verification', pages: 2, createdAt: '2026-12-01T10:00:00Z', status: { stage: 'verification', pagesDone: 2, pagesTotal: 2, startedAt: '2026-12-01T10:00:00Z' } }));
  });
}

test.describe('Relecture en paragraphes (R1-C)', () => {
  test.skip(!isMock, 'Mode mock seulement (réponses fabriquées)');
  test.beforeEach(async () => {
    await fake.reset();
  });

  test('document, douteux, correction en place, retrait, figure gardée par choix, formules, envoi', async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await login(page, 'eleve');
    await routes(page, bodies);
    await page.goto('/#/job/J1');
    await expect(page.getByRole('heading', { name: "Vérifie ce que j'ai lu" })).toBeVisible();
    await expect(page.locator('.doc [style]')).toHaveCount(0); // la politique de sécurité refuse les styles en ligne (avant toute capture)
    await shot(page, '1-relecture-pc');

    // mise en forme gardée: titre, paragraphe d'une seule pièce, liste, formule en MathML
    await expect(page.locator('h3.doc-h')).toContainText('La cellule');
    await expect(page.locator('p.doc-p').first().locator('button.cf-sent')).toHaveCount(3);
    await expect(page.locator('ul.doc-list > li')).toHaveCount(3);
    await expect(page.locator('.doc-formula math')).toHaveCount(1);
    await expect(page.locator('.doc math')).toHaveCount(2);

    // couleurs de LECTURE: un passage douteux, jamais le mot « vérifié »
    await expect(page.getByText('1 passage douteux à relire')).toBeVisible();
    await expect(page.locator('button.cf-sent.is-doubt')).toHaveCount(1);
    await expect(page.locator('.confirm').getByText(/vérifié/i)).toHaveCount(0);

    // édition en place: Entrée valide, Échap annule
    await page.locator('button.cf-sent', { hasText: 'plus petite unité' }).click();
    const box = page.locator('textarea.cf-text');
    await expect(box).toBeFocused();
    await shot(page, '2-edition-en-place-pc');
    await box.press('End');
    await box.pressSequentially(' Elle est invisible à l\'œil nu.');
    await box.press('Enter');
    await expect(page.locator('button.cf-sent.is-mod')).toHaveCount(1);
    await page.locator('button.cf-sent', { hasText: 'noyau contient' }).click();
    await page.locator('textarea.cf-text').pressSequentially(' XXX');
    await page.locator('textarea.cf-text').press('Escape');
    await expect(page.locator('button.cf-sent', { hasText: 'XXX' })).toHaveCount(0);

    // valider un doute, retirer une phrase
    await page.getByRole('button', { name: /C'est bon pour la phrase 3/ }).click();
    await expect(page.locator('button.cf-sent.is-doubt')).toHaveCount(0);
    await page.locator('button.cf-sent', { hasText: 'très différentes' }).click();
    await page.getByRole('button', { name: /Retirer cette phrase/ }).click();
    await expect(page.locator('button.cf-sent.is-gone')).toHaveCount(1);

    // formule dangereuse refusée, formule valide avec aperçu
    await page.locator('button.cf-sent', { hasText: 'mesurer' }).click();
    const f = page.locator('textarea.cf-text');
    await f.fill('Voir $\\href{javascript:alert(1)}{ici}$');
    await expect(page.getByRole('alert')).toContainText('La formule n\'est pas acceptée');
    await expect(page.getByRole('button', { name: /^Valider/ })).toBeDisabled();
    await shot(page, '3-formule-refusee-pc');
    await f.fill('Pour mesurer, on utilise $\\frac{a}{b}$ comme unité.');
    await expect(page.locator('.cf-preview math')).toHaveCount(1);
    await f.press('Enter');

    // figure: rien n'est gardé par défaut; l'élève choisit
    const keep = page.getByRole('checkbox', { name: /Garder cette image/ });
    await expect(keep).not.toBeChecked();
    await keep.check();
    await expect(page.getByLabel(/Description de l'image/)).toHaveValue(/Schéma d'une cellule/);
    await shot(page, '4-relecture-corrigee-pc');
    if (SHOTS) {
      await page.locator('.fig-review').scrollIntoViewIfNeeded();
      await page.screenshot({ path: `${SHOTS}/4b-relecture-pc-ecran.png` }); // un seul écran, la photo reste à côté du texte
    }

    await page.getByLabel('Matière').first().selectOption('svt');
    await page.getByRole('button', { name: /vérifie/i }).click();
    await expect.poll(() => bodies.length).toBe(1);
    const b = bodies[0] as { corrections: { id: string; text: string }[]; removed: string[]; figures: { figureId: string; keep: boolean }[]; subject: string };
    expect(b.removed).toEqual(['p1-s4']);
    expect(b.figures).toEqual([{ figureId: 'f1', keep: true }]);
    expect(b.corrections.map((c) => c.id).sort()).toEqual(['p1-s2', 'p2-s4']);
    expect(b.corrections.find((c) => c.id === 'p2-s4')!.text).toContain('\\frac{a}{b}');
  });

  test('503 à la confirmation avec image gardée: message dédié, réessai, puis envoi', async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await login(page, 'eleve');
    await routes(page, bodies);
    let fail = true;
    await page.route('**/jobs/J1/confirm', (r) => {
      bodies.push(r.request().postDataJSON());
      return fail ? r.fulfill(ok({ code: 'indisponible', message: 'Service momentanément indisponible' }, 503)) : r.fulfill(ok({ jobId: 'J1', state: 'verification', pages: 2, createdAt: '2026-12-01T10:00:00Z', status: { stage: 'verification', pagesDone: 2, pagesTotal: 2, startedAt: '2026-12-01T10:00:00Z' } }));
    });
    await page.goto('/#/job/J1');
    await page.getByRole('checkbox', { name: /Garder cette image/ }).check();
    await page.getByLabel('Matière').first().selectOption('svt');
    await page.getByRole('button', { name: /vérifie/i }).click();
    await expect(page.getByText(/pas réussi à garder tes images/)).toBeVisible();
    await shot(page, '14-503-reessai');
    fail = false;
    await page.getByRole('button', { name: 'Réessayer' }).click();
    await expect.poll(() => bodies.length).toBe(2);
    expect((bodies[1] as { figures: unknown[] }).figures).toEqual([{ figureId: 'f1', keep: true }]);
  });

  test('figure non gardée par défaut: envoyée avec keep false', async ({ page }) => {
    const bodies: Record<string, unknown>[] = [];
    await login(page, 'eleve');
    await routes(page, bodies);
    await page.goto('/#/job/J1');
    await expect(page.getByRole('checkbox', { name: /Garder cette image/ })).not.toBeChecked();
    await page.getByLabel('Matière').first().selectOption('svt');
    await page.getByRole('button', { name: /vérifie/i }).click();
    await expect.poll(() => bodies.length).toBe(1);
    expect((bodies[0] as { figures: unknown[] }).figures).toEqual([{ figureId: 'f1', keep: false }]);
  });

  test('mobile: relecture, édition et figure lisibles', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, 'eleve');
    await routes(page, []);
    await page.goto('/#/job/J1');
    await expect(page.getByRole('heading', { name: "Vérifie ce que j'ai lu" })).toBeVisible();
    await shot(page, '5-relecture-mobile');
    await page.locator('button.cf-sent', { hasText: 'plus petite unité' }).click();
    await expect(page.locator('textarea.cf-text')).toBeFocused();
    await shot(page, '6-edition-mobile');
    // pas de défilement horizontal de la page
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('clavier: Tab atteint une phrase, Entrée l\'ouvre, Échap la referme et rend le focus', async ({ page }) => {
    await login(page, 'eleve');
    await routes(page, []);
    await page.goto('/#/job/J1');
    const s = page.locator('button.cf-sent', { hasText: 'plus petite unité' });
    await s.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('textarea.cf-text')).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(s).toBeFocused();
  });
});

const COURS = {
  coursId: 'C1', jobId: 'J1', createdAt: '2026-12-01T10:00:00Z', pages: 2, sentenceCount: SENTENCES.length, subjects: ['svt'],
  sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'La cellule', status: 'fiche', docId: 'D1' }],
  texts: [{ page: 1, sentences: SENTENCES.slice(0, 5).map(({ id, text }) => ({ id, text })) }, { page: 2, sentences: SENTENCES.slice(5).map(({ id, text }) => ({ id, text })) }],
  blocks: BLOCKS,
  figures: [{ figureId: 'f1', page: 1, kind: 'schema', alt: 'Schéma d\'une cellule', caption: 'Fig. 1 : une cellule', box: { x: 0.1, y: 0.4, w: 0.8, h: 0.35 }, url: CELL }],
  marks: [
    { sentenceId: 'p1-s2', status: 'verifiee', docId: 'D1', claimId: 'c1' },
    { sentenceId: 'p1-s3', status: 'erreur', docId: 'D1', claimId: 'c2' },
    { sentenceId: 'p1-s4', status: 'non_verifiable', docId: 'D1', claimId: 'c3' },
  ],
};
const DOC = {
  docId: 'D1', title: 'La cellule', subject: 'svt', topic: 'La cellule', createdAt: '2026-12-01T10:00:00Z', coursId: 'C1', sectionIndex: 0,
  summary: 'La cellule est l\'unité du vivant. Le noyau contient l\'ADN.',
  body: [
    { heading: 'L\'unité du vivant', text: 'La cellule est la plus petite unité du vivant. Elle est entourée par une membrane.', claimIds: ['c1'] },
    { heading: 'Le noyau', text: 'Le noyau contient l\'ADN et dirige la cellule. On mesure en micromètres : $1\\ \\mu m = 10^{-6}\\ m$.', claimIds: ['c2'] },
  ],
  recall: [
    { kind: 'definition', text: 'La cellule est la plus petite unité du vivant.', claimId: 'c1', verified: true },
    { kind: 'nombre', text: 'Un micromètre vaut $10^{-6}\\ m$.', claimId: 'c3', verified: false },
  ],
  figures: COURS.figures,
  claims: [
    { claimId: 'c1', text: 'La cellule est la plus petite unité du vivant.', status: 'verifiee', aRisque: false, sentenceId: 'p1-s2', sources: [{ passageId: 'p1', url: 'https://fr.wikipedia.org/wiki/Cellule', site: 'Wikipédia', titre: 'Cellule', extrait: 'La cellule est l\'unité structurale et fonctionnelle de base de tout être vivant.', niveau: 1 }] },
    { claimId: 'c2', text: 'Le noyau contient l\'ADN et dirige la vie de la cellule.', status: 'erreur', aRisque: false, sentenceId: 'p1-s3', sources: [] },
    { claimId: 'c3', text: 'Un micromètre vaut $10^{-6}\\ m$.', status: 'non_verifiable', aRisque: false, sentenceId: 'p2-s4', sources: [] },
  ],
};

test.describe('Cours coloré, fiche, export (R1-C)', () => {
  test.skip(!isMock, 'Mode mock seulement (réponses fabriquées)');
  test.beforeEach(async ({ page }) => {
    await fake.reset();
    await login(page, 'eleve');
    await page.route('**/cours/C1', (r) => r.fulfill(ok(COURS)));
    await page.route('**/docs/D1', (r) => r.fulfill(ok(DOC)));
  });

  test('cours: résultat de la vérification avec icône et mot, interrupteur, lien vers l\'affirmation', async ({ page }) => {
    await page.goto('/#/cours/C1');
    await expect(page.getByRole('heading', { name: 'Ton cours' })).toBeVisible();
    await expect(page.locator('a.mk')).toHaveCount(3);
    await expect(page.locator('a.mk-verifiee')).toContainText('Vérifié');
    await expect(page.locator('a.mk-erreur')).toContainText('Erreur trouvée');
    await expect(page.locator('a.mk-non_verifiable')).toContainText('Non vérifiable');
    await expect(page.getByRole('img', { name: /Schéma d'une cellule/ })).toBeVisible();
    // aucun lien venu du texte du cours: seuls les liens de marque et de fiche existent dans le document
    await expect(page.locator('.doc a:not(.mk)')).toHaveCount(0);
    await shot(page, '7-cours-colore-pc');
    await page.getByRole('checkbox', { name: 'Montrer la vérification' }).uncheck();
    await expect(page.locator('a.mk')).toHaveCount(0);
    await page.getByRole('checkbox', { name: 'Montrer la vérification' }).check();
    await page.locator('a.mk-erreur').click();
    await expect(page).toHaveURL(/#\/doc\/D1\/c2/);
    await expect(page.getByRole('dialog')).toContainText('Erreur');
    await expect(page.getByRole('button', { name: /Le noyau contient l'ADN/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('cours sur mobile', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#/cours/C1');
    await expect(page.locator('a.mk')).toHaveCount(3);
    await shot(page, '8-cours-colore-mobile');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow).toBeLessThanOrEqual(1);
  });

  test('fiche: paragraphes, rappel avec « non vérifié », figure, formule', async ({ page }) => {
    await page.goto('/#/doc/D1');
    await expect(page.getByRole('heading', { name: 'Le noyau', exact: true })).toBeVisible();
    const recall = page.getByRole('region', { name: 'À retenir' });
    await expect(recall.getByRole('listitem')).toHaveCount(2);
    await expect(recall.getByText('non vérifié')).toHaveCount(1);
    await expect(page.locator('.fiche-body math')).toHaveCount(1);
    await expect(page.getByRole('img', { name: /Schéma d'une cellule/ })).toBeVisible();
    await shot(page, '9-fiche-pc');
    await page.setViewportSize({ width: 390, height: 844 });
    await shot(page, '10-fiche-mobile');
  });

  test('formules lisibles: µ, π, Ω, x², exposant et fraction avec la police KaTeX (pas de carré vide)', async ({ page }) => {
    const sentence = 'Lettres : $\\mu$, $\\pi$, $\\Omega$, $x^2$, $\\alpha + \\beta$ et $\\frac{a}{b}$, puis $\\sin x \\leq \\sqrt{2}$.';
    const texts = COURS.texts.map((t) => ({ ...t, sentences: t.sentences.map((x) => (x.id === 'p2-s4' ? { ...x, text: sentence } : x)) }));
    await page.route('**/cours/C1', (r) => r.fulfill(ok({ ...COURS, texts, marks: [] })));
    await page.goto('/#/cours/C1');
    await expect(page.locator('.doc math')).toHaveCount(8);
    await page.evaluate(() => document.fonts.ready);
    expect(await page.evaluate(() => document.fonts.check('16px "KaTeX Math"') && document.fonts.check('16px "KaTeX Main"'))).toBe(true);
    const mu = page.locator('math mi.mi-i', { hasText: 'μ' }).first();
    await expect(mu).toBeVisible();
    expect(await mu.evaluate((e) => getComputedStyle(e).fontFamily)).toContain('KaTeX Math');
    expect(await mu.evaluate((e) => getComputedStyle(e).textTransform)).toBe('none');
    const p = page.locator('.doc-p', { hasText: 'Lettres' });
    await p.scrollIntoViewIfNeeded();
    if (SHOTS) {
      mkdirSync(SHOTS, { recursive: true });
      await p.screenshot({ path: `${SHOTS}/12-formules-police.png`, scale: 'css' });
    }
  });

  test('mobile: le dernier paragraphe reste atteignable sous la barre d\'action de la relecture', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await routes(page, []);
    await page.goto('/#/job/J1');
    await expect(page.getByRole('heading', { name: "Vérifie ce que j'ai lu" })).toBeVisible();
    const last = page.locator('button.cf-sent', { hasText: 'paroi rigide' });
    await last.scrollIntoViewIfNeeded();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    const covered = await last.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.left + r.width / 2, Math.min(r.top + r.height / 2, innerHeight - 1));
      return !(top && (el === top || el.contains(top)));
    });
    expect(covered).toBe(false);
    await shot(page, '13-bas-de-page-mobile');
  });

  test('Télécharger mes données: demande, attente, lien', async ({ page }) => {
    let polls = 0;
    await page.route('**/me/export/archive', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: { ...CORS, 'access-control-allow-methods': 'GET,POST,OPTIONS' } }) : r.fulfill(ok({ exportId: 'E1' }, 202))));
    await page.route('**/me/export/archive/E1', (r) => (polls++ < 1
      ? r.fulfill(ok({ exportId: 'E1', state: 'en_cours' }))
      : r.fulfill(ok({ exportId: 'E1', state: 'pret', archive: { url: 'http://127.0.0.1:1/a.zip', expiresAt: '2099-01-01T00:10:00Z', format: 'zip', sizeBytes: 3145728, students: 1, tests: 2, truncated: false, courses: 3, figures: 5 } }))));
    await page.goto('/#/docs');
    await page.getByRole('button', { name: 'Télécharger mes données' }).click();
    await expect(page.getByRole('link', { name: /Télécharger l'archive/ })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/3 cours, 5 images/)).toBeVisible();
    await shot(page, '11-export-pret');
  });
});
