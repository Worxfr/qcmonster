import { expect, test, type Page } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import { fake, login } from '../support/app';
import { isMock } from '../support/env';

// Fiche en texte continu: affirmations colorées, sources et signalement en surimpression (popover PC, feuille mobile).
// Réponses fabriquées ici (page.route), aucune donnée réelle. Captures facultatives: FICHE_SHOTS=/tmp/shots
const SHOTS = process.env.FICHE_SHOTS;
const shot = async (page: Page, name: string) => {
  if (!SHOTS) return;
  mkdirSync(SHOTS, { recursive: true });
  await page.screenshot({ path: `${SHOTS}/${name}.png`, fullPage: true });
};
const CORS = { 'access-control-allow-origin': '*', 'access-control-allow-headers': 'authorization,content-type' };
const ok = (body: unknown, status = 200) => ({ status, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) });
const src = (n: number) => ({ passageId: `p${n}`, url: 'https://fr.wikipedia.org/wiki/Cellule', site: 'Wikipédia', titre: 'Cellule (biologie)', extrait: 'La cellule est l\'unité structurale et fonctionnelle de base de tout être vivant.', niveau: 1 });
const c = (id: string, text: string, status: string, n = 0) => ({ claimId: id, text, status, aRisque: false, sources: n ? [src(n)] : [] });

const CLAIMS = [
  c('c1', 'La cellule est la plus petite unité du vivant.', 'verifiee', 1),
  c('c2', 'Elle est entourée par une membrane qui protège son contenu.', 'verifiee', 2),
  c('c3', 'Le noyau contient l\'ADN et dirige la vie de la cellule.', 'verifiee', 3),
  c('c4', 'Une cellule mesure en général quelques micromètres, soit $1\\ \\mu m = 10^{-6}\\ m$.', 'non_verifiable'),
  c('c5', 'Les cellules végétales ont une paroi rigide et des chloroplastes.', 'verifiee', 4),
  c('c6', 'Le cytoplasme est un gel où flottent les organites.', 'non_verifiable'),
  c('c7', 'On observe les cellules avec un microscope optique ou électronique.', 'verifiee', 5),
  c('c8', 'Robert Hooke a utilisé le mot « cellule » en 1665.', 'non_verifiable'),
  c('c9', 'Pour convertir, on utilise toujours la relation $1\\ \\mu m = 10^{-6}\\ m = 0{,}000001\\ m$', 'erreur'),
];
const LONG = {
  docId: 'D1', title: 'La cellule', subject: 'svt', topic: 'La cellule', createdAt: '2026-12-01T10:00:00Z', summary: 'Résumé.',
  body: [
    { heading: 'L\'unité du vivant', text: 'x', claimIds: ['c1', 'c2', 'c3'] },
    { heading: 'Les tailles et les formes', text: 'x', claimIds: ['c4', 'c5', 'c6'] },
    { heading: 'Observer', text: 'x', claimIds: ['c7', 'c8', 'c9', 'c1'] }, // c1 cité deux fois: affiché une seule fois
  ],
  recall: [{ kind: 'definition', text: 'La cellule est la plus petite unité du vivant.', claimId: 'c1', verified: true }, { kind: 'date', text: 'Robert Hooke a utilisé le mot « cellule » en 1665.', claimId: 'c8', verified: false }],
  claims: CLAIMS,
};
const SHORT = { ...LONG, title: 'Les cellules', body: [{ text: 'x', claimIds: ['c1', 'c4'] }], recall: undefined, claims: [CLAIMS[0], CLAIMS[3]] };
const OLD = { ...LONG, title: 'Fiche ancienne', body: undefined, recall: undefined };

const views = [{ name: 'pc', size: { width: 1280, height: 900 } }, { name: 'mobile', size: { width: 390, height: 780 } }];

