import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { exoFake, fake, login, makeCopiePhotos } from '../support/app';
import { API, isMock } from '../support/env';

// E1: exercices de raisonnement et correction de la copie photographiee (contrat 1.9.0), contre l'automate du mock. PC puis mobile.
const SHOTS = process.env.E1_SHOTS; // dossier de captures facultatif (relues a la main)
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const noOverflow = async (page: Page) => {
  const w = await page.evaluate(() => ({ s: document.documentElement.scrollWidth, c: document.documentElement.clientWidth }));
  expect(w.s, `défilement horizontal (${w.s} > ${w.c})`).toBeLessThanOrEqual(w.c);
};
const json = (path: string, method = 'GET', body?: unknown) => fetch(`${API}${path}`, { method, ...(body ? { body: JSON.stringify(body) } : {}) });

async function seedDoc(subject = 'maths'): Promise<string> {
  const { docs } = await fake.seed({ docs: [{ title: 'La vitesse moyenne', subject, topic: 'Vitesse' }] });
  return docs[0];
}
/** Fiche de maths, connexion, liste vide, puis un exercice pret et ouvert. Renvoie l'identifiant de la fiche. */
async function openExercice(page: Page, tag: string): Promise<string> {
  const docId = await seedDoc();
  await login(page, 'eleve');
  await page.goto(`/#/doc/${docId}`);
  await page.getByRole('button', { name: /Un exercice/ }).click();
  await expect(page.getByText("Tu n'as pas encore d'exercice")).toBeVisible();
  await shot(page, `1-liste-vide-${tag}`);
  await page.getByRole('button', { name: /Un nouvel exercice/ }).click();
  await expect(page.getByText('Je prépare ton exercice')).toBeVisible();
  await shot(page, `2-preparation-${tag}`);
  await page.getByRole('link', { name: /Ouvrir/ }).click({ timeout: 15_000 });
  await expect(page.getByRole('heading', { name: 'Vitesse moyenne' })).toBeVisible();
  return docId;
}
async function addPhotos(page: Page, n: number, type: 'jpeg' | 'png' = 'jpeg') {
  const files = await makeCopiePhotos(page, n, type);
  await page.getByLabel('Choisir des photos dans la galerie').setInputFiles(files);
  await expect(page.getByRole('list', { name: /Pages de ta copie/ }).getByRole('listitem')).toHaveCount(n);
}

