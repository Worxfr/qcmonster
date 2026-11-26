import { mkdirSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// Création de famille et d'élève: écrit des données réelles, donc mode mock seulement.
test.skip(!isMock, 'Mode mock seulement (écrit des comptes)');

const SHOTS = process.env.ID1_SHOTS; // dossier de captures facultatif (relues à la main)
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};

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

  test("ajout d'un élève: surnom valide et autorité parentale exigés, lien d'activation affiché", async ({ page }) => {
    await fake.reset({ role: 'parent', family: true, student: false });
    await login(page, 'parent');
    const submit = page.getByRole('button', { name: 'Créer et obtenir le lien' });
    await page.getByLabel(/^Surnom de départ/).fill('1');
    await page.getByLabel(/J'ai l'autorité parentale/).check();
    await expect(submit).toBeDisabled(); // pseudo trop court et qui commence par un chiffre
    await page.getByLabel(/^Surnom de départ/).fill('Lila');
    await page.getByLabel(/J'ai l'autorité parentale/).uncheck();
    await expect(submit).toBeDisabled(); // sans autorité parentale
    await page.getByLabel(/J'ai l'autorité parentale/).check();
    await expect(submit).toBeEnabled();
    await submit.click();
    await expect(page.getByRole('heading', { name: /Lien d'activation de Lila/ })).toBeVisible();
    await expect(page.getByLabel("Lien d'activation")).toHaveValue(/activer#token=/);
    await expect(page.getByRole('heading', { name: 'Lila', exact: true })).toBeVisible();
    await expect(page.getByTestId('login-id').first()).toHaveText(/^lila-[a-z0-9]{5}$/);
  });

  test('un parent suspend puis réactive un élève', async ({ page }) => {
    await fake.reset({ role: 'parent' });
    await login(page, 'parent');
    await page.getByRole('button', { name: 'Suspendre' }).click();
    await expect(page.getByText('Suspendu')).toBeVisible();
    await page.getByRole('button', { name: 'Réactiver' }).click();
    await expect(page.getByText('Suspendu')).toHaveCount(0);
  });
// ID1 (#33): surnom choisi à l'activation, identifiant visible, nouvel identifiant. PC puis téléphone.
for (const [label, viewport] of [['PC', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Identifiant et surnom (${label})`, () => {
    test.use({ viewport });
    const PW = 'Un-mot-de-passe-long-1';

    async function inviteLila(page: Page, nick = 'Lila') {
      await login(page, 'parent');
      await page.getByLabel(/^Surnom de départ/).fill(nick);
      await page.getByLabel(/J'ai l'autorité parentale/).check();
      await page.getByRole('button', { name: 'Créer et obtenir le lien' }).click();
      const url = await page.getByLabel("Lien d'activation").inputValue();
      return new URL(url).hash;
    }

    test('parcours complet: le parent invite, l\'élève choisit son surnom, lit son identifiant, se connecte et le retrouve dans « Mon profil »', async ({ page }) => {
      await fake.reset({ role: 'parent', family: true, student: false });
      const hash = await inviteLila(page);
      await shot(page, `${label}-1-parent-lien`);
      await page.goto(`/activer${hash}`);
      await shot(page, `${label}-2-activation`);
      await page.getByLabel('Ton surnom').fill('Porn');
      await page.getByLabel('Mot de passe', { exact: true }).fill(PW);
      await page.getByLabel(/encore une fois/).fill(PW);
      await page.getByRole('button', { name: 'Activer mon compte' }).click();
      await expect(page.getByRole('alert').filter({ hasText: "Ce surnom n'est pas possible" })).toBeVisible(); // refusé, le lien reste valable
      await shot(page, `${label}-3-surnom-refuse`);
      await page.getByLabel('Ton surnom').fill('Lilou');
      await page.getByRole('button', { name: 'Activer mon compte' }).click();
      const id = page.getByTestId('login-id');
      await expect(id).toHaveText(/^lila-[a-z0-9]{5}$/);
      const loginId = (await id.textContent()) ?? '';
      expect(page.url()).not.toContain(loginId); // jamais dans l'URL
      await expect(page.getByRole('button', { name: /Copier/ })).toBeVisible();
      await shot(page, `${label}-4-identifiant`);
      await page.evaluate(() => sessionStorage.clear()); // l'élève est sur un autre appareil: la session du parent n'existe pas là-bas
      await page.getByRole('button', { name: /connexion/ }).click();
      await page.goto('/');
      await fake.role('eleve');
      await page.getByRole('button', { name: 'Entrer comme élève' }).click();
      await expect(page.getByRole('heading', { name: 'Salut Lilou !' })).toBeVisible();
      await page.getByRole('link', { name: 'Mon profil' }).click();
      await expect(page.getByTestId('login-id')).toHaveText(loginId);
      await shot(page, `${label}-5-profil`);
    });

    test('le parent voit l\'identifiant, renomme (doublon refusé) et demande un nouvel identifiant', async ({ page }) => {
      await fake.reset({ role: 'parent', family: true, student: true });
      await login(page, 'parent');
      await expect(page.getByTestId('login-stu1')).toHaveText('lila-7k2fm');
      await page.getByLabel(/^Surnom de départ/).fill('Zoe');
      await page.getByLabel(/J'ai l'autorité parentale/).check();
      await page.getByRole('button', { name: 'Créer et obtenir le lien' }).click();
      await expect(page.getByRole('heading', { name: /Lien d'activation de Zoe/ })).toBeVisible();
      await page.getByRole('button', { name: 'Fermer' }).click();
      await page.getByRole('button', { name: 'Changer le surnom' }).first().click();
      await page.getByLabel(/Nouveau surnom pour Lila/).fill('zoe');
      await page.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(page.getByText(/déjà pris dans ta famille/)).toBeVisible();
      await shot(page, `${label}-6-parent-doublon`);
      await page.getByLabel(/Nouveau surnom pour Lila/).fill('Lilou');
      await page.getByRole('button', { name: 'Enregistrer' }).click();
      await expect(page.getByRole('heading', { name: 'Lilou', exact: true })).toBeVisible();
      page.once('dialog', (d) => void d.accept());
      await page.getByRole('button', { name: 'Nouvel identifiant de connexion' }).first().click();
      const card = page.getByRole('heading', { name: /Nouvel identifiant de Lilou/ });
      await expect(card).toBeVisible();
      await expect(page.getByTestId('login-id').first()).toHaveText(/^lila-[a-z0-9]{5}$/);
      await expect(page.getByTestId('login-id').first()).not.toHaveText('lila-7k2fm');
      await shot(page, `${label}-7-parent-nouvel-identifiant`);
    });
  });
}
});
