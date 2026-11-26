import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// M1 #89: ajouter une phrase oubliée à la relecture (contrat 1.10.0). Réponses fabriquées ici (page.route), aucun modèle, aucune photo réelle.
// PC puis mobile. Captures facultatives dans M1_SHOTS, relues à la main.
const SHOTS = process.env.M1_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const S = (id: string, text: string) => ({ id, text });
const LONG = Array.from({ length: 30 }, (_, k) => `mot${k}`).join(' ');
const TRANSCRIPTION = {
  jobId: 'J1', docType: 'cours', suggestedSubject: 'svt', suggestedTopic: 'La cellule',
  pages: [{ page: 1, sentences: [S('p1-s1', 'La cellule'), S('p1-s2', `La cellule est la plus petite unité du vivant ${LONG}.`), S('p1-s3', 'Le noyau contient l\'ADN et il dirige la vie de la cellule.'), S('p1-s4', 'Elle est entourée par une membrane qui protège son contenu.')] }],
  blocks: [{ id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] }, { id: 'b2', kind: 'paragraphe', sentenceIds: ['p1-s2', 'p1-s3', 'p1-s4'] }],
  photoUrls: ['data:image/svg+xml;utf8,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22600%22 height=%22400%22%3E%3Crect width=%22600%22 height=%22400%22 fill=%22%23fffdf5%22/%3E%3C/svg%3E'], photoUrlsExpireAt: '2099-01-01T00:00:00Z',
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
const ok = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const job = (state: string) => ({ jobId: 'J1', state, pages: 1, createdAt: '2026-12-01T10:00:00Z', expiresAt: '2099-01-01T00:00:00Z', status: { stage: state === 'a_confirmer' ? 'a_confirmer' : 'verification', pagesDone: 1, pagesTotal: 1, startedAt: '2026-12-01T10:00:00Z' } });

async function routes(page: Page, bodies: Record<string, unknown>[]) {
  await page.route('**/jobs/J1', (r) => r.fulfill(ok(job('a_confirmer'))));
  await page.route('**/jobs/J1/transcription', (r) => r.fulfill(ok(TRANSCRIPTION)));
  await page.route('**/jobs/J1/confirm', (r) => {
    bodies.push(r.request().postDataJSON());
    return r.fulfill(ok(job('verification')));
  });
}

for (const [label, viewport] of [['PC', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Phrase oubliée (M1 #89), ${label}`, () => {
    test.skip(!isMock, 'Mode mock seulement (réponses fabriquées)');
    test.use({ viewport });
    test.beforeEach(async () => {
      await fake.reset();
    });

    test('ajouter après une phrase, au début, en nouveau paragraphe; refus; envoi', async ({ page }) => {
      const bodies: Record<string, unknown>[] = [];
      await login(page, 'eleve');
      await routes(page, bodies);
      await page.goto('/#/job/J1');
      await expect(page.getByRole('heading', { name: "Vérifie ce que j'ai lu" })).toBeVisible();
      await expect(page.locator('.doc [style]')).toHaveCount(0); // la politique de sécurité refuse les styles en ligne
      await shot(page, `1-relecture-${label}`);

      // ajout au milieu du paragraphe, après la phrase 2
      await page.locator('button.cf-sent', { hasText: 'plus petite unité' }).click();
      await page.getByRole('button', { name: /Ajouter une phrase après celle-ci/ }).click();
      const box = page.locator('#cf-add-in');
      await expect(box).toBeFocused();
      await box.pressSequentially('ab');
      await expect(page.getByRole('alert')).toContainText('au moins 3 caractères');
      await expect(page.getByRole('button', { name: 'Ajouter la phrase' })).toBeDisabled();
      await box.pressSequentially('c La membrane est faite de lipides.');
      await shot(page, `2-ajout-en-cours-${label}`);
      await page.getByRole('button', { name: 'Ajouter la phrase' }).click();
      const added = page.locator('button.cf-sent.is-added');
      await expect(added).toHaveCount(1);
      await expect(added).toContainText('La membrane est faite de lipides.');
      await expect(page.locator('p.doc-p').first().locator('button.cf-sent')).toHaveCount(4); // elle a rejoint le paragraphe
      await expect(page.locator('.cf-tagadd')).toHaveText('Ajoutée par toi');
      await expect(page.locator('.confirm').getByText(/vérifié/i)).toHaveCount(0);

      // au tout début, puis une formule en LaTeX avec aperçu
      await page.getByRole('button', { name: /Ajouter une phrase au début du texte/ }).click();
      await page.locator('#cf-add-in').pressSequentially('Cours de sciences, avec $E = mc^{2}$.');
      await expect(page.locator('.cf-addedit .cf-preview math')).toHaveCount(1);
      await page.locator('#cf-add-in').press('Enter');
      await expect(page.locator('button.cf-sent.is-added')).toHaveCount(2);
      await expect(page.locator('p.doc-p').first()).toContainText('Cours de sciences'); // nouveau paragraphe avant le titre

      // nouveau paragraphe voulu après la dernière phrase
      await page.locator('button.cf-sent', { hasText: 'entourée par une membrane' }).click();
      await page.getByRole('button', { name: /Ajouter une phrase après celle-ci/ }).click();
      await page.locator('#cf-add-in').pressSequentially('Un dernier point oublié.');
      await page.getByRole('checkbox', { name: /nouveau paragraphe/ }).check();
      await page.getByRole('button', { name: 'Ajouter la phrase' }).click();
      await expect(page.locator('p.doc-p')).toHaveCount(3);
      await expect(page.getByText(/7 phrases, 0 corrigée, 3 ajoutées/)).toBeVisible();
      await shot(page, `3-phrases-ajoutees-${label}`);

      // formule interdite: refusée à l'écran
      await page.locator('button.cf-sent', { hasText: 'dernier point' }).click();
      await page.getByRole('button', { name: /Ajouter une phrase après celle-ci/ }).click();
      await page.locator('#cf-add-in').pressSequentially('Voir $\\href{http://a}{b}$');
      await expect(page.getByRole('button', { name: 'Ajouter la phrase' })).toBeDisabled();
      await page.locator('.cf-addedit').getByRole('button', { name: 'Annuler' }).click();
      await shot(page, `4-refus-${label}`);

      await page.getByRole('button', { name: /C'est bon, vérifie/ }).click();
      await expect.poll(() => bodies.length).toBe(1);
      expect(bodies[0].corrections).toEqual([]);
      expect(bodies[0].added).toEqual([
        { key: 'n1', afterId: 'p1-s2', text: 'abc La membrane est faite de lipides.' },
        { key: 'n2', afterId: null, text: 'Cours de sciences, avec $E = mc^{2}$.', newBlock: true },
        { key: 'n3', afterId: 'p1-s4', text: 'Un dernier point oublié.', newBlock: true },
      ]);
    });
  });
}