test.describe('Fiche en texte continu', () => {
  test.skip(!isMock, 'Mode mock seulement (réponses fabriquées)');
  let doc: unknown = LONG;
  const reports: unknown[] = [];
  test.beforeEach(async ({ page }) => {
    await fake.reset();
    await login(page, 'eleve');
    await page.route('**/docs/D1', (r) => r.fulfill(ok(doc)));
    await page.route('**/docs/D1/report', (r) => { reports.push(r.request().postDataJSON()); return r.fulfill(ok({ reportId: 'r1', status: 'ouvert' }, 201)); });
  });

  for (const v of views) {
    test(`fiche longue, ${v.name}: texte continu, surimpression dans l'écran, Échap rend le focus`, async ({ page }) => {
      doc = LONG;
      await page.setViewportSize(v.size);
      await page.goto('/#/doc/D1');
      await expect(page.getByRole('heading', { name: 'Observer' })).toBeVisible();
      await expect(page.getByText(/Voir les sources/)).toHaveCount(0);
      await expect(page.locator('.seg')).toHaveCount(9);
      await expect(page.locator('.fiche-body math')).toHaveCount(2);
      await shot(page, `fiche-longue-${v.name}`);
      const seg = page.getByRole('button', { name: /micromètres/ });
      await seg.click();
      const dlg = page.getByRole('dialog');
      await expect(dlg).toBeVisible();
      await expect(dlg).toContainText('Non vérifiable');
      await shot(page, `fiche-ouverte-nv-${v.name}`);
      const b = await dlg.boundingBox();
      expect(b && b.x >= -1 && b.x + b.width <= v.size.width + 1 && b.y >= 0 && b.y + b.height <= v.size.height + 1).toBe(true);
      await page.keyboard.press('Escape');
      await expect(dlg).toHaveCount(0);
      await expect(seg).toBeFocused();
      await page.getByRole('button', { name: /plus petite unité/ }).click();
      await expect(dlg).toContainText('Cellule (biologie)');
      await expect(dlg.getByRole('link')).toHaveAttribute('rel', 'noopener noreferrer');
      await shot(page, `fiche-ouverte-ok-${v.name}`);
      await dlg.getByRole('button', { name: 'Signaler une erreur' }).click();
      await dlg.getByLabel(/Qu'est-ce qui est faux/).fill('Test.');
      await shot(page, `fiche-signalement-${v.name}`);
      await dlg.getByRole('button', { name: 'Envoyer' }).click();
      await expect(dlg.getByText(/Merci/)).toBeVisible();
      expect(reports.at(-1)).toEqual({ comment: 'Test.', claimId: 'c1' });
      const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
      expect(overflow).toBeLessThanOrEqual(1);
    });

    test(`fiche courte et ancienne, ${v.name}`, async ({ page }) => {
      await page.setViewportSize(v.size);
      doc = SHORT;
      await page.goto('/#/doc/D1');
      await expect(page.locator('.seg')).toHaveCount(2);
      await shot(page, `fiche-courte-${v.name}`);
      doc = OLD;
      await page.reload();
      await expect(page.locator('.seg')).toHaveCount(9);
      await expect(page.locator('.fiche-body > div')).toHaveCount(1);
      await shot(page, `fiche-ancienne-${v.name}`);
    });
  }

  test('la marque ✓ ? ✗ ne reste jamais seule en début de ligne (largeurs 320 à 420)', async ({ page }) => {
    doc = LONG;
    await page.goto('/#/doc/D1');
    await expect(page.locator('.seg')).toHaveCount(9);
    for (let w = 320; w <= 420; w += 10) {
      await page.setViewportSize({ width: w, height: 780 });
      const orphans = await page.evaluate(() => Array.from(document.querySelectorAll('.seg sup.seg-mark')).filter((sup) => {
        const seg = sup.parentElement!;
        const r = document.createRange();
        r.setStartBefore(seg.firstChild!);
        r.setEndBefore(sup);
        const rects = Array.from(r.getClientRects()).filter((x) => x.width > 0);
        const last = rects[rects.length - 1];
        const m = sup.getBoundingClientRect();
        return !last || m.top > last.bottom - 2; // la marque est sur une ligne sous le dernier texte
      }).length);
      expect(orphans, `largeur ${w}`).toBe(0);
    }
  });

  test('clavier: Tab atteint un segment, Entrée ouvre, Tab va dans la surimpression', async ({ page }) => {
    doc = LONG;
    await page.goto('/#/doc/D1');
    const seg = page.getByRole('button', { name: /plus petite unité/ });
    await seg.focus();
    await page.keyboard.press('Enter');
    await expect(page.getByRole('dialog')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Fermer' })).toBeFocused();
    await page.getByRole('button', { name: 'Fermer' }).press('Enter');
    await expect(seg).toBeFocused();
  });
});
