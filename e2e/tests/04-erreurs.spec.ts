import { expect, test } from '@playwright/test';
import { bigFile, fake, login, makePhotos } from '../support/app';
import { isMock, takeRealScan } from '../support/env';
import { SLOW, sendPhotos, waitForReview } from '../support/flows';

test.describe('Parcours d\'erreur', () => {
  test.beforeEach(async ({ page }) => {
    await fake.reset();
    await login(page, 'eleve');
    await page.goto('/#/scan');
  });

  test('la 11e photo est refusée avec un message, les 10 premières restent', async ({ page }) => {
    const files = await makePhotos(page, 3);
    const input = page.locator('input[type=file]');
    await input.setInputFiles(Array.from({ length: 10 }, (_, i) => files[i % 3]));
    await expect(page.getByRole('list', { name: /Pages à envoyer/ }).getByRole('listitem')).toHaveCount(10);
    await expect(page.getByLabel('Ajouter une page')).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Envoyer 10 pages' })).toBeVisible();
  });

  test('11 photos choisies d\'un coup: 10 gardées, message « 10 pages au maximum »', async ({ page }) => {
    const files = await makePhotos(page, 3);
    await page.locator('input[type=file]').setInputFiles(Array.from({ length: 11 }, (_, i) => files[i % 3]));
    await expect(page.getByRole('alert')).toContainText('10 pages au maximum');
    await expect(page.getByRole('list', { name: /Pages à envoyer/ }).getByRole('listitem')).toHaveCount(10);
  });

  test('un fichier de plus de 5 Mo est refusé avec son nom', async ({ page }) => {
    await page.locator('input[type=file]').setInputFiles(bigFile(6));
    await expect(page.getByRole('alert')).toContainText('trop lourde');
    await expect(page.getByRole('alert')).toContainText('trop-lourde-6mo.jpg');
    await expect(page.getByRole('button', { name: /^Envoyer/ })).toHaveCount(0);
  });

  test('un fichier qui n\'est pas une photo JPEG ou PNG est refusé', async ({ page }) => {
    await page.locator('input[type=file]').setInputFiles({ name: 'cours.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF-1.4') });
    await expect(page.getByRole('alert')).toContainText("n'est pas une photo JPEG ou PNG");
  });

  test('retirer une page met à jour la liste et le bouton', async ({ page }) => {
    const files = await makePhotos(page, 3);
    await page.locator('input[type=file]').setInputFiles(files);
    await page.getByRole('button', { name: 'Retirer la page 2' }).click();
    await expect(page.getByRole('button', { name: 'Envoyer 2 pages' })).toBeVisible();
  });

  test('plus de photos que de pages restantes: envoi bloqué avec le nombre à retirer', async ({ page }) => {
    test.skip(!isMock, 'Quota réel non modifiable');
    await fake.reset({ pagesLimit: 2 });
    await page.goto('/#/scan');
    await page.reload();
    await page.locator('input[type=file]').setInputFiles(await makePhotos(page, 3));
    await expect(page.getByRole('alert')).toContainText('il ne t\'en reste que 2');
    await expect(page.getByRole('button', { name: 'Envoyer 3 pages' })).toBeDisabled();
  });

  test("panne de l'envoi: message clair et pages rendues", async ({ page }) => {
    test.skip(!isMock, 'Panne simulée seulement');
    await fake.fail('s3');
    await page.locator('input[type=file]').setInputFiles(await makePhotos(page, 3));
    await page.getByRole('button', { name: 'Envoyer 3 pages' }).click();
    await expect(page.getByRole('alert')).toContainText("L'envoi a échoué, tes pages sont rendues");
    await fake.fail(null);
    expect((await fake.state()).pagesRemaining).toBe(20);
  });

  test('annulation pendant la relecture: le scan est annulé et les pages rendues', async ({ page }) => {
    test.skip(!takeRealScan(), 'Budget de vrais scans épuisé (E2E_REAL_SCANS)');
    await sendPhotos(page, 3);
    await waitForReview(page);
    await page.getByRole('button', { name: 'Annuler et récupérer mes pages' }).click();
    await page.getByRole('button', { name: 'Oui, annuler le scan' }).click();
    await expect(page.getByRole('heading', { name: 'Scan annulé' })).toBeVisible();
    await expect(page.getByText('Tes pages ont été rendues.')).toBeVisible();
    await page.getByRole('button', { name: 'Recommencer' }).click();
    await expect(page.getByRole('heading', { name: 'Scanner un cours' })).toBeVisible();
    // le compteur est relu tout de suite après l'annulation
    if (isMock) await expect(page.getByRole('status').filter({ hasText: 'Il te reste 20 pages' })).toBeVisible();
    // le scan annulé n'est plus listé
    await page.goto('/#/docs?status=echec');
    await expect(page.getByText('Aucun cours ne correspond.')).toBeVisible({ timeout: SLOW });
  });
});
