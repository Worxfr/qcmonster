import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { API, isMock } from '../support/env';

// Q1 (#42, #72): banque de questions variees, tirage, S'entrainer sur plusieurs fiches ou un dossier, 50 XP par fiche. Mode mock seulement.
const SHOTS = process.env.Q1_SHOTS; // dossier de captures facultatif (relues a la main)
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const hash = async (page: Page, path: string) => {
  await page.evaluate((h) => { window.location.hash = h; }, path);
};
const xp = async (): Promise<number> => ((await (await fetch(`${API}/me/progress`)).json()) as { xp: number }).xp;

/** Repond a toutes les questions affichees (justes ou fausses); renvoie les enonces vus, dans l'ordre. */
async function playAll(page: Page, right = true): Promise<string[]> {
  const seen: string[] = [];
  await page.getByRole('heading', { name: /Question \d+ sur/ }).waitFor();
  while (await page.getByRole('heading', { name: /Question \d+ sur/ }).count()) {
    const prompt = (await page.locator('.prompt').innerText()).trim();
    seen.push(prompt);
    const choices = page.locator('.choices button');
    if (await choices.count()) {
      if (right) await page.getByRole('button', { name: /^Bonne \d+$/ }).click();
      else await choices.nth(1).click();
    } else {
      const k = /(\d+) :/.exec(prompt)?.[1];
      await page.getByLabel('Ta réponse').fill(right ? `mot${k}` : 'x');
      await page.getByRole('button', { name: 'Valider' }).click();
    }
    await page.getByRole('button', { name: /Suivant|Terminer/ }).click();
  }
  return seen;
}
const chooseSize = (page: Page, n: number) => page.getByRole('button', { name: String(n), exact: true }).click();

