import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// F10: ajout de pages a un cours existant, PC puis mobile. Les reponses de l'API sont fabriquees ici (page.route) a partir du contrat 1.6.0: aucune photo ni donnee reelle.
const SHOTS = process.env.F10_SHOTS; // dossier de captures facultatif (relues a la main)
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
const ok = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const T0 = '2026-12-01T10:00:00Z';
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
const svg = (body: string) => `data:image/svg+xml;utf8,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg" width="600" height="400" viewBox="0 0 600 400">${body}</svg>`)}`;
const PAGE = svg('<rect width="600" height="400" fill="#fffdf5"/><g fill="#cbd5e1"><rect x="40" y="40" width="300" height="14" rx="7"/><rect x="40" y="80" width="500" height="10" rx="5"/><rect x="40" y="105" width="480" height="10" rx="5"/><rect x="40" y="130" width="510" height="10" rx="5"/></g>');

const cours = (pages: number, nSec = 2) => ({
  coursId: 'C1', createdAt: T0, pages,
  texts: [
    { page: 1, sentences: [{ id: 'p1-s1', text: 'La photosynthèse permet aux plantes vertes de fabriquer leur matière.' }, { id: 'p1-s2', text: 'Elle se déroule dans les chloroplastes des cellules végétales.' }] },
    { page: 2, sentences: [{ id: 'p2-s1', text: 'La plante absorbe du dioxyde de carbone par ses feuilles.' }, { id: 'p2-s2', text: 'Le dioxygène est rejeté dans l\'atmosphère pendant la journée' }] },
  ],
  sections: Array.from({ length: nSec }, (_, n) => ({ fromSentenceId: n === 0 ? 'p1-s1' : 'p2-s1', subject: 'svt', topic: n === 0 ? 'La photosynthèse' : 'Les échanges gazeux', title: n === 0 ? 'La photosynthèse' : 'Les échanges gazeux', status: 'fiche', docId: `D${n}` })),
});
const WORDS = 'Les volcans naissent de la remontée du magma depuis le manteau terrestre et libèrent de la lave, des cendres et des gaz très chauds. Une éruption effusive coule lentement sur les pentes alors qu\'une éruption explosive projette des cendres très haut dans le ciel';
const TRANSCRIPTION = {
  jobId: 'J9', docType: 'cours', suggestedSubject: 'svt', suggestedTopic: 'Les volcans',
  context: [{ id: 'p2-s1', text: 'La plante absorbe du dioxyde de carbone par ses feuilles.' }, { id: 'p2-s2', text: 'Le dioxygène est rejeté dans l\'atmosphère pendant la journée' }],
  pages: [{ page: 3, sentences: [{ id: 'p3-s1', continuesId: 'p2-s2', text: 'et la nuit la plante rejette aussi un peu de dioxyde de carbone.' }, { id: 'p3-s2', text: WORDS + '.' }] }],
  photoUrls: [PAGE], photoUrlsExpireAt: '2099-01-01T00:00:00Z',
};

async function routes(page: Page, o: { pages?: number; sections?: number; post?: (body: unknown) => ReturnType<typeof ok>; confirms?: unknown[] }) {
  await page.route('**/cours/C1', (r) => r.fulfill(ok(cours(o.pages ?? 2, o.sections ?? 2))));
  await page.route('**/scans', (r) => {
    if (r.request().method() !== 'POST') return r.fallback();
    const body = r.request().postDataJSON();
    return r.fulfill(o.post ? o.post(body) : ok({ jobId: 'J9', upload: { url: 'https://s3.example/0', fields: {} }, uploads: [{ page: 1, url: 'https://s3.example/0', fields: {} }], expiresAt: T0, pagesRemaining: 9 }, 201));
  });
  await page.route('https://s3.example/**', (r) => r.fulfill({ status: 204, headers: CORS }));
  await page.route('**/jobs/J9', (r) => r.fulfill(ok({ jobId: 'J9', state: 'a_confirmer', pages: 1, createdAt: T0, coursId: 'C1', status: { stage: 'a_confirmer', pagesDone: 1, pagesTotal: 1, startedAt: T0, expiresAt: new Date(Date.now() + 10 * 3600_000).toISOString() } })));
  await page.route('**/jobs/J9/transcription', (r) => r.fulfill(ok(TRANSCRIPTION)));
  await page.route('**/jobs/J9/confirm', (r) => {
    o.confirms?.push(r.request().postDataJSON());
    return r.fulfill(ok({ jobId: 'J9', state: 'verification', pages: 1, createdAt: T0, coursId: 'C1', status: { stage: 'verification', pagesDone: 1, pagesTotal: 1, startedAt: T0 } }));
  });
}

for (const [label, viewport] of [['PC', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Ajout de pages (F10), ${label}`, () => {
    test.skip(!isMock, 'Mode mock seulement (réponses fabriquées)');
    test.use({ viewport });
    test.beforeEach(async () => {
      await fake.reset();
    });
    const tag = label.toLowerCase();

    test('du cours à la relecture: contexte grisé, pages à la suite, envoi avec le coursId', async ({ page }) => {
      const confirms: unknown[] = [];
      await login(page, 'eleve');
      await routes(page, { confirms });
      await page.goto('/#/cours/C1');
      await expect(page.getByRole('link', { name: /Ajouter des pages/ })).toBeVisible();
      await shot(page, `1-cours-${tag}`);
      await page.getByRole('link', { name: /Ajouter des pages/ }).click();
      await expect(page.getByRole('heading', { name: 'Ajouter des pages à ton cours' })).toBeVisible();
      await expect(page.getByText(/Tes nouvelles pages seront ajoutées à la/)).toBeVisible();
      await shot(page, `2-envoi-vide-${tag}`);

      const create = page.waitForRequest((r) => r.url().endsWith('/scans') && r.method() === 'POST');
      await page.getByLabel('Prendre ou choisir des photos').setInputFiles({ name: 'p1.jpg', mimeType: 'image/jpeg', buffer: JPEG });
      await expect(page.getByRole('button', { name: /Ajouter 1 page au cours/ })).toBeVisible();
      await shot(page, `3-envoi-pret-${tag}`);
      await page.getByRole('button', { name: /Ajouter 1 page au cours/ }).click();
      expect((await create).postDataJSON()).toMatchObject({ pages: 1, coursId: 'C1' });

      await expect(page.getByRole('heading', { name: 'Vérifie les nouvelles pages' })).toBeVisible();
      await expect(page.locator('.cf-context')).toContainText('Le dioxygène est rejeté');
      await expect(page.locator('.cf-context-link')).toBeVisible();
      await expect(page.locator('.cf-context button')).toHaveCount(0); // lecture seule
      await expect(page.getByText('et la nuit la plante rejette')).toBeVisible();
      await shot(page, `4-relecture-${tag}`);
      await page.getByRole('button', { name: /vérifie/i }).click();
      await expect.poll(() => confirms.length).toBe(1);
      expect((confirms[0] as { corrections: unknown[] }).corrections).toEqual([]);
    });

    test('cours complet: pas de bouton, un message', async ({ page }) => {
      await login(page, 'eleve');
      await routes(page, { pages: 30 });
      await page.goto('/#/cours/C1');
      await expect(page.getByText(/Ce cours est complet/)).toBeVisible();
      await expect(page.getByRole('link', { name: /Ajouter des pages/ })).toHaveCount(0);
      await shot(page, `5-cours-complet-${tag}`);
    });

    test('un autre ajout est ouvert: message clair, rien n’est envoyé', async ({ page }) => {
      await login(page, 'eleve');
      await routes(page, { post: () => ok({ code: 'etat_invalide', message: 'Un autre ajout est en cours pour ce cours' }, 409) });
      await page.goto('/#/scan/ajout/C1');
      await page.getByLabel('Prendre ou choisir des photos').setInputFiles({ name: 'p1.jpg', mimeType: 'image/jpeg', buffer: JPEG });
      await page.getByRole('button', { name: /Ajouter 1 page au cours/ }).click();
      await expect(page.getByText('Un autre ajout est en cours pour ce cours')).toBeVisible();
      await shot(page, `6-ajout-ouvert-${tag}`);
    });
  });
}
