// Banque de questions (Q1, docs/Q1-design.md sections 4 a 6): fonctions pures, sans modele ni base. Le hasard est un parametre.
// `closeness` sert deux fois: a la generation (jeter les jumelles) et au tirage (filet de securite, y compris entre fiches).

/** Plafond de questions demandees par type (QCM, trous): environ deux par fait verifie, de `questionCap` a 20 (40 par fiche au plus). */
export const POOL_MAX_PER_KIND = 20;
export const poolCap = (verified: number): number => Math.min(POOL_MAX_PER_KIND, Math.max(Math.min(5, Math.max(1, Math.ceil(verified / 2))), 2 * verified));

/** Tailles de test permises (P2). */
export const SIZES = [5, 10, 15, 20] as const;
export const DEFAULT_SIZE = 10;
export const MAX_PRACTICE_DOCS = 10;

export interface PoolQuestion {
  id: string;
  docId: string;
  claimId: string;
  kind: 'qcm' | 'gap';
  /** Enonce du QCM, ou phrase du trou (le trou est retire par `closeness`). */
  texte: string;
  /** Choix correct du QCM, ou mot attendu. */
  reponse: string;
}

const norm = (s: string): string =>
  s
    .replace(/[œŒ]/g, 'oe')
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

const STOP = new Set(
  'les des une dans pour par sur avec que qui quoi dont est sont etre ont avoir cette ces son ses leur leurs aux elle ils elles nous vous mais donc car comme plus moins tres aussi entre selon quel quelle quels quelles quelle ce cet'.split(' '),
);

/** Mots utiles d'un texte: normalises, d'au moins 3 lettres, sans mots-outils; le trou `____` est ignore. */
export const contentWords = (s: string): Set<string> => new Set(norm(s.replace(/_{2,}/g, ' ')).split(' ').filter((w) => w.length >= 3 && !STOP.has(w)));

const jaccard = (a: Set<string>, b: Set<string>): number => {
  if (a.size === 0 && b.size === 0) return 0;
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return inter / (a.size + b.size - inter);
};

const cache = new WeakMap<PoolQuestion, Set<string>>();
const wordsOf = (q: PoolQuestion): Set<string> => {
  let w = cache.get(q);
  if (!w) cache.set(q, (w = contentWords(q.texte)));
  return w;
};

export const R2_THRESHOLD = 0.6;
export const R3_THRESHOLD = 0.35;

/** Deux questions sont proches si: meme fait et meme reponse (R1); presque les memes mots (R2); meme reponse et des mots en commun (R3). */
export function closeness(a: PoolQuestion, b: PoolQuestion): boolean {
  const ra = norm(a.reponse);
  const sameAnswer = ra !== '' && ra === norm(b.reponse);
  if (sameAnswer && a.docId === b.docId && a.claimId === b.claimId) return true;
  const j = jaccard(wordsOf(a), wordsOf(b));
  if (j >= R2_THRESHOLD) return true;
  return sameAnswer && j >= R3_THRESHOLD;
}

export type Rng = () => number;
function shuffle<T>(xs: T[], rng: Rng): T[] {
  const a = xs.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export interface DrawCandidate extends PoolQuestion {
  /** Jour (aaaa-mm-jj) de la derniere reponse, ou absent si jamais repondue. */
  lastSeen?: string;
}

/** File d'une fiche: jamais repondues d'abord (QCM et trous en alternance), puis les plus anciennes (egalite au hasard). */
function queueOf(qs: DrawCandidate[], rng: Rng): DrawCandidate[] {
  const unseen = qs.filter((q) => q.lastSeen === undefined);
  const a = shuffle(unseen.filter((q) => q.kind === 'qcm'), rng);
  const b = shuffle(unseen.filter((q) => q.kind === 'gap'), rng);
  const first: DrawCandidate[] = [];
  for (let i = 0; i < Math.max(a.length, b.length); i++) {
    if (i < a.length) first.push(a[i]);
    if (i < b.length) first.push(b[i]);
  }
  const seen = shuffle(qs.filter((q) => q.lastSeen !== undefined), rng).sort((x, y) => (x.lastSeen as string).localeCompare(y.lastSeen as string));
  return [...first, ...seen];
}

/**
 * Tirage (section 6): tour a tour, une fiche apres l'autre (ordre melange), la prochaine question de sa file qui n'est proche d'aucune question
 * deja tiree. Une fiche a court passe son tour. Jamais de question proche pour completer: le test est plus court (`short`).
 * `available` = nombre de questions distinctes utilisables (meme methode, sans limite de taille).
 */
export function drawQuestions(candidates: DrawCandidate[], size: number, rng: Rng): { ids: string[]; available: number; short: boolean } {
  const run = (limit: number): string[] => {
    const docs = [...new Set(candidates.map((c) => c.docId))];
    const queues = shuffle(docs, rng).map((d) => queueOf(candidates.filter((c) => c.docId === d), rng));
    const picked: DrawCandidate[] = [];
    while (picked.length < limit && queues.some((q) => q.length)) {
      for (const q of queues) {
        if (picked.length >= limit) break;
        while (q.length) {
          const c = q.shift() as DrawCandidate;
          if (!picked.some((p) => closeness(p, c))) {
            picked.push(c);
            break;
          }
        }
      }
    }
    return picked.map((p) => p.id);
  };
  const ids = shuffle(run(size), rng);
  const available = run(Number.POSITIVE_INFINITY).length;
  return { ids, available, short: ids.length < size };
}