test.describe('Banque de questions et entraînement multi-fiches', () => {
  test.skip(!isMock, 'Mode mock seulement');
  test.beforeEach(async () => {
    await fake.reset();
  });

  test('deux tests de suite sur la même fiche ne partagent aucune question', async ({ page }) => {
    const { docs } = await fake.seed({ docs: [{ title: 'La cellule', subject: 'svt', questions: 20 }] });
    await login(page, 'eleve');
    await hash(page, `/quiz/${docs[0]}`);
    await expect(page.getByRole('heading', { name: 'Question 1 sur 10' })).toBeVisible();
    const first = await playAll(page);
    await expect(page.getByRole('heading', { name: 'Bravo !' })).toBeVisible();
    await hash(page, '/jeu');
    await hash(page, `/quiz/${docs[0]}`);
    await expect(page.getByRole('heading', { name: 'Question 1 sur 10' })).toBeVisible();
    const second = await playAll(page);
    expect(first).toHaveLength(10);
    expect(second).toHaveLength(10);
    expect(second.filter((q) => first.includes(q))).toEqual([]);
  });

  test('choisir 3 fiches, voir la fiche d\'origine, finir et retrouver un seul passage « 3 fiches »', async ({ page }) => {
    await fake.seed({ docs: [{ title: 'Les volcans', questions: 8 }, { title: 'Les fleuves', questions: 8 }, { title: 'Les déserts', questions: 8 }, { title: 'Les îles', questions: 8 }] });
    await login(page, 'eleve');
    await hash(page, '/docs');
    await page.getByRole('button', { name: 'Choisir des cours' }).click();
    for (const t of ['Les volcans', 'Les fleuves', 'Les déserts']) await page.getByLabel(`Choisir ${t}`).check();
    await shot(page, 'choix-fiches');
    await page.getByRole('button', { name: /S'entraîner sur ces 3 fiches/ }).click();
    await expect(page.getByRole('heading', { name: "S'entraîner" })).toBeVisible();
    await chooseSize(page, 5);
    await shot(page, 'choix-taille');
    await page.getByRole('button', { name: /Commencer/ }).click();
    await expect(page.getByRole('heading', { name: 'Question 1 sur 5' })).toBeVisible();
    await expect(page.locator('.from-doc')).toContainText(/Les (volcans|fleuves|déserts)/);
    await shot(page, 'question-multi');
    await playAll(page);
    await expect(page.getByRole('heading', { name: 'Bravo !' })).toBeVisible();
    await expect(page.getByText('Tu as vu 3 fiches.')).toBeVisible();
    await shot(page, 'fin-multi');
    await hash(page, '/tests');
    await expect(page.getByText('3 fiches').first()).toBeVisible();
    await shot(page, 'historique-multi');
  });

  test('entraînement sur un dossier; une fiche sans question est dite et ignorée', async ({ page }) => {
    await fake.seed({ folders: ['Géographie'], docs: [{ title: 'Les volcans', folder: 'Géographie', questions: 6 }, { title: 'Les fleuves', folder: 'Géographie', questions: 6 }, { title: 'Fiche vide', folder: 'Géographie', questions: 0 }] });
    await login(page, 'eleve');
    await hash(page, '/folders');
    await expect(page.getByRole('button', { name: /S'entraîner sur ce dossier/ })).toBeEnabled();
    await shot(page, 'dossiers');
    await page.getByRole('button', { name: /S'entraîner sur ce dossier/ }).click();
    await page.getByRole('button', { name: /Commencer/ }).click();
    await expect(page.getByText('1 fiche n\'a pas encore de questions.')).toBeVisible();
    await expect(page.locator('.from-doc')).toContainText(/Les (volcans|fleuves)/);
    await playAll(page);
    await expect(page.getByText('Tu as vu 2 fiches.')).toBeVisible();
    await hash(page, '/tests');
    await expect(page.getByText('Géographie').first()).toBeVisible();
  });

  test('dossier vide: le bouton est grisé', async ({ page }) => {
    await fake.seed({ folders: ['Vide'] });
    await login(page, 'eleve');
    await hash(page, '/folders');
    await expect(page.getByRole('button', { name: /S'entraîner sur ce dossier/ })).toBeDisabled();
  });

  test('dossier dont aucune fiche n\'a de question: message clair', async ({ page }) => {
    await fake.seed({ folders: ['Sans question'], docs: [{ title: 'Fiche vide', folder: 'Sans question', questions: 0 }] });
    await login(page, 'eleve');
    await hash(page, '/folders');
    await page.getByRole('button', { name: /S'entraîner sur ce dossier/ }).click();
    await page.getByRole('button', { name: /Commencer/ }).click();
    await expect(page.getByRole('alert')).toContainText("n'ont pas encore de questions");
  });

  test('banque trop petite: test plus court et message « N questions différentes »', async ({ page }) => {
    const { docs } = await fake.seed({ docs: [{ title: 'Petite fiche', questions: 3 }] });
    await login(page, 'eleve');
    await hash(page, `/quiz/${docs[0]}`);
    await expect(page.getByRole('heading', { name: 'Question 1 sur 3' })).toBeVisible();
    await playAll(page);
    await expect(page.getByText("Cette banque n'a que 3 questions différentes.")).toBeVisible();
    await shot(page, 'banque-courte');
  });

  test('fiche supprimée pendant un test: la question est sautée', async ({ page }) => {
    const { docs } = await fake.seed({ docs: [{ title: 'Fiche A', questions: 6 }, { title: 'Fiche B', questions: 6 }] });
    await login(page, 'eleve');
    await hash(page, `/entrainement?docIds=${docs.join(',')}`);
    await chooseSize(page, 5);
    await page.getByRole('button', { name: /Commencer/ }).click();
    await expect(page.getByRole('heading', { name: 'Question 1 sur 5' })).toBeVisible();
    await fetch(`${API}/docs/${docs[0]}`, { method: 'DELETE' });
    let sawNotice = false;
    while (await page.getByRole('heading', { name: /Question \d+ sur/ }).count()) {
      const title = await page.locator('.from-doc').innerText();
      if (title.includes('Fiche A')) {
        // la réponse échoue (404): le site saute la question sans bloquer le test
        const c = page.locator('.choices button');
        if (await c.count()) await c.first().click();
        else { await page.getByLabel('Ta réponse').fill('x'); await page.getByRole('button', { name: 'Valider' }).click(); }
        await expect(page.getByText("Cette fiche n'existe plus, on passe à la question suivante.")).toBeVisible();
        sawNotice = true;
      } else {
        const c = page.locator('.choices button');
        if (await c.count()) await c.first().click();
        else { await page.getByLabel('Ta réponse').fill('x'); await page.getByRole('button', { name: 'Valider' }).click(); }
        await page.getByRole('button', { name: /Suivant|Terminer/ }).click();
      }
    }
    expect(sawNotice).toBe(true);
    await expect(page.getByRole('heading', { name: 'Bravo !' })).toBeVisible();
  });

  test('une fiche déjà à 50 XP: le test continue, le message s\'affiche et les points ne bougent plus', async ({ page }) => {
    const { docs } = await fake.seed({ docs: [{ title: 'Grosse fiche', questions: 20 }] });
    await login(page, 'eleve');
    await hash(page, `/quiz/${docs[0]}`);
    await playAll(page); // 10 bonnes réponses = 50 XP
    expect(await xp()).toBe(50);
    await hash(page, '/jeu');
    await hash(page, `/quiz/${docs[0]}`);
    await expect(page.getByRole('heading', { name: 'Question 1 sur 10' })).toBeVisible();
    await playAll(page); // 10 autres bonnes réponses: corrigées, sans points
    await expect(page.getByRole('heading', { name: 'Bravo !' })).toBeVisible();
    await expect(page.getByText('Tu as gagné tous les points de cette fiche (50 sur 50). Tu peux continuer pour t\'entraîner.')).toBeVisible();
    await expect(page.getByRole('status').first()).toContainText('10 bonnes réponses sur 10, +0 XP');
    expect(await xp()).toBe(50);
    await shot(page, 'fiche-pleine');
  });

  test('deux onglets: le premier reçoit un 409 et reprend avec un nouveau tirage', async ({ page }) => {
    const { docs } = await fake.seed({ docs: [{ title: 'La cellule', questions: 20 }] });
    await login(page, 'eleve');
    await hash(page, `/quiz/${docs[0]}`);
    await expect(page.getByRole('heading', { name: 'Question 1 sur 10' })).toBeVisible();
    // Le 2e onglet ouvre un nouveau test (même appel que le site): le premier test n'est plus le test ouvert.
    const tab2 = (await (await fetch(`${API}/docs/${docs[0]}/session`)).json()) as { questions: { questionId: string }[] };
    for (const q of tab2.questions) await fetch(`${API}/answers`, { method: 'POST', body: JSON.stringify({ questionId: q.questionId, choice: 'x' }) }); // ces questions sont maintenant « vues »
    expect((await fetch(`${API}/docs/${docs[0]}/session`)).status).toBe(200); // nouveau tirage: les 10 autres questions
    await page.locator('.choices button, button:has-text("Valider")').first().click().catch(() => undefined);
    if (await page.getByLabel('Ta réponse').count()) {
      await page.getByLabel('Ta réponse').fill('x');
      await page.getByRole('button', { name: 'Valider' }).click();
    }
    await expect(page.getByText('Ton test a été rouvert ailleurs, on reprend ici.')).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Question 1 sur 10' })).toBeVisible();
  });

  test('le parent ne voit aucune question après un test multi-fiches; une réponse hors tirage est refusée (409)', async ({ page }) => {
    const { docs } = await fake.seed({ docs: [{ title: 'Fiche A', questions: 6 }, { title: 'Fiche B', questions: 6 }] });
    await login(page, 'eleve');
    await hash(page, `/entrainement?docIds=${docs.join(',')}`);
    await chooseSize(page, 5);
    await page.getByRole('button', { name: /Commencer/ }).click();
    await playAll(page);
    // Question hors du tirage: 409, rien n'est révélé.
    const out = await fetch(`${API}/answers`, { method: 'POST', body: JSON.stringify({ questionId: `${docs[0]}-b99`, choice: 'x' }) });
    expect([404, 409]).toContain(out.status);
    const mine = (await (await fetch(`${API}/me/tests`)).json()) as { items: { testId: string; scope?: string; docIds?: string[]; titre: string }[] };
    expect(mine.items[0]).toMatchObject({ scope: 'fiches', titre: '2 fiches', docIds: docs });
    await fake.role('parent');
    const view = await (await fetch(`${API}/students/stu1/tests/${mine.items[0].testId}`)).text();
    expect(view).not.toMatch(/Question \d|prompt|choices|correctAnswer|Bonne \d|"choice"/);
    expect(JSON.parse(view).questions.length).toBeGreaterThan(0); // seulement juste ou faux
  });
});

test.describe('Entraînement multi-fiches sur mobile', () => {
  test.skip(!isMock, 'Mode mock seulement');
  test.use({ viewport: { width: 390, height: 844 }, hasTouch: true });
  test('dossier: choix de la taille, question avec sa fiche, fin', async ({ page }) => {
    await fake.reset();
    await fake.seed({ folders: ['Géographie'], docs: [{ title: 'Les volcans', folder: 'Géographie', questions: 6 }, { title: 'Les fleuves', folder: 'Géographie', questions: 6 }] });
    await login(page, 'eleve');
    await hash(page, '/folders');
    await shot(page, 'm-dossiers');
    await page.getByRole('button', { name: /S'entraîner sur ce dossier/ }).click();
    await shot(page, 'm-choix');
    await chooseSize(page, 5);
    await page.getByRole('button', { name: /Commencer/ }).click();
    await expect(page.locator('.from-doc')).toBeVisible();
    await shot(page, 'm-question');
    await playAll(page);
    await expect(page.getByText('Tu as vu 2 fiches.')).toBeVisible();
    await shot(page, 'm-fin');
  });
});
