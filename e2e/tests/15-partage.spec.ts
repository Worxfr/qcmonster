import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// S1-W (#34): partage de QCM par lien, PC puis mobile. Reponses de l'API du partage fabriquees ici (page.route): aucune route reelle,
// SHARE_PUBLIC_ENABLED n'est jamais touche. Le site tourne avec VITE_SHARE_ENABLED=true (playwright.config.ts). Mode mock seulement.
// Captures facultatives dans S1W_SHOTS, relues a la main.
const SHOTS = process.env.S1W_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type', 'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS' };
const ok = (body?: unknown, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: body === undefined ? '' : JSON.stringify(body) });
const TOKEN = 'AbCdEfGhIjKlMnOpQrStUv';
const T0 = '2026-12-01T10:00:00Z';
const T1 = '2026-12-08T10:00:00Z';
const QUIZ = {
  title: 'La photosynthèse en 5 questions', subject: 'svt', expiresAt: T1,
  questions: [
    { kind: 'qcm', prompt: 'Où se déroule la photosynthèse ?', choices: ['Dans les chloroplastes', 'Dans le noyau', 'Dans les ribosomes', 'Dans les mitochondries'], answer: 0 },
    { kind: 'gap', prompt: 'La plante rejette du ___ pendant la photosynthèse.', expected: 'dioxygène' },
    { kind: 'qcm', prompt: 'Quelle formule donne l’aire d’un disque ? $A = \\pi r^2$', choices: ['$\\pi r^2$', '$2\\pi r$', '$\\pi d$', '$r^2$'], answer: 0 },
    { kind: 'qcm', prompt: 'Que consomme la plante ?', choices: ['Du dioxyde de carbone', 'Du diazote', 'De l’hélium', 'Du néon'], answer: 0 },
    { kind: 'qcm', prompt: 'Quelle énergie la plante capte-t-elle ?', choices: ['Lumineuse', 'Sonore', 'Nucléaire', 'Éolienne'], answer: 0 },
  ],
};
const noOverflow = async (page: Page) => expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1)).toBe(true);

