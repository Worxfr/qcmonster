import { expect, test } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { SLOW, sendPhotos, waitForReview } from '../support/flows';
import { isMock } from '../support/env';

// F9: un scan pas mené au bout vit dans Scanner (supprimable avec confirmation), jamais dans Mes cours.
const SHOTS = process.env.F9_SHOTS; // dossier de captures facultatif (relues à la main)
const shot = async (page: import('@playwright/test').Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

test.describe('Supprimer un scan non confirmé', () => {
  test.skip(!isMock, 'Mode mock seulement (ne supprime pas de scan sur le site dev)');
  test.beforeEach(async ({ page }) => {
    await fake.reset();
    await login(page, 'eleve');
  });

  test('en lecture puis à relire: dans Scanner seulement; suppression avec confirmation, pages rendues', async ({ page }) => {
    const before = (await fake.state()).pagesRemaining;
    await sendPhotos(page, 2);
    await page.goto('/#/docs');
    await expect(page.getByText(/Scanne ton premier cours/)).toBeVisible();
    await shot(page, '1-mes-cours-vide');

    await page.goto('/#/scan');
    const box = page.getByRole('region', { name: 'Mes scans en cours' });
    await expect(box).toBeVisible();
    await expect(box).toContainText('À relire', { timeout: SLOW });
    await shot(page, '2-scanner-a-relire');
    expect((await fake.state()).pagesRemaining).toBe(before - 2);

    await box.getByRole('button', { name: /Supprimer/ }).click();
    await expect(box.getByRole('group', { name: 'Confirmer la suppression' })).toBeVisible();
    await shot(page, '3-confirmation');
    await box.getByRole('button', { name: 'Non, garder' }).click();
    await expect(box.getByRole('button', { name: /Vérifier/ })).toBeVisible(); // rien n'a été supprimé

    await box.getByRole('button', { name: /Supprimer/ }).click();
    await box.getByRole('button', { name: 'Oui, supprimer' }).click();
    await expect(box).toHaveCount(0);
    await shot(page, '4-apres-suppression');
    expect((await fake.state()).pagesRemaining).toBe(before);

    // rechargement: toujours rien, ni dans Scanner ni dans Mes cours
    await page.reload();
    await expect(page.getByRole('region', { name: 'Mes scans en cours' })).toHaveCount(0);
    await page.goto('/#/docs');
    await expect(page.getByText(/Scanne ton premier cours/)).toBeVisible();
  });
});
