import { expect, type Page } from '@playwright/test';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { API, TMP, creds, isMock } from './env';

export type Role = 'eleve' | 'parent';

const post = (path: string, body: unknown) => fetch(`${API}${path}`, { method: 'POST', body: JSON.stringify(body) });

/** Pilotage de l'API factice (mode mock seulement; sans effet en mode dev). */
export const fake = {
  async reset(opts: { role?: Role; family?: boolean; student?: boolean; pagesLimit?: number } = {}) {
    if (isMock) await post('/__test/reset', opts);
  },
  async role(role: Role) {
    if (isMock) await post('/__test/role', { role });
  },
  /** La lecture propose déjà 2 fiches (coupe avant la page 2), comme avec un vrai scan. Remis à zéro par reset(). */
  async suggestTwo() {
    if (isMock) await post('/__test/suggest', { on: true });
  },
  /** Dossiers et fiches déjà prêts, sans passer par un scan (mode mock seulement). */
  async seed(data: { folders?: string[]; docs?: { title: string; subject?: string; topic?: string; folder?: string; questions?: number }[] }): Promise<{ docs: string[]; folders: { folderId: string; name: string }[] }> {
    if (!isMock) return { docs: [], folders: [] };
    return (await post('/__test/seed', data)).json(); // `questions`: banque de questions de la fiche (Q1)
  },
  /** Historique de tests déjà prêt (24 passages en 2026-2027, 6 en 2025-2026), sans passer par le jeu (mode mock seulement). */
  async history(opts: { recent?: number; old?: number } = {}) {
    if (isMock) await post('/__test/history', opts);
  },
  /** La famille a consenti sur une ancienne version de la politique: GET /me renvoie policyOutdated. */
  async policyOutdated(outdated = true) {
    if (isMock) await post('/__test/policy', { outdated });
  },
  async fail(mode: 's3' | null) {
    if (isMock) await post('/__test/fail', { mode });
  },
  async state(): Promise<{ jobs: number; docs: number; cours: number; pagesRemaining: number; uploadedBytes: number }> {
    return (await fetch(`${API}/__test/state`)).json();
  },
};

/** Connexion. Mock: bouton de l'ecran de demonstration. Dev: formulaire Cognito, identifiants de l'environnement. */
export async function login(page: Page, role: Role) {
  await fake.role(role);
  await page.goto('/');
  if (isMock) {
    await page.getByRole('button', { name: role === 'eleve' ? 'Entrer comme élève' : 'Entrer comme parent' }).click();
    return;
  }
  const c = creds[role];
  await page.getByLabel('Identifiant ou e-mail').fill(c.user);
  await page.getByLabel('Mot de passe').fill(c.password);
  await page.getByRole('button', { name: 'Se connecter' }).click();
}

export async function logout(page: Page) {
  await page.getByRole('button', { name: 'Déconnexion' }).click();
  await expect(page.getByRole('heading', { name: 'QCMonster' })).toBeVisible();
}

/** Texte de cours inventé, dessiné par le navigateur puis écrit dans e2e/.tmp (ignoré par git). */
const PAGE_TEXTS = [
  ['La photosynthèse est le processus par lequel les plantes vertes fabriquent leur matière avec la lumière du soleil.', 'Elle se déroule dans les chloroplastes, des organites riches en chlorophylle.', "Cette réaction consomme du dioxyde de carbone et de l'eau, et elle produit du dioxygène."],
  ['La Révolution française commence en 1789 avec la prise de la Bastille.', "Le 26 août 1789, l'Assemblée adopte la Déclaration des droits de l'homme et du citoyen."],
  ['Le 21 janvier 1793, le roi Louis XVI est condamné et exécuté.', "La Terreur dure de 1793 à 1794 sous l'autorité du Comité de salut public."],
];

export async function makePhotos(page: Page, count: number, prefix = 'cours'): Promise<string[]> {
  mkdirSync(TMP, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const b64 = await page.evaluate((lines) => {
      const c = document.createElement('canvas');
      c.width = 1000;
      c.height = 1300;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fff';
      g.fillRect(0, 0, c.width, c.height);
      g.fillStyle = '#000';
      g.font = '34px sans-serif';
      let y = 90;
      for (const l of lines) {
        let row = '';
        for (const w of l.split(' ')) {
          if (g.measureText(`${row} ${w}`).width > 900) {
            g.fillText(row, 50, y);
            y += 52;
            row = w;
          } else row = row ? `${row} ${w}` : w;
        }
        g.fillText(row, 50, y);
        y += 90;
      }
      return c.toDataURL('image/png').split(',')[1];
    }, PAGE_TEXTS[i % PAGE_TEXTS.length]);
    const f = resolve(TMP, `${prefix}-${i + 1}.png`);
    writeFileSync(f, Buffer.from(b64, 'base64'));
    out.push(f);
  }
  return out;
}

/** Fichier de `mb` Mo (octets quelconques, extension .jpg): sert au refus « trop lourde ». */
export function bigFile(mb: number): string {
  mkdirSync(TMP, { recursive: true });
  const f = resolve(TMP, `trop-lourde-${mb}mo.jpg`);
  writeFileSync(f, Buffer.alloc(mb * 1024 * 1024, 1));
  return f;
}

/** Pilotage de l'automate d'exercices (E1, mode mock seulement). Horloge simulee: aucune attente reelle. */
export const exoFake = {
  async set(opts: { skewMs?: number; nextDay?: boolean; quota?: boolean; illisible?: number; tooShort?: boolean; seed?: { docId: string; count: number; xpPaye?: number } }) {
    if (isMock) await post('/__test/exo', opts);
  },
  /** Fait passer les 60 s apres l'ouverture de l'exercice (sinon `trop_tot`). */
  async wait60() {
    await exoFake.set({ skewMs: 61_000 });
  },
};

/** Petites pages de copie fabriquees par le navigateur (JPEG ou PNG valides, quelques Ko), ecrites dans e2e/.tmp. */
export async function makeCopiePhotos(page: Page, count: number, type: 'jpeg' | 'png' = 'jpeg'): Promise<string[]> {
  mkdirSync(TMP, { recursive: true });
  const out: string[] = [];
  for (let i = 0; i < count; i++) {
    const b64 = await page.evaluate(([n, mime]) => {
      const c = document.createElement('canvas');
      c.width = 600;
      c.height = 800;
      const g = c.getContext('2d')!;
      g.fillStyle = '#fffef8';
      g.fillRect(0, 0, 600, 800);
      g.strokeStyle = '#c7d2fe';
      for (let y = 60; y < 800; y += 40) { g.beginPath(); g.moveTo(0, y); g.lineTo(600, y); g.stroke(); }
      g.fillStyle = '#1e3a8a';
      g.font = '30px cursive';
      g.fillText(`Page ${n}`, 40, 50);
      g.fillText('v = d / t = 30 / 1,5', 40, 130);
      g.fillText('v = 20 km/h', 40, 210);
      return c.toDataURL(mime as string, 0.6).split(',')[1];
    }, [i + 1, `image/${type}`] as const);
    const f = resolve(TMP, `copie-${i + 1}.${type === 'jpeg' ? 'jpg' : 'png'}`);
    writeFileSync(f, Buffer.from(b64, 'base64'));
    out.push(f);
  }
  return out;
}
