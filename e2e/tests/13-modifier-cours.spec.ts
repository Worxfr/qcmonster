import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// M1 #90 partie 2: modifier un cours confirme (contrat 1.11.0). Réponses fabriquées ici (page.route): aucun modèle, aucune route réelle,
// l'interrupteur REVISE_ENABLED n'est jamais touché. PC puis mobile. Captures facultatives dans M1_SHOTS, relues à la main.
const SHOTS = process.env.M1_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const S = (id: string, text: string) => ({ id, text });
const LONG = Array.from({ length: 30 }, (_, k) => `mot${k}`).join(' ');
const COURS = {
  coursId: 'C1', createdAt: '2026-12-01T10:00:00Z', pages: 1,
  texts: [{ page: 1, sentences: [S('p1-s1', 'La cellule'), S('p1-s2', `La cellule est la plus petite unité du vivant ${LONG}.`), S('p1-s3', "Le noyau contient l'ADN et il dirige la vie de la cellule."), S('p1-s4', 'Elle est entourée par une membrane qui protège son contenu.')] }],
  blocks: [{ id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] }, { id: 'b2', kind: 'paragraphe', sentenceIds: ['p1-s2', 'p1-s3', 'p1-s4'] }],
  sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', topic: 'La cellule', status: 'fiche', docId: 'D1' }],
  marks: [],
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
const ok = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const err = (status: number, code: string, message: string) => ok({ code, message }, status);
const T = '2026-12-01T10:05:00Z';
const rev = (etat: string, extra: Record<string, unknown> = {}) => ({ revisionId: 'R1', coursId: 'C1', etat, fiches: [{ docId: 'D1', etat }], createdAt: T, ...extra });

interface Seen { posts: Record<string, unknown>[]; cancels: number }
async function routes(page: Page, o: { cours?: Record<string, unknown>; create?: (n: number) => ReturnType<typeof ok>; get?: (n: number) => ReturnType<typeof ok>; cancel?: ReturnType<typeof ok> }, seen: Seen) {
  let gets = 0;
  await page.route('**/cours/C1', (r) => r.fulfill(ok(o.cours ?? COURS)));
  await page.route('**/cours/C1/revisions', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    seen.posts.push(r.request().postDataJSON());
    return r.fulfill(o.create ? o.create(seen.posts.length) : ok(rev('en_cours', { etape: 'preparation' }), 202));
  });
  await page.route('**/cours/C1/revisions/R1', (r) => r.fulfill(o.get ? o.get(++gets) : ok(rev('en_cours'))));
  await page.route('**/cours/C1/revisions/R1/cancel', (r) => {
    if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
    seen.cancels++;
    return r.fulfill(o.cancel ?? { status: 204, headers: CORS });
  });
}
async function edit(page: Page) {
  await page.getByRole('link', { name: /Modifier ce cours/ }).click();
  await expect(page.getByRole('heading', { name: 'Modifier ton cours' })).toBeVisible();
}
/** Corrige la phrase 3, retire la phrase 4, ajoute une phrase après la 2. */
async function threeChanges(page: Page) {
  await page.locator('button.cf-sent', { hasText: 'noyau contient' }).click();
  const box = page.locator('textarea.cf-text');
  await box.fill("Le noyau contient l'ADN et dirige la cellule.");
  await page.getByRole('button', { name: /Valider/ }).click();
  await page.locator('button.cf-sent', { hasText: 'entourée par une membrane' }).click();
  await page.getByRole('button', { name: /Retirer cette phrase/ }).click();
  await page.locator('button.cf-sent', { hasText: 'plus petite unité' }).click();
  await page.getByRole('button', { name: /Ajouter une phrase après celle-ci/ }).click();
  await page.locator('#cf-add-in').pressSequentially('Les cellules se divisent pour grandir.');
  await page.getByRole('button', { name: 'Ajouter la phrase' }).click();
}