for (const dev of [
  { name: 'pc', viewport: { width: 1280, height: 900 } },
  { name: 'mobile', viewport: { width: 390, height: 844 } },
]) {
  test.describe(`partage de QCM (${dev.name})`, () => {
    test.skip(!isMock, 'mode mock seulement');
    test.use({ viewport: dev.viewport });

    test('page publique: sans compte, jeton retire, joue sans rien envoyer, signalement', async ({ page }) => {
      await page.addInitScript(() => { Math.random = () => 0.999999; }); // mélange des choix = ordre d'origine
      const seen: string[] = [];
      page.on('request', (r) => { if (!r.url().startsWith('data:') && !/\.(js|ts|tsx|css|woff2?|png|svg)(\?|$)|\/@|node_modules/.test(r.url())) seen.push(`${r.method()} ${new URL(r.url()).pathname}`); });
      let reported: unknown = null;
      await page.route('**/shares/open', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(ok(QUIZ))));
      await page.route('**/shares/report', (r) => {
        if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
        reported = r.request().postDataJSON();
        return r.fulfill({ status: 204, headers: CORS });
      });
      await page.goto(`/p#t=${TOKEN}`);
      await expect(page.getByRole('heading', { name: QUIZ.title })).toBeVisible();
      expect(page.url()).not.toContain(TOKEN);
      expect(page.url()).toMatch(/\/p$/);
      await expect(page.getByText(/non relu par un enseignant/)).toBeVisible();
      await expect(page.getByRole('button', { name: 'Déconnexion' })).toHaveCount(0);
      await noOverflow(page);
      await shot(page, `public-accueil-${dev.name}`);
      await page.getByRole('button', { name: /C'est parti/ }).click();
      await page.getByRole('button', { name: 'Dans les chloroplastes' }).click();
      await expect(page.getByText('✓ Bravo !')).toBeVisible();
      await shot(page, `public-question-juste-${dev.name}`);
      await page.getByRole('button', { name: 'Suivant' }).click();
      await page.getByLabel('Ta réponse').fill('Dioxygene');
      await page.getByRole('button', { name: 'Valider' }).click();
      await expect(page.getByText('✓ Bravo !')).toBeVisible();
      await page.getByRole('button', { name: 'Suivant' }).click();
      await expect(page.locator('.prompt math').first()).toBeVisible(); // formule rendue par KaTeX
      await page.locator('.choices button').nth(1).click();
      await expect(page.getByText('✗ Pas tout à fait.')).toBeVisible();
      await noOverflow(page);
      await shot(page, `public-question-fausse-${dev.name}`);
      for (let k = 0; k < 3; k++) {
        await page.getByRole('button', { name: /Suivant|Terminer/ }).click();
        if (k < 2) await page.locator('.choices button').first().click();
      }
      await expect(page.getByRole('heading', { name: 'Bien joué !' })).toBeVisible();
      await shot(page, `public-fin-${dev.name}`);
      await page.getByRole('button', { name: /Signaler ce QCM/ }).click();
      await page.getByLabel('Contenu inapproprié').check();
      await shot(page, `public-signalement-${dev.name}`);
      await page.getByRole('button', { name: 'Envoyer le signalement' }).click();
      await expect(page.getByText(/le signalement est envoyé/)).toBeVisible();
      expect(reported).toEqual({ token: TOKEN, reason: 'inapproprie' });
      // Aucun appel de connexion ni de profil; seules les routes publiques du partage ont ete appelees.
      expect(seen.filter((s) => !/OPTIONS/.test(s))).toEqual(['GET /p', 'POST /shares/open', 'POST /shares/report']);
      expect(seen.some((s) => /cognito|\/me/.test(s))).toBe(false);
      expect(await page.evaluate(() => localStorage.length + sessionStorage.length + document.cookie.length)).toBe(0);
    });

    test('page publique: lien expiré ou inconnu (404) et lien incomplet', async ({ page }) => {
      await page.route('**/shares/open', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(ok({ code: 'lien_indisponible', message: 'Lien indisponible' }, 404))));
      await page.goto(`/p#t=${TOKEN}`);
      await expect(page.getByRole('heading', { name: "Ce QCM n'est pas disponible" })).toBeVisible();
      await noOverflow(page);
      await shot(page, `public-indisponible-${dev.name}`);
      await page.goto('/p#t=trop-court');
      await expect(page.getByRole('heading', { name: "Ce QCM n'est pas disponible" })).toBeVisible();
    });

    test('élève: créer un lien depuis une fiche puis le révoquer', async ({ page }) => {
      await fake.reset({ role: 'eleve' });
      const { docs } = await fake.seed({ docs: [{ title: 'La photosynthèse', subject: 'svt' }] });
      const qs = [
        ...Array.from({ length: 7 }, (_, k) => ({ questionId: `${docs[0]}:q${k}`, kind: 'qcm', prompt: `Question réussie numéro ${k + 1} ?`, choices: ['a', 'b', 'c', 'd'], answer: 0, shareable: true })),
        { questionId: `${docs[0]}:x1`, kind: 'qcm', shareable: false, reason: 'a_jouer' },
        { questionId: `${docs[0]}:x2`, kind: 'gap', shareable: false, reason: 'donnee_personnelle' },
      ];
      let created: Record<string, unknown> | null = null;
      let shares: Record<string, unknown>[] = [];
      await page.route('**/docs/*/shareable', (r) => r.fulfill(ok({ questions: qs })));
      await page.route('**/me/shares', (r) => {
        const m = r.request().method();
        if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
        if (m === 'POST') {
          created = r.request().postDataJSON();
          shares = [{ shareId: 'SH1', title: created!.title, count: (created!.questionIds as string[]).length, createdAt: T0, expiresAt: T1, state: 'actif', reads: 0, reports: 0, outdated: false }];
          return r.fulfill(ok({ shareId: 'SH1', token: TOKEN, expiresAt: T1 }, 201));
        }
        return r.fulfill(ok({ shares }));
      });
      await page.route('**/me/shares/SH1', (r) => {
        if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
        shares = [];
        return r.fulfill({ status: 204, headers: CORS });
      });
      page.on('dialog', (d) => void d.accept());
      await login(page, 'eleve');
      await page.goto(`/#/doc/${docs[0]}`);
      await shot(page, `eleve-fiche-${dev.name}`);
      await page.getByRole('button', { name: /Partager des questions/ }).click();
      await expect(page.getByRole('heading', { name: 'Partager des questions' })).toBeVisible();
      await expect(page.getByText('Réussis-la d’abord en t’entraînant')).toBeVisible();
      await shot(page, `eleve-creer-vide-${dev.name}`);
      const create = page.getByRole('button', { name: /Créer le lien/ });
      await page.getByLabel(/Titre du QCM/).fill('Photosynthèse en 5 questions');
      const boxes = page.locator('.share-pick input[type=checkbox]:not([disabled])');
      for (let k = 0; k < 4; k++) await boxes.nth(k).check();
      await expect(create).toBeDisabled();
      await boxes.nth(4).check();
      await expect(create).toBeEnabled();
      await expect(page.getByLabel(/7 jours/)).toBeChecked();
      await noOverflow(page);
      await shot(page, `eleve-creer-${dev.name}`);
      await create.click();
      const link = page.getByLabel('Lien à partager');
      await expect(link).toHaveValue(new RegExp(`/p#t=${TOKEN}$`));
      await expect(page.getByText(/on ne peut pas te le montrer une deuxième fois/)).toBeVisible();
      expect(created).toMatchObject({ title: 'Photosynthèse en 5 questions', ttlDays: 7 });
      await noOverflow(page);
      await shot(page, `eleve-lien-${dev.name}`);
      await page.getByRole('link', { name: 'Mes liens' }).click();
      await expect(page.getByRole('heading', { name: 'Photosynthèse en 5 questions' })).toBeVisible();
      await expect(page.locator('body')).not.toContainText(TOKEN);
      await noOverflow(page);
      await shot(page, `eleve-liens-${dev.name}`);
      await page.getByRole('button', { name: 'Supprimer le lien' }).click();
      await expect(page.getByText(/Tu n’as aucun lien/)).toBeVisible();
    });

    test('élève: le parent n’a pas activé le partage (403)', async ({ page }) => {
      await fake.reset({ role: 'eleve' });
      const { docs } = await fake.seed({ docs: [{ title: 'La photosynthèse', subject: 'svt' }] });
      await page.route('**/docs/*/shareable', (r) => (r.request().method() === 'OPTIONS' ? r.fulfill({ status: 204, headers: CORS }) : r.fulfill(ok({ code: 'interdit', message: 'Interdit' }, 403))));
      await login(page, 'eleve');
      await page.goto(`/#/partager/${docs[0]}`);
      await expect(page.getByRole('alert')).toContainText('Demande à ton parent de l’activer');
      await shot(page, `eleve-ferme-${dev.name}`);
    });

    test('parent: activer, voir les liens sans les questions, tout révoquer, couper', async ({ page }) => {
      await fake.reset({ role: 'parent' });
      let sharing = false;
      let shares: Record<string, unknown>[] = [
        { shareId: 'SH1', title: 'La photosynthèse en 5 questions', count: 6, createdAt: T0, expiresAt: T1, state: 'actif', reads: 12, reports: 0 },
        { shareId: 'SH2', title: 'Révisions du contrôle', count: 10, createdAt: T0, expiresAt: T1, state: 'suspendu', reads: 40, reports: 3 },
      ];
      const order: string[] = [];
      await page.route('**/students/stu1', (r) => {
        const m = r.request().method();
        if (m === 'PATCH') {
          const b = r.request().postDataJSON() as { sharing?: boolean };
          if (b.sharing !== undefined) { sharing = b.sharing; order.push(`PATCH ${b.sharing}`); return r.fulfill(ok({ studentId: 'stu1', sharing })); }
        }
        return r.fallback();
      });
      await page.route('**/students/stu1/shares', (r) => {
        const m = r.request().method();
        if (m === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
        if (m === 'DELETE') { order.push('DELETE all'); shares = []; return r.fulfill({ status: 204, headers: CORS }); }
        return r.fulfill(ok({ shares, purgePending: !sharing && shares.length > 0 }));
      });
      await page.route('**/students/stu1/shares/SH1', (r) => {
        if (r.request().method() === 'OPTIONS') return r.fulfill({ status: 204, headers: CORS });
        order.push('DELETE SH1'); shares = shares.filter((x) => x.shareId !== 'SH1'); return r.fulfill({ status: 204, headers: CORS });
      });
      page.on('dialog', (d) => void d.accept());
      await login(page, 'parent');
      const sw = page.getByRole('switch');
      await expect(sw).not.toBeChecked();
      await shot(page, `parent-ferme-${dev.name}`);
      await sw.click();
      await expect(sw).toBeChecked();
      await expect(page.getByText('La photosynthèse en 5 questions')).toBeVisible();
      await expect(page.getByText(/12 lectures/)).toBeVisible();
      await expect(page.getByText('Suspendu (3 signalements)')).toBeVisible();
      await expect(page.locator('body')).not.toContainText(/Question|\bchoices\b|#t=/);
      await noOverflow(page);
      await page.locator('.share-parent').scrollIntoViewIfNeeded();
      await shot(page, `parent-liens-${dev.name}`);
      await page.getByRole('button', { name: 'Supprimer le lien La photosynthèse en 5 questions' }).click();
      await expect(page.getByText('La photosynthèse en 5 questions')).toHaveCount(0);
      await sw.click(); // drapeau d'abord, liens ensuite
      await expect(page.getByText('Révisions du contrôle')).toHaveCount(0);
      expect(order).toEqual(['PATCH true', 'DELETE SH1', 'PATCH false', 'DELETE all']);
    });
  });
}
