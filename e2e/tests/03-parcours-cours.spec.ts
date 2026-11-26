import { expect, test, type Page } from '@playwright/test';
import { fake, login, logout } from '../support/app';
import { creds, isMock, takeRealScan } from '../support/env';
import { SLOW, reviewTwoSections, sendPhotos, waitForFiches, waitForReview } from '../support/flows';

// Un seul parcours, en série: chaque étape s'appuie sur la précédente (comme l'élève réel).
// Mode dev: ce parcours utilise UN vrai scan (E2E_REAL_SCANS >= 1).
test.describe.configure({ mode: 'serial' });

let page: Page;
let corrected = '';

test.describe('Parcours complet: scan, relecture, fiches, jeu, dossiers, parent, suppression', () => {
  test.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await fake.reset();
  });
  test.afterAll(async () => {
    await page.close();
  });
  test.beforeAll(() => {
    test.skip(!takeRealScan(), 'Budget de vrais scans épuisé (E2E_REAL_SCANS=0 par défaut)');
  });

  test("l'élève envoie 3 images et suit le scan", async () => {
    await login(page, 'eleve');
    await expect(page.getByRole('heading', { name: /^Salut / })).toBeVisible();
    await sendPhotos(page, 3);
    await expect(page.getByRole('list', { name: 'Étapes du traitement' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Ton cours est en route' })).toBeVisible();
  });

  test('Scanner montre le scan en cours, puis « À relire »; Mes cours reste vide', async () => {
    await page.goto('/#/docs');
    await expect(page.getByText(/Scanne ton premier cours/)).toBeVisible();
    await expect(page.getByRole('region', { name: /En cours/ })).toHaveCount(0);
    await page.goto('/#/scan');
    const running = page.getByRole('region', { name: 'Mes scans en cours' });
    await expect(running).toBeVisible();
    await expect(running).toContainText(/\d sur 3 pages/);
    await expect(running).toContainText('À relire', { timeout: SLOW });
    await expect(running.getByRole('button', { name: /Vérifier/ })).toBeVisible();
    await page.goto('/#/');
    await expect(page.getByRole('region', { name: 'À relire' })).toBeVisible();
  });

  test('relecture: correction, découpe en 2 sections, confirmation', async () => {
    await page.getByRole('region', { name: 'À relire' }).getByRole('button', { name: /Relire/ }).click();
    await waitForReview(page);
    // le texte non envoyé survit à un rechargement de la page
    corrected = await reviewTwoSections(page);
    await waitForFiches(page);
  });

  test('la liste regroupe les 2 fiches du cours avec leur matière et leur sujet', async () => {
    await page.goto('/#/docs');
    await expect(page.getByText(/Cours du .*, 2 fiches/)).toBeVisible();
    const list = page.getByRole('region', { name: 'Liste des cours' });
    await expect(list.getByText('La photosynthèse').first()).toBeVisible();
    await expect(list.getByText('La Révolution française').first()).toBeVisible();
    await expect(list.getByText(/fiche 1 sur 2/)).toBeVisible();
    await expect(list.getByText(/fiche 2 sur 2/)).toBeVisible();
  });

  test('fiche: affirmations vérifiées, sources, lecture et points', async () => {
    await page.getByRole('button', { name: /La photosynthèse/ }).first().click();
    await expect(page.getByRole('heading', { name: 'La photosynthèse' }).first()).toBeVisible();
    await expect(page.getByText('Vérifié').first()).toBeVisible();
    await page.getByRole('button', { name: /Voir les sources/ }).first().click();
    await expect(page.getByRole('link', { name: /Page de test|\(/ }).first()).toBeVisible();
    await page.getByRole('button', { name: "✓ J'ai tout lu" }).click();
    await expect(page.getByRole('status').filter({ hasText: /Bien lu|C'est noté/ })).toBeVisible();
    if (isMock) await expect(page.getByRole('status').filter({ hasText: '+10 XP' })).toBeVisible();
  });

  test('QCM et texte à trous: réponses, retour, points', async () => {
    await page.getByRole('button', { name: /S'entraîner/ }).click();
    await expect(page.getByRole('heading', { name: /Question 1 sur/ })).toBeVisible();
    // question à choix multiple
    if (isMock) await page.getByRole('button', { name: 'La photosynthèse', exact: true }).click();
    else await page.locator('.choices button').first().click();
    await expect(page.getByRole('status').filter({ hasText: /Bravo|Pas tout à fait/ })).toBeVisible();
    await page.getByRole('button', { name: /Suivant|Terminer/ }).click();
    // texte à trous (si la fiche réelle n'en a pas, on passe)
    if (await page.getByLabel('Ta réponse').count()) {
      await page.getByLabel('Ta réponse').fill(isMock ? 'la photosynthese' : 'réponse de test');
      await page.getByRole('button', { name: 'Valider' }).click();
      await expect(page.getByRole('status').filter({ hasText: /Bravo|Pas tout à fait/ })).toBeVisible();
      await page.getByRole('button', { name: /Suivant|Terminer/ }).click();
    }
    while (await page.getByRole('heading', { name: /Question \d+ sur/ }).count()) {
      const c = page.locator('.choices button').first();
      if (await c.count()) await c.click();
      else {
        await page.getByLabel('Ta réponse').fill('x');
        await page.getByRole('button', { name: 'Valider' }).click();
      }
      await page.getByRole('button', { name: /Suivant|Terminer/ }).click();
    }
    await expect(page.getByRole('heading', { name: 'Bravo !' })).toBeVisible();
    if (isMock) await expect(page.getByRole('status')).toContainText('2 bonnes réponses sur 2, +20 XP');
    await page.getByRole('button', { name: 'Voir ma progression' }).click();
    await expect(page.getByRole('heading', { name: /^Niveau \d+/ })).toBeVisible();
    if (isMock) await expect(page.locator('p', { hasText: /^30 XP$/ })).toBeVisible(); // 10 de lecture + 20 de réponses
  });

  test('dossiers: créer en rangeant une fiche, ouvrir, renommer, filtrer, trier', async () => {
    await page.goto('/#/docs');
    await page.getByRole('button', { name: 'Choisir', exact: true }).click();
    await page.getByRole('checkbox', { name: /Choisir .*photosynthèse/i }).check();
    await page.getByRole('button', { name: /Ranger dans un dossier/ }).click();
    await page.getByLabel('Dossier').selectOption({ label: '＋ Nouveau dossier…' });
    await page.getByLabel('Nom du nouveau dossier').fill('Contrôle de juin');
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await page.getByRole('button', { name: 'Ranger ici' }).click();
    await expect(page.getByText('📁 Contrôle de juin')).toBeVisible();

    await page.goto('/#/folders');
    await expect(page.getByText('1 cours')).toBeVisible();
    await page.getByRole('button', { name: 'Renommer Contrôle de juin' }).click();
    await page.getByLabel('Nouveau nom').fill('Contrôle de juillet');
    await page.getByRole('button', { name: 'Enregistrer' }).click();
    await expect(page.locator('.folder-list strong', { hasText: 'Contrôle de juillet' })).toBeVisible();
    // nom déjà pris (sans tenir compte de la casse ni des accents)
    await page.getByLabel('Nouveau dossier').fill('controle de JUILLET');
    await page.getByRole('button', { name: 'Créer', exact: true }).click();
    await expect(page.getByRole('alert')).toContainText('déjà un dossier avec ce nom');

    await page.getByRole('button', { name: /Contrôle de juillet/ }).first().click();
    await expect(page.getByRole('region', { name: 'Liste des cours' }).getByRole('listitem')).toHaveCount(1);
    // filtre par matière, puis tri par matière (deux matières: deux intitulés)
    await page.goto('/#/docs');
    const filtres = page.getByRole('button', { name: /^Filtres/ });
    if ((await filtres.getAttribute('aria-expanded')) !== 'true') await filtres.click();
    await expect(page.getByLabel('Statut')).toHaveCount(0); // Mes cours ne liste que des cours terminés
    const matiere = page.locator('#filters label', { hasText: 'Matière' }).locator('select');
    await matiere.selectOption('svt');
    await expect(page.getByRole('region', { name: 'Liste des cours' }).getByRole('listitem')).toHaveCount(1);
    await page.getByRole('button', { name: 'Effacer les filtres' }).first().click();
    await expect(matiere).toHaveValue('');
    await page.getByLabel('Trier').selectOption('subject');
    await expect(page.locator('.grp-head.l2')).toHaveCount(2);
    expect((await page.locator('.grp-head.l2').allInnerTexts()).sort()).toEqual(['Histoire-géo', 'SVT']);
    // supprimer le dossier: les cours restent
    await page.goto('/#/folders');
    await page.getByRole('button', { name: 'Supprimer Contrôle de juillet' }).click();
    await page.getByRole('button', { name: 'Oui, supprimer le dossier' }).click();
    await expect(page.getByText('Pas encore de dossier')).toBeVisible();
    await page.goto('/#/docs');
    await expect(page.getByText(/Cours du .*, 2 fiches/)).toBeVisible();
  });

  test('vue parent: titres, matières et avancement, jamais le texte du cours', async () => {
    test.skip(!isMock && !creds.parent.user, 'E2E_PARENT_USER non fourni');
    await logout(page);
    await login(page, 'parent');
    await page.getByRole('link', { name: /^📚 Les cours de / }).click();
    await expect(page.getByText('en lecture seule: ni le texte, ni les photos')).toBeVisible();
    const list = page.getByRole('region', { name: 'Liste des cours' });
    await expect(list.getByText('La photosynthèse').first()).toBeVisible();
    await expect(list.getByText('La Révolution française').first()).toBeVisible();
    // aucun bouton d'élève, aucun lien vers le cours complet ni vers un dossier
    await expect(page.getByRole('button', { name: 'Choisir', exact: true })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Cours du/ })).toHaveCount(0);
    await expect(page.getByRole('link', { name: /Mes dossiers/ })).toHaveCount(0);
    // aucune phrase du cours dans la page (ni la phrase corrigée, ni une phrase du texte fabriqué)
    const body = await page.locator('body').innerText();
    expect(body).not.toContain(corrected);
    expect(body).not.toMatch(/Bastille|chloroplastes|Terreur/);
    // même en tapant l'adresse du cours à la main, le parent n'a pas le texte
    await page.goto('/#/cours/inconnu');
    expect(await page.locator('body').innerText()).not.toMatch(/Bastille|chloroplastes|Terreur/);
    await logout(page);
  });

  test('cours complet: texte corrigé, parties colorées; suppression en gardant les fiches', async () => {
    await login(page, 'eleve');
    await page.goto('/#/docs');
    await page.getByRole('link', { name: /Cours du .*, 2 fiches/ }).click();
    await expect(page.getByRole('heading', { name: 'Cours complet' })).toBeVisible();
    await expect(page.getByText(corrected)).toBeVisible(); // la correction a bien été envoyée et gardée
    await expect(page.getByRole('list', { name: 'Parties du cours' }).getByRole('listitem')).toHaveCount(2);
    await page.getByRole('button', { name: 'Supprimer ce cours' }).click();
    await expect(page.getByRole('button', { name: 'Supprimer', exact: true })).toBeDisabled(); // choix obligatoire
    await page.getByLabel('Supprimer le cours et garder mes fiches').check();
    await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(page).toHaveURL(/#\/docs/);
    await expect(page.getByText(/Cours du .*, 2 fiches/)).toHaveCount(0); // plus de lien vers le cours
    await expect(page.getByRole('region', { name: 'Liste des cours' }).getByRole('listitem')).toHaveCount(2); // les 2 fiches restent
  });

  test('suppression d\'une fiche', async () => {
    await page.getByRole('button', { name: /La Révolution française/ }).first().click();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Supprimer cette fiche' }).click();
    await expect(page.getByRole('heading', { name: /^Salut / })).toBeVisible(); // retour à l'accueil = suppression faite
    await page.goto('/#/docs');
    await expect(page.getByRole('region', { name: 'Liste des cours' }).getByRole('listitem')).toHaveCount(1);
  });
});

// Variante « supprimer le cours ET ses fiches »: en mock seulement (un 2e scan réel coûterait de l'argent).
test.describe('Suppression du cours avec ses fiches', () => {
  test.skip(!isMock, 'Mode mock seulement');
  test('le cours et ses 2 fiches disparaissent', async ({ page }) => {
    await fake.reset();
    await login(page, 'eleve');
    await sendPhotos(page, 3);
    await waitForReview(page);
    await reviewTwoSections(page);
    await waitForFiches(page);
    await page.goto('/#/docs');
    await page.getByRole('link', { name: /Cours du .*, 2 fiches/ }).click();
    await page.getByRole('button', { name: 'Supprimer ce cours' }).click();
    await page.getByLabel('Supprimer le cours ET ses fiches').check();
    await page.getByRole('button', { name: 'Supprimer', exact: true }).click();
    await expect(page.getByText('Scanne ton premier cours')).toBeVisible();
    expect((await fake.state()).docs).toBe(0);
  });
});

// Cas d'un vrai scan: la lecture propose déjà 2 fiches (coupe avant la page 2), donc la page 1 n'en montre qu'une.
// L'aide de relecture ne doit ni cliquer « Couper ici » ni attendre: elle garde les 2 fiches proposées.
test.describe('Relecture avec 2 fiches déjà proposées', () => {
  test.skip(!isMock, 'Mode mock seulement');
  test('les 2 fiches proposées sont gardées, réglées et confirmées sans nouvelle coupe', async ({ page }) => {
    test.setTimeout(45_000);
    await fake.reset();
    await fake.suggestTwo();
    await login(page, 'eleve');
    await sendPhotos(page, 3);
    await waitForReview(page);
    await expect(page.getByText("J'ai proposé 2 fiches")).toBeVisible();
    await expect(page.getByRole('button', { name: /Couper ici, entre deux pages/ })).toHaveCount(0);
    await reviewTwoSections(page);
    await waitForFiches(page);
    expect((await fake.state()).docs).toBe(2);
  });
});
