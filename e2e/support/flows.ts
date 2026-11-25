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

/**
 * Relecture: corrige une phrase (la 2e du texte), coupe en 2 fiches entre les pages 1 et 2, règle matière et sujet de chaque fiche.
 * Renvoie le texte corrigé de la phrase, à retrouver dans le cours complet.
 */
export async function reviewTwoSections(page: Page): Promise<string> {
  await waitForReview(page);
  // 1. corriger une phrase (en mock, la 2e phrase contient la faute « chloropastes »)
  const box = page.locator('textarea.cf-text').nth(1);
  const before = await box.inputValue();
  const after = before.includes('chloropastes') ? before.replace('chloropastes', 'chloroplastes') : `${before} (relu)`;
  await box.fill(after);
  await expect(page.getByText('Modifiée')).toHaveCount(1);
  // 2. couper entre la page 1 et la page 2 (si la lecture n'a pas déjà proposé 2 fiches)
  if ((await page.getByRole('listitem', { name: /^Fiche \d/ }).count()) < 2) {
    await page.getByRole('button', { name: /Couper ici, entre deux pages/ }).first().click();
  }
  await expect(page.getByRole('listitem', { name: 'Fiche 2' })).toBeVisible();
  // 3. matière et sujet de chaque fiche (la fiche 1 se règle sur la page 1)
  const fill = async (n: number, subject: string, topic: string) => {
    const band = page.getByRole('listitem', { name: `Fiche ${n}` });
    await band.getByLabel('Matière').selectOption(subject);
    await band.getByLabel('Sujet').fill(topic);
  };
  await fill(2, 'histoire_geo', 'La Révolution française');
  await page.getByRole('tab', { name: /^Page 1/ }).click();
  await fill(1, 'svt', 'La photosynthèse');
  await expect(page.getByRole('button', { name: "C'est bon, fais 2 fiches" })).toBeEnabled();
  await page.getByRole('button', { name: "C'est bon, fais 2 fiches" }).click();
  return after;
}

/** Après la confirmation: attend la fin du traitement. */
export async function waitForFiches(page: Page) {
  await expect(page.getByRole('heading', { name: 'Ta fiche est prête' })).toBeVisible({ timeout: SLOW });
  await expect(page.getByText(/2 fiches sont prêtes/)).toBeVisible();
}