for (const [label, viewport] of [['PC', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Exercices (E1), ${label}`, () => {
    test.skip(!isMock, 'Mode mock seulement (automate de l’API factice)');
    test.use({ viewport });
    test.beforeEach(async () => {
      await fake.reset();
    });
    const tag = label.toLowerCase();

    test('parcours complet: énoncé, 2 indices, 2 pages, attente, retour, nouvelle tentative, solution', async ({ page }) => {
      await openExercice(page, tag);
      // énoncé avec formule rendue (MathML), sans débordement
      await expect(page.locator('.exo-enonce math').first()).toBeVisible();
      await expect(page.getByText('Jusqu\'à 10 points')).toBeVisible();
      await shot(page, `3-enonce-${tag}`);
      await noOverflow(page);
      // 2 indices, avec l'avertissement
      await expect(page.getByText(/Chaque indice retire des points/)).toBeVisible();
      await page.getByRole('button', { name: /Un indice/ }).click();
      await expect(page.getByRole('list', { name: 'Tes indices' }).getByRole('listitem')).toHaveCount(1);
      await page.getByRole('button', { name: /Un indice/ }).click();
      await expect(page.getByRole('list', { name: 'Tes indices' }).getByRole('listitem')).toHaveCount(2);
      await expect(page.getByText("Jusqu'à 6 points")).toBeVisible();
      // la solution est refusée tant qu'on n'a pas essayé
      await page.getByRole('button', { name: 'Voir la solution' }).click();
      await expect(page.getByText(/ne te rapportera plus de points/)).toBeVisible();
      await page.getByRole('button', { name: 'Oui, voir la solution' }).click();
      await expect(page.getByText(/Essaie d'abord l'exercice/)).toBeVisible();
      // 2 pages factices (JPEG)
      await exoFake.wait60();
      await addPhotos(page, 2);
      await shot(page, `4-photos-${tag}`);
      await noOverflow(page);
      await page.getByRole('button', { name: /Rendre ma copie/ }).click();
      await expect(page).toHaveURL(/#\/copie\//);
      await expect(page.getByRole('heading', { name: 'Je corrige ta copie' })).toBeVisible();
      await shot(page, `5-attente-${tag}`);
      // retour
      await expect(page.getByRole('heading', { name: 'Voilà ton retour !' })).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('1 étape sur 4')).toBeVisible();
      await expect(page.getByText('+3 points gagnés')).toBeVisible();
      const steps = page.getByRole('list', { name: 'Tes étapes' });
      await expect(steps.locator('.exo-tag').filter({ hasText: 'Juste' })).toHaveCount(1);
      await expect(steps.locator('.exo-tag').filter({ hasText: 'À compléter' })).toHaveCount(1);
      await expect(steps.locator('.exo-tag').filter({ hasText: 'Faux' })).toHaveCount(2);
      await expect(steps.getByText(/Relis ton calcul de la division/)).toBeVisible();
      await expect(page.getByText('Cette correction est faite par une IA, elle peut se tromper. Si tu n\'es pas d\'accord, regarde la solution ou demande à ton professeur.')).toBeVisible();
      await expect(page.getByText('Il te reste 2 corrections pour cet exercice.')).toBeVisible();
      await shot(page, `6-retour-${tag}`);
      await noOverflow(page);
      // nouvelle tentative, en PNG cette fois
      await page.getByRole('link', { name: /Refaire et rendre à nouveau/ }).click();
      await expect(page.getByRole('heading', { name: 'Vitesse moyenne' })).toBeVisible();
      await addPhotos(page, 1, 'png');
      await page.getByRole('button', { name: /Rendre ma copie/ }).click();
      await expect(page.getByText('+3 points gagnés')).toBeVisible({ timeout: 15_000 });
      await expect(page.getByText('4 étapes sur 4')).toBeVisible();
      // solution: avertissement, puis texte avec formule
      await page.getByRole('button', { name: 'Voir la solution' }).click();
      await expect(page.getByText(/ne te rapportera plus de points/)).toBeVisible();
      await page.getByRole('button', { name: 'Oui, voir la solution' }).click();
      await expect(page.getByLabel('Solution').locator('math').first()).toBeVisible();
      await shot(page, `7-solution-${tag}`);
      await noOverflow(page);
      // suppression de la copie
      await page.getByRole('button', { name: 'Supprimer cette copie' }).click();
      await page.getByRole('button', { name: 'Oui, supprimer' }).click();
      await expect(page.getByRole('heading', { name: 'Vitesse moyenne' })).toBeVisible();
      await expect(page.getByText('Tu as déjà vu la solution.')).toBeVisible();
    });

    test('quota de pages atteint: message simple avec la date de retour', async ({ page }) => {
      await openExercice(page, tag);
      await exoFake.set({ quota: true });
      await exoFake.wait60();
      await addPhotos(page, 1);
      await page.getByRole('button', { name: /Rendre ma copie/ }).click();
      await expect(page.getByRole('alert').filter({ hasText: /Elles reviennent le \d+ \S+/ })).toBeVisible();
      await expect(page).toHaveURL(/#\/exercice\//);
      await shot(page, `8-quota-${tag}`);
      await noOverflow(page);
    });

    test("rendue trop tôt: message, puis on réessaie sans renvoyer les photos; copie illisible", async ({ page }) => {
      await openExercice(page, tag);
      let creates = 0;
      page.on('request', (r) => { if (r.method() === 'POST' && /\/exercices\/[^/]+\/copies$/.test(r.url())) creates += 1; });
      await addPhotos(page, 1);
      await page.getByRole('button', { name: /Rendre ma copie/ }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'Prends le temps de faire l\'exercice' })).toBeVisible();
      await exoFake.wait60();
      await exoFake.set({ illisible: 1 });
      await page.getByRole('button', { name: 'Rendre ma copie', exact: true }).click();
      await expect(page.getByText('Je n\'arrive pas à lire, reprends en photo plus net. Ça ne compte pas dans tes essais.')).toBeVisible({ timeout: 15_000 });
      expect(creates).toBe(1);
      await shot(page, `9-illisible-${tag}`);
      await noOverflow(page);
      await page.getByRole('link', { name: /Reprendre en photo/ }).click();
      await expect(page.getByText('Il te reste 3 corrections pour cet exercice.')).toBeVisible();
    });

    test('la solution arrive après 3 indices et 10 minutes; un 2e exercice le même jour est refusé', async ({ page }) => {
      const docId = await openExercice(page, tag);
      for (let i = 0; i < 3; i++) await page.getByRole('button', { name: /Un indice/ }).click();
      await expect(page.getByText('Tu as vu les 3 indices.')).toBeVisible();
      await exoFake.set({ skewMs: 11 * 60_000 });
      await page.getByRole('button', { name: 'Voir la solution' }).click();
      await page.getByRole('button', { name: 'Oui, voir la solution' }).click();
      await expect(page.getByLabel('Solution')).toBeVisible();
      await page.goto(`/#/exercices/${docId}`);
      await page.getByRole('button', { name: /Un nouvel exercice/ }).click();
      await expect(page.getByRole('alert').filter({ hasText: /limite d'exercices/ })).toBeVisible();
      await expect(page.getByText(/solution vue/)).toBeVisible();
    });

    test("la matière doit être maths ou physique: pas de bouton ailleurs", async ({ page }) => {
      const docId = await seedDoc('svt');
      await login(page, 'eleve');
      await page.goto(`/#/doc/${docId}`);
      await expect(page.getByRole('button', { name: /S'entraîner/ })).toBeVisible();
      await expect(page.getByRole('button', { name: /Un exercice/ })).toHaveCount(0);
    });

    test("suppression refusée pendant la correction (409): la phrase explique", async ({ page }) => {
      await openExercice(page, tag);
      await exoFake.wait60();
      await addPhotos(page, 1);
      await page.getByRole('button', { name: /Rendre ma copie/ }).click();
      await expect(page.getByRole('heading', { name: 'Voilà ton retour !' })).toBeVisible({ timeout: 15_000 });
      await page.route('**/copies/*', (r) => (r.request().method() === 'DELETE'
        ? r.fulfill({ status: 409, contentType: 'application/json', headers: { 'access-control-allow-origin': '*' }, body: JSON.stringify({ code: 'en_correction', message: 'La correction est en cours' }) })
        : r.fallback()));
      await page.getByRole('button', { name: 'Supprimer cette copie' }).click();
      await page.getByRole('button', { name: 'Oui, supprimer' }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'La correction est encore en cours' })).toBeVisible();
    });
  });
}

test.describe('Exercices (E1): parent et historique', () => {
  test.skip(!isMock, 'Mode mock seulement (automate de l’API factice)');
  test.beforeEach(async () => {
    await fake.reset();
  });

  test("le parent n'a ni écran ni lien, et l'API répond 403", async ({ page }) => {
    const docId = await seedDoc();
    await login(page, 'parent');
    await expect(page.getByRole('link', { name: /Suivi de Lila/ })).toBeVisible();
    await page.goto(`/#/exercices/${docId}`);
    await expect(page.getByRole('link', { name: /Suivi de Lila/ })).toBeVisible(); // retombe sur le tableau de bord
    await expect(page.getByText(/Un exercice|Mes exercices/)).toHaveCount(0);
    for (const [method, path] of [['GET', `/docs/${docId}/exercices`], ['POST', `/docs/${docId}/exercices`], ['GET', '/exercices/x'], ['POST', '/exercices/x/copies'], ['GET', '/copies/x'], ['DELETE', '/copies/x']] as const) {
      expect((await json(path, method, method === 'POST' ? {} : undefined)).status, `${method} ${path}`).toBe(403);
    }
  });

  test("un passage « Exercice » dans l'historique: lignes Étape et Résultat final, côté élève puis côté parent (sans texte)", async ({ page }) => {
    const docId = await seedDoc();
    // L'élève fait un exercice jusqu'au retour, par l'API.
    const exoId = ((await (await json(`/docs/${docId}/exercices`, 'POST')).json()) as { exoId: string }).exoId;
    for (let i = 0; i < 3; i++) await json(`/exercices/${exoId}`);
    await exoFake.wait60();
    const copie = (await (await json(`/exercices/${exoId}/copies`, 'POST', { pages: 1, contentType: 'image/jpeg' })).json()) as { copieId: string; envois: { url: string }[] };
    await fetch(copie.envois[0].url, { method: 'POST', body: new Uint8Array([1, 2, 3]) });
    expect((await json(`/copies/${copie.copieId}/submit`, 'POST')).status).toBe(202);
    for (let i = 0; i < 3; i++) await json(`/copies/${copie.copieId}`);
    expect(((await (await json(`/copies/${copie.copieId}`)).json()) as { etat: string }).etat).toBe('corrigee');

    await login(page, 'eleve');
    await page.goto('/#/tests');
    await expect(page.getByText('Exercice').first()).toBeVisible();
    await page.locator('.test-row').first().click();
    await expect(page.getByText('Étape 1')).toBeVisible();
    await expect(page.getByText('Résultat final')).toBeVisible();
    await expect(page.getByText("Cette question n'existe plus")).toHaveCount(0);
    await shot(page, 'historique-eleve-pc');

    await fake.role('parent');
    await page.goto('/');
    await page.getByRole('button', { name: 'Déconnexion' }).click();
    await login(page, 'parent');
    await page.getByRole('link', { name: /Suivi de Lila/ }).click();
    await page.locator('.test-row').first().click();
    await expect(page.getByRole('heading', { name: 'Résultat par question' })).toBeVisible();
    await expect(page.getByText('Étape 1')).toBeVisible();
    await expect(page.getByText('Résultat final')).toBeVisible();
    const body = await page.locator('main').innerText();
    expect(body).not.toContain('Choisir la bonne formule');
    expect(body).not.toContain('cycliste');
    await shot(page, 'historique-parent-pc');
  });
});
