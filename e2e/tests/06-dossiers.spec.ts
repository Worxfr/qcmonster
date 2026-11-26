import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';
import { sendPhotos, waitForReview } from '../support/flows';

// #74: gestion des dossiers (fiabilité, déplacer, renommer, supprimer). Mode mock seulement: pas de vrai scan.
const SHOTS = process.env.I74_SHOTS; // dossier de captures facultatif (relues à la main)
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const DOCS = [
  { title: 'Les fractions', subject: 'maths' },
  { title: 'La photosynthèse', subject: 'svt' },
  { title: 'La Révolution', subject: 'histoire_geo' },
];
const list = (page: Page) => page.getByRole('region', { name: 'Liste des cours' });
const cards = (page: Page) => list(page).locator('.scan-card');

test.describe('Dossiers', () => {
  test.skip(!isMock, 'Mode mock seulement');
  test.beforeEach(async () => {
    await fake.reset();
  });

  test('le dossier choisi en envoyant le scan est celui affiché à la relecture', async ({ page }) => {
    await fake.seed({ folders: ['Brevet blanc', 'Contrôle de juin'] });
    await login(page, 'eleve');
    await sendPhotos(page, 2, 'Contrôle de juin');
    await waitForReview(page);
    const sel = page.getByLabel('Dossier (facultatif)');
    await expect(sel.locator('option:checked')).toHaveText('Contrôle de juin');
    await expect(sel.locator('option[value=""]')).toHaveCount(0); // le serveur garde ce dossier: pas de faux choix « Aucun »
  });

  test("un lien vers un dossier supprimé ne montre pas d'erreur", async ({ page }) => {
    await fake.seed({ folders: ['Brevet blanc'], docs: [{ title: 'Les fractions', subject: 'maths', folder: 'Brevet blanc' }] });
    await login(page, 'eleve');
    await page.goto('/#/folders');
    await page.getByRole('button', { name: /Brevet blanc/ }).first().click();
    await expect(cards(page)).toHaveCount(1);
    const url = page.url();
    await page.goto('/#/folders');
    await page.getByRole('button', { name: 'Supprimer Brevet blanc' }).click();
    await page.getByRole('button', { name: 'Oui, supprimer le dossier' }).click();
    await expect(page.getByText('Pas encore de dossier')).toBeVisible();
    await page.goto(url);
    await expect(page.getByRole('alert')).toHaveCount(0);
    await expect(page.getByText(/Ce dossier n'existe plus/)).toBeVisible();
    await expect(cards(page)).toHaveCount(1); // le cours est resté, hors dossier
  });

  test('déplacer plusieurs fiches, en changer une de dossier, la sortir du dossier', async ({ page }) => {
    await fake.seed({ folders: ['Brevet blanc', 'Contrôle de juin'], docs: DOCS });
    await login(page, 'eleve');
    await page.goto('/#/docs');
    await shot(page, '1-liste');
    await page.getByRole('button', { name: 'Choisir des cours', exact: true }).click();
    await page.getByRole('button', { name: /Tout choisir \(3\)/ }).click();
    await expect(page.getByText('3 choisis')).toBeVisible();
    await page.getByRole('button', { name: /Ranger dans un dossier/ }).click();
    await page.getByRole('region', { name: /Actions/ }).getByLabel('Dossier').selectOption({ label: 'Brevet blanc' });
    await shot(page, '2-ranger');
    await page.getByRole('button', { name: 'Ranger ici' }).click();
    await expect(page.getByText('📁 Brevet blanc')).toHaveCount(3);

    // une seule fiche part dans un autre dossier (la fiche du milieu de liste: « Les fractions »)
    await page.getByRole('button', { name: 'Choisir des cours', exact: true }).click();
    await page.getByRole('checkbox', { name: /Choisir Les fractions/ }).check();
    await page.getByRole('button', { name: /Ranger dans un dossier/ }).click();
    await page.getByRole('region', { name: /Actions/ }).getByLabel('Dossier').selectOption({ label: 'Contrôle de juin' });
    await expect(page.getByText(/1 cours sera déplacé/)).toBeVisible();
    await page.getByRole('button', { name: 'Ranger ici' }).click();
    await expect(page.locator('.scan-card', { hasText: 'Les fractions' })).toContainText('📁 Contrôle de juin');
    await expect(page.locator('.scan-card', { hasText: 'La photosynthèse' })).toContainText('📁 Brevet blanc');

    // la sortir du dossier
    await page.getByRole('button', { name: 'Choisir des cours', exact: true }).click();
    await page.getByRole('checkbox', { name: /Choisir Les fractions/ }).check();
    await page.getByRole('button', { name: 'Sortir du dossier' }).click();
    await expect(page.locator('.scan-card', { hasText: 'Les fractions' })).not.toContainText('📁');

    await page.goto('/#/folders');
    await expect(page.locator('.folder-card', { hasText: 'Brevet blanc' })).toContainText('2 cours');
    await expect(page.locator('.folder-card', { hasText: 'Contrôle de juin' })).toContainText('0 cours');
  });

  test('depuis la fiche: ranger, changer de dossier, sortir du dossier', async ({ page }) => {
    await fake.seed({ folders: ['Brevet blanc', 'Contrôle de juin'], docs: [DOCS[0]] });
    await login(page, 'eleve');
    await page.goto('/#/docs');
    await page.locator('.scan-open', { hasText: 'Les fractions' }).click();
    const sel = page.getByLabel('Cette fiche est dans');
    await expect(sel).toHaveValue('');
    await sel.selectOption({ label: 'Brevet blanc' });
    await expect(page.getByRole('status').filter({ hasText: 'Rangée dans « Brevet blanc »' })).toBeVisible();
    await shot(page, '5-fiche');
    await sel.selectOption({ label: 'Contrôle de juin' });
    await expect(page.getByRole('status').filter({ hasText: 'Contrôle de juin' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Cette fiche est dans').locator('option:checked')).toHaveText('Contrôle de juin');
    await page.getByLabel('Cette fiche est dans').selectOption({ label: 'Aucun dossier' });
    await expect(page.getByRole('status').filter({ hasText: 'Sortie du dossier' })).toBeVisible();
    await page.reload();
    await expect(page.getByLabel('Cette fiche est dans')).toHaveValue('');
  });

  test('dossier ouvert: renommer (nom déjà pris refusé) puis supprimer, les cours restent', async ({ page }) => {
    await fake.seed({ folders: ['Brevet blanc', 'Contrôle de juin'], docs: [{ ...DOCS[0], folder: 'Brevet blanc' }, { ...DOCS[1], folder: 'Brevet blanc' }] });
    await login(page, 'eleve');
    await page.goto('/#/folders');
    await page.getByRole('button', { name: /Brevet blanc/ }).first().click();
    await expect(cards(page)).toHaveCount(2);
    await shot(page, '3-dossier-ouvert');
    await page.getByRole('button', { name: 'Renommer le dossier' }).click();
    await page.getByLabel('Nouveau nom du dossier').fill('controle de JUIN');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('alert')).toContainText('déjà un dossier avec ce nom');
    await page.getByLabel('Nouveau nom du dossier').fill('Brevet 2027');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.getByRole('heading', { name: /Brevet 2027/ })).toBeVisible();
    await page.getByRole('button', { name: 'Supprimer le dossier' }).click();
    await shot(page, '4-supprimer-dossier');
    await page.getByRole('button', { name: 'Oui, supprimer le dossier' }).click();
    await expect(page).toHaveURL(/#\/docs$/);
    await expect(cards(page)).toHaveCount(2);
    await expect(list(page).getByText('📁')).toHaveCount(0);
    await page.goto('/#/folders');
    await expect(page.locator('.folder-list strong')).toHaveText(['Contrôle de juin']);
  });

  test('nouveau dossier: le nom tapé est créé avec Entrée et choisi', async ({ page }) => {
    await fake.seed({ docs: [DOCS[0]] });
    await login(page, 'eleve');
    await page.goto('/#/docs');
    await page.locator('.scan-open', { hasText: 'Les fractions' }).click();
    await page.getByLabel('Cette fiche est dans').selectOption({ label: '＋ Nouveau dossier…' });
    await expect(page.getByText(/n'existe qu'après « Créer »/)).toBeVisible();
    await page.getByLabel('Nom du nouveau dossier').fill('Révisions');
    await page.getByLabel('Nom du nouveau dossier').press('Enter');
    await expect(page.getByRole('status').filter({ hasText: 'Rangée dans « Révisions »' })).toBeVisible();
  });
});

test.describe('Dossiers sur téléphone', () => {
  test.skip(!isMock, 'Mode mock seulement');
  test.use({ viewport: { width: 390, height: 844 } });
  test('ranger et gérer un dossier sans défilement horizontal', async ({ page }) => {
    await fake.reset();
    await fake.seed({ folders: ['Brevet blanc'], docs: [{ ...DOCS[0], folder: 'Brevet blanc' }, DOCS[1]] });
    await login(page, 'eleve');
    await page.goto('/#/docs');
    await page.getByRole('button', { name: 'Choisir des cours', exact: true }).click();
    await page.getByRole('checkbox', { name: /Choisir La photosynthèse/ }).check();
    await page.getByRole('button', { name: /Ranger dans un dossier/ }).click();
    await shot(page, 'm1-ranger');
    await page.getByRole('region', { name: /Actions/ }).getByLabel('Dossier').selectOption({ label: 'Brevet blanc' });
    await page.getByRole('button', { name: 'Ranger ici' }).click();
    await page.goto('/#/folders');
    await page.getByRole('button', { name: /Brevet blanc/ }).first().click();
    await expect(cards(page)).toHaveCount(2);
    await shot(page, 'm2-dossier-ouvert');
    await page.getByRole('button', { name: 'Supprimer le dossier' }).click();
    await shot(page, 'm3-supprimer');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.locator('.scan-open', { hasText: 'Les fractions' }).click();
    await shot(page, 'm4-fiche');
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});
