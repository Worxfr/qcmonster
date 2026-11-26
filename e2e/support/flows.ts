import { expect, type Page } from '@playwright/test';
import { isMock } from './env';
import { makePhotos } from './app';

export const SLOW = isMock ? 15_000 : 300_000; // attente de la lecture et de la fabrication des fiches

/** Envoie `n` photos fabriquées depuis l'écran « Scanner ». Termine sur la page du scan (#/job/...). Renvoie l'identifiant du scan. */
export async function sendPhotos(page: Page, n: number, folderName?: string): Promise<string> {
  const files = await makePhotos(page, n);
  await page.goto('/#/scan');
  await page.locator('input[type=file]').setInputFiles(files);
  await expect(page.getByRole('list', { name: /Pages à envoyer/ }).getByRole('listitem')).toHaveCount(n);
  if (folderName) await page.getByLabel('Ranger dans un dossier (facultatif)').selectOption({ label: folderName });
  await page.getByRole('button', { name: new RegExp(`^Envoyer ${n} pages?$`) }).click();
  await expect(page).toHaveURL(/#\/job\//, { timeout: 30_000 });
  return decodeURIComponent(page.url().split('/job/')[1]);
}

/** Attend l'écran de relecture. */
export async function waitForReview(page: Page) {
  await expect(page.getByRole('heading', { name: "Vérifie ce que j'ai lu" })).toBeVisible({ timeout: SLOW });
}

/** Délai maximal de chaque attente à l'intérieur de la relecture (la lecture du scan, elle, s'attend avec waitForReview). */
const STEP = 30_000;

/** Nombre de fiches proposées pour TOUT le texte: le résumé de l'écran compte toutes les pages, pas seulement celle qui est affichée. */
async function countFiches(page: Page): Promise<number> {
  const summary = page.locator('.cf-summary');
  await expect(summary, "Relecture: le résumé (nombre de phrases et de fiches) n'apparaît pas").toBeVisible({ timeout: STEP });
  const m = /(\d+) fiches?\s*$/.exec((await summary.innerText()).trim());
  return m ? Number(m[1]) : 1; // pas de « N fiches » dans le résumé: une seule fiche
}

/**
 * Relecture: corrige une phrase (la 2e du texte), obtient 2 fiches, règle matière et sujet de chaque fiche, confirme.
 * Si la lecture propose déjà 2 fiches (cas courant avec un vrai scan), on les garde: aucune coupe n'est ajoutée.
 * Sinon on coupe entre les pages 1 et 2. Chaque attente dure 30 s au plus. Appeler waitForReview avant.
 * Renvoie le texte corrigé de la phrase, à retrouver dans le cours complet.
 */
export async function reviewTwoSections(page: Page): Promise<string> {
  await expect(page.getByRole('heading', { name: "Vérifie ce que j'ai lu" }), "Relecture: l'écran n'est pas affiché (appeler waitForReview avant)").toBeVisible({ timeout: STEP });
  // 1. corriger une phrase (en mock, la 2e phrase contient la faute « chloropastes »)
  // La phrase se corrige à sa place: on la touche, le champ apparaît, Entrée valide.
  const sentence = page.locator('button.cf-sent').nth(1);
  await sentence.click();
  const box = page.locator('textarea.cf-text');
  const before = await box.inputValue();
  const after = before.includes('chloropastes') ? before.replace('chloropastes', 'chloroplastes') : `${before} (relu)`;
  await box.fill(after);
  await box.press('Enter');
  await expect(page.locator('button.cf-sent.is-mod')).toHaveCount(1);
  // 2. deux fiches: celles proposées par la lecture, sinon une coupe entre la page 1 et la page 2
  let n = await countFiches(page);
  if (n < 2) {
    const cut = page.getByRole('button', { name: /Couper ici, entre deux pages/ }).first();
    await expect(cut, "Relecture: ni 2 fiches proposées, ni bouton « Couper ici, entre deux pages » sur la page affichée").toBeVisible({ timeout: STEP });
    await cut.click({ timeout: STEP });
    n = await countFiches(page);
  }
  expect(n, `Relecture: ${n} fiches au lieu de 2, le test attend exactement 2 fiches`).toBe(2);
  // 3. matière et sujet de chaque fiche. Chaque fiche se règle sur la page où elle commence: on parcourt les pages.
  const subjects: Record<number, [string, string]> = { 1: ['svt', 'La photosynthèse'], 2: ['histoire_geo', 'La Révolution française'] };
  const done = new Set<number>();
  const tabs = page.getByRole('tab');
  const pageCount = (await tabs.count()) || 1;
  for (let i = 0; i < pageCount && done.size < 2; i++) {
    if ((await tabs.count()) > 0) await tabs.nth(i).click({ timeout: STEP });
    for (const k of [1, 2]) {
      const band = page.getByRole('group', { name: `Fiche ${k}`, exact: true });
      if (done.has(k) || (await band.count()) === 0) continue;
      await band.getByLabel('Matière').selectOption(subjects[k][0], { timeout: STEP });
      await band.getByLabel('Sujet').fill(subjects[k][1], { timeout: STEP });
      done.add(k);
    }
  }
  expect([...done].sort(), 'Relecture: la fiche 1 ou la fiche 2 est introuvable sur les pages').toEqual([1, 2]);
  const confirm = page.getByRole('button', { name: "C'est bon, fais 2 fiches" });
  await expect(confirm).toBeEnabled({ timeout: STEP });
  await confirm.click({ timeout: STEP });
  return after;
}

/** Après la confirmation: attend la fin du traitement. */
export async function waitForFiches(page: Page) {
  await expect(page.getByRole('heading', { name: 'Ta fiche est prête' })).toBeVisible({ timeout: SLOW });
  await expect(page.getByText(/2 fiches sont prêtes/)).toBeVisible();
}
