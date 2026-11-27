// Partage de QCM (S1 #34), partie publique. Ce fichier n'importe NI auth.ts NI api.ts: la page /p n'appelle ni Cognito ni /me.
import { API_URL } from './env';
import { normalizeGap } from '../../api/src/game/rules';
import type { ShareReportReason, SharedQuestion, SharedQuiz } from './types';

export const SHARE_PATH = '/p';
/** Meme motif que `SHARE_TOKEN_RE` (shared/share-rules.ts, egalite verifiee par test): ce fichier n'importe pas le filtre de donnees personnelles. */
const TOKEN_RE = /^[A-Za-z0-9_-]{22}$/;
/** Memes bornes que shared/share-rules.ts (egalite verifiee par test). */
export const LIMITS = { min: 5, max: 20, titleMin: 3, titleMax: 60, ttl: [1, 7, 30], defaultTtl: 7, perStudent: 5 } as const;

/** Le lien est /p#t=<jeton>: le jeton est dans le fragment (jamais envoye au serveur). */
export const isSharePath = (): boolean => window.location.pathname === SHARE_PATH;

// Gardé en mémoire seulement: ni historique, ni signet, ni stockage. Un rechargement demande de rouvrir le lien.
let taken: { token: string | null } | null = null;

/** Lit le jeton une seule fois puis le retire de l'URL (historique, signets, Referer). `null` = lien incomplet. */
export function takeShareToken(): string | null {
  if (taken) return taken.token;
  if (!isSharePath()) return null;
  const m = /(?:^|[#&])t=([A-Za-z0-9_-]+)(?=&|$)/.exec(window.location.hash);
  taken = { token: m && TOKEN_RE.test(m[1]) ? m[1] : null };
  window.history.replaceState(null, '', SHARE_PATH);
  return taken.token;
}

/** Retire le fragment sans lire le jeton (site ferme): il ne reste ni dans la barre d'adresse ni dans l'historique. */
export function dropShareFragment(): void {
  if (isSharePath() && window.location.hash) window.history.replaceState(null, '', '/');
}

export class ShareError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function post<T>(path: string, body: unknown): Promise<T | undefined> {
  const res = await fetch(API_URL + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), credentials: 'omit' });
  if (!res.ok) {
    const e = (await res.json().catch(() => ({}))) as { code?: string; message?: string };
    throw new ShareError(res.status, e.code ?? 'erreur', e.message ?? `Erreur ${res.status}`);
  }
  return res.status === 204 ? undefined : ((await res.json()) as T);
}

// Une seule ouverture par jeton: l'effet de React rejoue sinon l'appel (mode strict) et compterait deux lectures.
let opening: { token: string; p: Promise<SharedQuiz> } | null = null;
export const openShare = (token: string): Promise<SharedQuiz> => {
  if (opening?.token !== token) opening = { token, p: post<SharedQuiz>('/shares/open', { token }).then((q) => q!) };
  return opening.p;
};
export const reportShare = (token: string, reason: ShareReportReason): Promise<unknown> => post('/shares/report', { token, reason });

/** Une question prete a jouer: l'ordre des choix est melange dans le navigateur, `answer` suit le melange. */
export interface PlayQuestion { kind: 'qcm' | 'gap'; prompt: string; choices: string[]; answer: number; expected: string }

export function toPlay(qs: SharedQuestion[], rnd: () => number = Math.random): PlayQuestion[] {
  return qs.map((q) => {
    if (q.kind === 'gap') return { kind: 'gap', prompt: q.prompt, choices: [], answer: -1, expected: q.expected ?? '' };
    const idx = (q.choices ?? []).map((_, i) => i);
    for (let i = idx.length - 1; i > 0; i--) {
      const j = Math.floor(rnd() * (i + 1));
      [idx[i], idx[j]] = [idx[j], idx[i]];
    }
    return { kind: 'qcm', prompt: q.prompt, choices: idx.map((i) => q.choices![i]), answer: idx.indexOf(q.answer ?? 0), expected: '' };
  });
}

/** Correction faite dans le navigateur, avec la meme comparaison que le serveur (`normalizeGap`). Rien n'est envoye. */
export const isCorrect = (q: PlayQuestion, given: string | number): boolean =>
  q.kind === 'qcm' ? given === q.answer : typeof given === 'string' && normalizeGap(given) !== '' && normalizeGap(given) === normalizeGap(q.expected);

/** Lien a donner: jamais d'ecriture hors de l'ecran qui le montre. */
export const shareUrl = (token: string): string => `${window.location.origin}${SHARE_PATH}#t=${token}`;

export const REASONS: { id: ShareReportReason; label: string }[] = [
  { id: 'inapproprie', label: 'Contenu inapproprié' },
  { id: 'donnees_perso', label: 'Données personnelles (nom, adresse, téléphone…)' },
  { id: 'autre', label: 'Autre problème' },
];

export const dayLabel = (iso: string): string => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });
