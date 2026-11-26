import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// Historique des tests (H1-W): écran élève, vue parent, archive, ré-acceptation de la politique. API factice: mode mock seulement.
test.skip(!isMock, 'Mode mock seulement (données fabriquées)');

// Captures pour la relecture visuelle (facultatif): H1W_SHOTS=/chemin/dossier
const SHOTS = process.env.H1W_SHOTS;
async function shot(page: Page, name: string) {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
}

test.describe('Historique côté élève', () => {
  test('liste groupée par année scolaire, filtre par année et pages suivantes', async ({ page }) => {
    await fake.reset({ role: 'eleve' });
    await fake.history();
    await login(page, 'eleve');
    await page.getByRole('link', { name: /Tests/ }).click();
    await expect(page.getByRole('heading', { name: /Mes tests/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: /Année 2026 - 2027/ })).toBeVisible();
    await expect(page.locator('.test-row')).toHaveCount(20); // première page
    await expect(page.getByRole('heading', { name: /Année 2025 - 2026/ })).toHaveCount(0);
    await shot(page, 'eleve-liste-pc');
    await page.getByRole('button', { name: 'Voir les tests plus anciens' }).click();
    await expect(page.getByRole('heading', { name: /Année 2025 - 2026/ })).toBeVisible();
    await expect(page.locator('.test-row')).toHaveCount(30);
    await expect(page.getByRole('button', { name: 'Voir les tests plus anciens' })).toHaveCount(0);
    // filtre: une seule année affichée
    await page.getByRole('button', { name: '2025 - 2026' }).click();
    await expect(page.locator('.test-row')).toHaveCount(6);
    await expect(page.getByRole('heading', { name: /Année 2026 - 2027/ })).toHaveCount(0);
    await expect(page.getByRole('button', { name: '2025 - 2026' })).toHaveAttribute('aria-pressed', 'true');
    await page.getByRole('button', { name: 'Toutes' }).click();
    await expect(page.locator('.test-row')).toHaveCount(20);
  });

  test("le détail montre la question, ma réponse et la bonne réponse, au clavier", async ({ page }) => {
    await fake.reset({ role: 'eleve' });
    await fake.history();
    await login(page, 'eleve');
    await page.goto('/#/tests');
    const first = page.locator('.test-row').first();
    await first.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('heading', { name: 'Tes réponses' })).toBeVisible();
    await expect(page.getByText('Que produit la photosynthèse ?')).toBeVisible();
    await expect(page.getByText('Bonne réponse').first()).toBeVisible();
    await shot(page, 'eleve-detail-pc');
    await page.getByRole('link', { name: '‹ Mes tests' }).click();
    await expect(page.getByRole('heading', { name: /Mes tests/ })).toBeVisible();
  });

  test("sans test, l'écran invite à en faire un", async ({ page }) => {
    await fake.reset({ role: 'eleve' });
    await login(page, 'eleve');
    await page.goto('/#/tests');
    await expect(page.getByText("Tu n'as pas encore fait de test")).toBeVisible();
  });
});

test.describe('Vue parent', () => {
  test("avancement et résultat par question, sans texte de question ni réponse de l'élève", async ({ page }) => {
    await fake.reset({ role: 'parent' });
    await fake.history();
    await login(page, 'parent');
    await page.getByRole('link', { name: /Suivi de Lila/ }).click();
    await expect(page.getByRole('heading', { name: /Suivi de Lila/ })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Par matière' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Les fiches' })).toBeVisible();
    await shot(page, 'parent-suivi-pc');
    await page.locator('.test-row').first().click();
    await expect(page.getByRole('heading', { name: 'Résultat par question' })).toBeVisible();
    await expect(page.getByText('Question 1')).toBeVisible();
    await expect(page.getByText(/Juste du premier coup|À revoir/).first()).toBeVisible();
    // Jamais de texte de question ni de réponse côté parent
    const body = await page.locator('main').innerText();
    expect(body).not.toContain('photosynthèse ?');
    expect(body).not.toContain('Bastille');
    expect(body).not.toContain('Du dioxygène');
    expect(body).not.toContain('azote');
    await shot(page, 'parent-detail-pc');
  });
});