for (const [label, viewport] of [['PC', { width: 1280, height: 900 }], ['mobile', { width: 390, height: 844 }]] as const) {
  test.describe(`Modifier un cours (M1 #90), ${label}`, () => {
    test.skip(!isMock, 'Mode mock seulement (réponses fabriquées)');
    test.use({ viewport });
    test.beforeEach(async ({ page }) => {
      await fake.reset();
      await login(page, 'eleve');
    });

    test('corriger, retirer, ajouter; suivi en cours puis terminée; la requête est exacte', async ({ page }) => {
      const seen: Seen = { posts: [], cancels: 0 };
      await routes(page, { get: () => ok(rev('terminee', { message: 'Modification terminée', fiches: [{ docId: 'D1', etat: 'terminee', numerosRestants: 12 }] })) }, seen);
      await page.goto('/#/cours/C1');
      await shot(page, `1-cours-${label}`);
      await edit(page);
      await expect(page.getByRole('button', { name: 'Enregistrer la modification' })).toBeDisabled();
      await expect(page.locator('.doc [style]')).toHaveCount(0); // la politique de sécurité refuse les styles en ligne
      await shot(page, `2-edition-vide-${label}`);
      await threeChanges(page);
      await expect(page.locator('button.cf-sent.is-mod')).toHaveCount(1);
      await expect(page.locator('button.cf-sent.is-added')).toContainText('se divisent');
      await expect(page.getByText('3 changements sur 20 au plus')).toBeVisible();
      await shot(page, `3-trois-changements-${label}`);
      await page.getByRole('button', { name: 'Enregistrer la modification' }).click();
      await expect(page.getByRole('heading', { name: 'Modification en cours' })).toBeVisible();
      await expect(page.getByText(/Je prépare tes changements/)).toBeVisible();
      await shot(page, `4-en-cours-${label}`);
      expect(seen.posts[0]).toEqual({
        corrections: [{ id: 'p1-s3', text: "Le noyau contient l'ADN et dirige la cellule." }],
        removed: ['p1-s4'],
        added: [{ key: 'n1', afterId: 'p1-s2', text: 'Les cellules se divisent pour grandir.' }],
      });
      await expect(page.getByRole('heading', { name: 'Modification terminée' })).toBeVisible();
      await expect(page.getByText(/il te reste 12 retouches/)).toBeVisible();
      await shot(page, `5-terminee-${label}`);
      await page.getByRole('link', { name: 'Voir mon cours' }).click();
      await expect(page.getByRole('heading', { name: 'Cours complet' })).toBeVisible();
    });

    test('échec: ton cours n’a pas changé, Réessayer renvoie la même demande', async ({ page }) => {
      const seen: Seen = { posts: [], cancels: 0 };
      let n = 0;
      await routes(page, { create: () => ok(rev(++n === 1 ? 'en_cours' : 'en_cours'), 202), get: () => (n === 1 ? ok(rev('echec', { message: 'La modification a échoué' })) : ok(rev('terminee', { message: 'Modification terminée' }))) }, seen);
      await page.goto('/#/cours/C1/modifier');
      await threeChanges(page);
      await page.getByRole('button', { name: 'Enregistrer la modification' }).click();
      await expect(page.getByRole('heading', { name: "La modification n'a pas marché" })).toBeVisible();
      await expect(page.getByText(/Ton cours n'a pas changé/)).toBeVisible();
      await shot(page, `6-echec-${label}`);
      await page.getByRole('button', { name: 'Réessayer' }).click();
      await expect(page.getByRole('heading', { name: 'Modification terminée' })).toBeVisible();
      expect(seen.posts).toHaveLength(2);
      expect(seen.posts[1]).toEqual(seen.posts[0]);
    });

    test('annuler pendant la modification: retour à l’édition avec le message; trop tard: message clair', async ({ page }) => {
      const seen: Seen = { posts: [], cancels: 0 };
      await routes(page, { cancel: err(409, 'etat_invalide', 'Cette modification ne peut plus être annulée') }, seen);
      await page.goto('/#/cours/C1/modifier');
      await threeChanges(page);
      await page.getByRole('button', { name: 'Enregistrer la modification' }).click();
      await page.getByRole('button', { name: 'Annuler la modification' }).click();
      await expect(page.getByText(/Trop tard pour annuler/)).toBeVisible();
      await shot(page, `7-trop-tard-${label}`);
      await page.unroute('**/cours/C1/revisions/R1/cancel');
      await page.route('**/cours/C1/revisions/R1/cancel', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : (seen.cancels++, r.fulfill({ status: 204, headers: CORS }))));
      await page.getByRole('button', { name: 'Annuler la modification' }).click();
      await expect(page.getByText("Modification annulée. Ton cours n'a pas changé.")).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Modifier ton cours' })).toBeVisible();
      await expect(page.getByRole('button', { name: 'Enregistrer la modification' })).toBeDisabled(); // l'édition repart de zéro
      await shot(page, `8-annulee-${label}`);
    });

    test('interrupteur fermé (404), parent (403), plafond (429): messages clairs, rien n’est perdu', async ({ page }) => {
      const seen: Seen = { posts: [], cancels: 0 };
      const answers = [err(404, 'introuvable', 'Introuvable'), err(403, 'interdit', 'Interdit'), err(429, 'plafond_revisions', 'Trop de modifications pour le moment')];
      await routes(page, { create: (n) => answers[n - 1] }, seen);
      await page.goto('/#/cours/C1/modifier');
      await threeChanges(page);
      const send = page.getByRole('button', { name: 'Enregistrer la modification' });
      await send.click();
      await expect(page.getByRole('alert').filter({ hasText: "pas encore ouverte" })).toBeVisible();
      await shot(page, `9-ferme-${label}`);
      await expect(page.locator('button.cf-sent.is-mod')).toHaveCount(1); // les changements sont gardés
      await send.click();
      await expect(page.getByRole('alert').filter({ hasText: "Seul l'élève" })).toBeVisible();
      await send.click();
      await expect(page.getByRole('alert').filter({ hasText: 'assez de modifications' })).toBeVisible();
    });

    test('refus locaux: première phrase d’une partie, moins de 40 mots', async ({ page }) => {
      const seen: Seen = { posts: [], cancels: 0 };
      await routes(page, {}, seen);
      await page.goto('/#/cours/C1/modifier');
      await page.locator('button.cf-sent', { hasText: 'La cellule' }).first().click();
      await page.getByRole('button', { name: /Retirer cette phrase/ }).click();
      await expect(page.getByRole('alert').filter({ hasText: 'première phrase' })).toBeVisible();
      await page.locator('button.cf-sent', { hasText: 'plus petite unité' }).click();
      await page.getByRole('button', { name: /Retirer cette phrase/ }).click(); // la phrase longue porte les mots: il en reste moins de 40
      await expect(page.getByText(/au moins 40 mots/)).toBeVisible();
      await page.locator('button.cf-sent', { hasText: 'noyau contient' }).click();
      await page.locator('textarea.cf-text').fill('Une phrase plus courte.');
      await page.getByRole('button', { name: /Valider/ }).click();
      await expect(page.getByRole('button', { name: 'Enregistrer la modification' })).toBeDisabled();
      await shot(page, `10-refus-${label}`);
      expect(seen.posts).toHaveLength(0);
    });

    test('une modification ouverte ailleurs: bannière sur le cours, l’écran la suit', async ({ page }) => {
      const seen: Seen = { posts: [], cancels: 0 };
      await routes(page, { cours: { ...COURS, revision: { revisionId: 'R1', etat: 'en_cours' } }, get: (n) => (n < 2 ? ok(rev('en_cours', { etape: 'generation' })) : ok(rev('terminee', { message: 'Modification terminée' }))) }, seen);
      await page.goto('/#/cours/C1');
      await expect(page.getByText(/Une modification de ton cours est en cours/)).toBeVisible();
      await expect(page.getByRole('link', { name: /Modifier ce cours/ })).toHaveCount(0);
      await shot(page, `11-banniere-${label}`);
      await page.getByRole('link', { name: 'Voir où ça en est' }).click();
      await expect(page.getByRole('heading', { name: 'Modification en cours' })).toBeVisible();
      await expect(page.getByRole('heading', { name: 'Modification terminée' })).toBeVisible();
      expect(seen.posts).toHaveLength(0);
    });

    test('historique: une question retirée garde son texte et son étiquette', async ({ page }) => {
      await page.route('**/me/tests/T1', (r) => r.fulfill(ok({ testId: 'T1', startedAt: T, docId: 'D1', scope: 'fiche', questionCount: 2, correctCount: 1, xpGained: 5, questions: [
        { questionId: 'D1:qcm:01', rank: 1, kind: 'qcm', correct: true, attempts: 1, firstTry: true, xpGained: 5, answeredAt: T, choice: 'B', prompt: 'Que contient le noyau ?', choices: ['A', 'B'], correctAnswer: 'B', retired: true },
        { questionId: 'D1:qcm:02', rank: 2, kind: 'qcm', correct: false, attempts: 1, firstTry: false, xpGained: 0, answeredAt: T, choice: 'A', prompt: 'Quelle autre question ?', choices: ['A', 'B'], correctAnswer: 'B' },
      ] })));
      await page.goto('/#/tests/T1');
      await expect(page.getByText('Que contient le noyau ?')).toBeVisible();
      await expect(page.getByText('Question retirée après une correction du cours')).toHaveCount(1);
      await shot(page, `12-historique-${label}`);
    });
  });
}
