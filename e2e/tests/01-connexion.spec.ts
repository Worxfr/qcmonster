import { expect, test } from '@playwright/test';
import { fake, login, logout } from '../support/app';
import { creds, isMock } from '../support/env';

test.describe('Connexion et déconnexion', () => {
  test.beforeEach(() => fake.reset());

  test("l'écran de connexion se charge et la politique est lisible sans compte", async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { name: 'QCMonster' })).toBeVisible();
    await page.getByRole('link', { name: 'Politique de confidentialité' }).click();
    await expect(page.getByRole('heading', { name: 'Politique de confidentialité' })).toBeVisible();
  });

  test("un élève se connecte, voit son accueil, puis se déconnecte; un retour à l'accueil redemande la connexion", async ({ page }) => {
    await login(page, 'eleve');
    await expect(page.getByRole('heading', { name: /^Salut / })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toBeVisible();
    await logout(page);
    await page.goto('/#/docs');
    await expect(page.getByRole('heading', { name: 'QCMonster' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0);
  });

  test('un parent se connecte et voit le suivi de la famille, sans barre de navigation élève', async ({ page }) => {
    test.skip(!isMock && !creds.parent.user, 'E2E_PARENT_USER non fourni');
    await login(page, 'parent');
    await expect(page.getByRole('heading', { name: 'Pages de la famille' })).toBeVisible();
    await expect(page.getByRole('navigation', { name: 'Navigation principale' })).toHaveCount(0);
    await logout(page);
  });

  test('mode dev: un mauvais mot de passe est refusé avec un message', async ({ page }) => {
    test.skip(isMock, 'Connexion réelle seulement');
    await page.goto('/');
    await page.getByLabel('Identifiant ou e-mail').fill('inconnu-e2e');
    await page.getByLabel('Mot de passe').fill('mauvais-mot-de-passe-1A');
    await page.getByRole('button', { name: 'Se connecter' }).click();
    await expect(page.getByRole('alert')).toBeVisible();
  });
});