test.describe('Archive et politique', () => {
  test("archive: lien valable 10 minutes, puis message clair au 4e essai (429)", async ({ page }) => {
    await fake.reset({ role: 'parent' });
    await fake.history();
    await login(page, 'parent');
    const ask = page.getByRole('button', { name: "Préparer l'archive" });
    await ask.click();
    await expect(page.getByText('Ton archive est prête')).toBeVisible();
    await expect(page.getByRole('link', { name: /Télécharger l'archive/ })).toHaveAttribute('href', /__archive\/1\.zip/);
    await shot(page, 'parent-archive-pc');
    await ask.click();
    await ask.click();
    await expect(page.getByText('Ton archive est prête')).toBeVisible();
    await ask.click();
    await expect(page.getByRole('alert')).toContainText('3 archives cette heure');
    await expect(page.getByRole('link', { name: /Télécharger l'archive/ })).toBeVisible(); // le lien précédent, encore valable, reste affiché
  });

  test("un parent dont la politique est périmée la relit et l'accepte avant d'accéder au tableau de bord", async ({ page }) => {
    await fake.reset({ role: 'parent' });
    await fake.policyOutdated();
    await login(page, 'parent');
    await expect(page.getByRole('heading', { name: 'La politique de confidentialité a changé' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Pages de la famille' })).toHaveCount(0);
    const ok = page.getByRole('button', { name: "J'accepte la nouvelle politique" });
    await expect(ok).toBeDisabled();
    await shot(page, 'parent-politique-pc');
    await page.getByRole('checkbox').check();
    await ok.click();
    await expect(page.getByRole('heading', { name: 'Pages de la famille' })).toBeVisible();
    await page.reload();
    await expect(page.getByRole('heading', { name: 'Pages de la famille' })).toBeVisible(); // ne redemande pas
  });

  test("sans accepter, le parent peut retirer son accord: confirmation puis suppression de la famille", async ({ page }) => {
    await fake.reset({ role: 'parent' });
    await fake.policyOutdated();
    await login(page, 'parent');
    await expect(page.getByRole('button', { name: 'Télécharger mes données' })).toBeVisible();
    await shot(page, 'parent-politique-refus-pc');
    page.once('dialog', (d) => void d.dismiss()); // refus de la confirmation: la famille reste
    await page.getByRole('button', { name: 'Supprimer la famille et les comptes' }).click();
    await expect(page.getByRole('heading', { name: 'La politique de confidentialité a changé' })).toBeVisible();
    page.once('dialog', (d) => void d.accept());
    await page.getByRole('button', { name: 'Supprimer la famille et les comptes' }).click();
    await expect(page.getByRole('heading', { name: 'QCMonster' })).toBeVisible(); // retour à la connexion
    await fake.role('parent');
    await page.getByRole('button', { name: 'Entrer comme parent' }).click();
    await expect(page.getByRole('heading', { name: 'Bienvenue !' })).toBeVisible(); // la famille n'existe plus
  });
});

test.describe('Mobile', () => {
  test.use({ viewport: { width: 390, height: 800 } });
  test("liste, détail et suivi tiennent à l'écran, sans défilement horizontal", async ({ page }) => {
    await fake.reset({ role: 'eleve' });
    await fake.history();
    await login(page, 'eleve');
    await page.goto('/#/tests');
    await expect(page.locator('.test-row').first()).toBeVisible();
    const noOverflow = () => page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(await noOverflow()).toBe(true);
    await shot(page, 'eleve-liste-mobile');
    await page.locator('.test-row').first().click();
    await expect(page.getByRole('heading', { name: 'Tes réponses' })).toBeVisible();
    expect(await noOverflow()).toBe(true);
    await shot(page, 'eleve-detail-mobile');
    // M3: l'anneau large garde sa taille sur mobile et son centre reste dans l'anneau
    const ring = await page.locator('.score-l').boundingBox();
    const inner = await page.locator('.score-l .score-in').boundingBox();
    expect(ring && ring.width >= 90).toBe(true);
    expect(ring && inner && inner.width < ring.width).toBe(true);
    await fake.role('parent');
    await page.goto('/');
    await page.getByRole('button', { name: 'Déconnexion' }).click();
    await login(page, 'parent');
    await page.getByRole('link', { name: /Suivi de Lila/ }).click();
    await expect(page.getByRole('heading', { name: 'Tous les tests' })).toBeVisible();
    expect(await noOverflow()).toBe(true);
    await shot(page, 'parent-suivi-mobile');
    // M2: dans « Les fiches », le titre ne chevauche pas le score
    const card = page.locator('.fiche-card').first();
    const t = await card.locator('strong').first().boundingBox();
    const sc = await card.locator('.fiche-score').boundingBox();
    expect(t && sc && (t.y + t.height <= sc.y + 1 || t.x + t.width <= sc.x + 1)).toBe(true);
  });
});
