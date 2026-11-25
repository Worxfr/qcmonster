import { expect, test } from '@playwright/test';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// Création de famille et d'élève: écrit des données réelles, donc mode mock seulement.
test.skip(!isMock, 'Mode mock seulement (écrit des comptes)');

test.describe('Famille et élève', () => {
  test("un parent sans famille doit accepter la politique avant de créer sa famille", async ({ page }) => {
    await fake.reset({ role: 'parent', family: false });
    await login(page, 'parent');
    await expect(page.getByRole('heading', { name: 'Bienvenue !' })).toBeVisible();
    const create = page.getByRole('button', { name: 'Créer ma famille' });
    await expect(create).toBeDisabled();
    await page.getByRole('checkbox').check();
    await create.click();
    await expect(page.getByRole('heading', { name: 'Pages de la famille' })).toBeVisible();
    await expect(page.getByText("Aucun élève pour l'instant")).toBeVisible();
  });

  test("ajout d'un élève: pseudo valide et autorité parentale exigés, lien d'activation affiché", async ({ page }) => {
    await fake.reset({ role: 'parent', family: true, student: false });
    await login(page, 'parent');
    const submit = page.getByRole('button', { name: 'Créer et obtenir le lien' });
    await page.getByLabel(/^Pseudo/).fill('1');
    await page.getByLabel(/J'ai l'autorité parentale/).check();
    await expect(submit).toBeDisabled(); // pseudo trop court et qui commence par un chiffre
    await page.getByLabel(/^Pseudo/).fill('Lila');
    await page.getByLabel(/J'ai l'autorité parentale/).uncheck();
    await expect(submit).toBeDisabled(); // sans autorité parentale
    await page.getByLabel(/J'ai l'autorité parentale/).check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole('heading', { name: /Lien d'activation de Lila/ })).toBeVisible();
    await expect(page.getByLabel("Lien d'activation")).toHaveValue(/activer#token=/);
    await expect(page.getByRole('heading', { name: /^Lila-/ })).toBeVisible();
  });

  test('un parent suspend puis réactive un élève', async ({ page }) => {
    await fake.reset({ role: 'parent' });
    await login(page, 'parent');
    await page.getByRole('button', { name: 'Suspendre' }).click();
    await expect(page.getByText('Suspendu')).toBeVisible();
    await page.getByRole('button', { name: 'Réactiver' }).click();
    await expect(page.getByText('Suspendu')).toHaveCount(0);
  });
});
