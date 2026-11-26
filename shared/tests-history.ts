// Historique des tests de l'eleve (H1, docs/H1-design.md): fonctions pures partagees (annee scolaire, identifiant, curseur, score, lignes).
// Aucune lecture de base ici. Le texte d'une question ou d'un cours n'entre jamais dans un passage.
import { randomBytes } from 'node:crypto';

export const MAX_ITEMS = 20; // taille d'une session
export const TEST_GAP_MS = 3 * 3_600_000; // 3 h sans reponse: le passage suivant est un nouveau passage
export const MAX_CHOICE = 300;
export const MAX_TITLE = 200;

const parisParts = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const partsOf = (ms: number) => {
  const p = Object.fromEntries(parisParts.formatToParts(new Date(ms)).map((x) => [x.type, x.value]));
  return { y: Number(p.year), m: Number(p.month), d: Number(p.day), hh: Number(p.hour), mm: Number(p.minute) };
};

/** Annee scolaire de `d` (jour local Europe/Paris): septembre a decembre de Y donne `Y-(Y+1)`, janvier a aout de Y donne `(Y-1)-Y`. */
export function schoolYearOf(d: Date): string {
  const { y, m } = partsOf(d.getTime());
  const start = m >= 9 ? y : y - 1;
  return `${start}-${start + 1}`;
}

/** Horodatage UTC au format des cles (aaaa-mm-jjThh:mm:ssZ), seconde entiere par defaut. */
export const isoSeconds = (ms: number): string => new Date(Math.floor(ms / 1000) * 1000).toISOString().replace('.000Z', 'Z');

/** Debut (00:00 Europe/Paris) du jour `date` (aaaa-mm-jj), en UTC au format des cles. Gere l'heure d'ete. */
export function parisDayStartUtc(date: string): string {
  const [y, m, d] = date.split('-').map(Number);
  const midnightUtc = Date.UTC(y, m - 1, d);
  for (const off of [2, 1, 0]) {
    const t = midnightUtc - off * 3_600_000;
    const p = partsOf(t);
    if (p.y === y && p.m === m && p.d === d && p.hh === 0 && p.mm === 0) return isoSeconds(t);
  }
  throw new RangeError('date invalide');
}

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** Date aaaa-mm-jj reelle, sinon undefined. */
export function validDay(s: string): string | undefined {
  if (!DAY_RE.test(s)) return undefined;
  const t = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(t.getTime()) && t.toISOString().slice(0, 10) === s ? s : undefined;
}
export const addDay = (date: string, n: number): string => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

/** Bornes UTC [debut, fin[ d'une annee scolaire `aaaa-bbbb` (1er septembre 00:00 Paris au 1er septembre suivant), ou undefined si le format est faux. */
export function schoolYearBounds(sy: string): { from: string; to: string } | undefined {
  const m = /^(\d{4})-(\d{4})$/.exec(sy);
  if (!m || Number(m[2]) !== Number(m[1]) + 1) return undefined;
  return { from: parisDayStartUtc(`${m[1]}-09-01`), to: parisDayStartUtc(`${m[2]}-09-01`) };
}

// --- Identifiant de passage: ULID (48 bits de temps en ms, 80 bits au hasard). Le temps donne la cle du passage sans index.
const ALPHA = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
export const TEST_ID_RE = /^[0-7][0-9A-HJKMNP-TV-Z]{25}$/;

export function newTestId(ms: number, rnd: Uint8Array = randomBytes(16)): string {
  let t = ms;
  let time = '';
  for (let i = 0; i < 10; i++) {
    time = ALPHA[t % 32] + time;
    t = Math.floor(t / 32);
  }
  return time + Array.from(rnd.subarray(0, 16), (b) => ALPHA[b & 31]).join('');
}
/** Millisecondes encodees dans le testId, ou undefined si ce n'est pas un identifiant de passage. */
export function testIdTime(id: string): number | undefined {
  if (!TEST_ID_RE.test(id)) return undefined;
  let t = 0;
  for (const c of id.slice(0, 10)) t = t * 32 + ALPHA.indexOf(c);
  return t;
}
/** Partie temps de la cle (`startedAt` en UTC, seconde entiere) d'un testId. */
export const testIdStartedAt = (id: string): string | undefined => {
  const t = testIdTime(id);
  return t === undefined ? undefined : isoSeconds(t);
};

// --- Curseur: uniquement la cle de tri (SK), jamais la partition.
const SK_RE = /^TEST#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z#[0-7][0-9A-HJKMNP-TV-Z]{25}$/;
/** Cle de tri d'un passage (aucune autre forme n'est lue ni renvoyee). */
export const isTestSk = (sk: string): boolean => SK_RE.test(sk);
export const encodeCursor = (sk: string): string => Buffer.from(sk, 'utf8').toString('base64url');
/** SK d'un curseur, ou undefined si le curseur n'a pas exactement la forme d'une cle de passage. */
export function decodeCursor(c: string): string | undefined {
  if (c.length > 512 || !/^[A-Za-z0-9_-]+$/.test(c)) return undefined;
  const sk = Buffer.from(c, 'base64url').toString('utf8');
  return SK_RE.test(sk) ? sk : undefined;
}

// --- Passage
export interface TestLine {
  q: string;
  r: number;
  k: 'qcm' | 'gap';
  ok: boolean;
  n: number;
  f: boolean;
  xp: number;
  at: string;
  c: string;
}
export interface TestItem {
  docId: string;
  titre: string;
  matiere: string;
  mode: string;
  anneeScolaire: string;
  startedAt: string;
  endedAt?: string;
  total: number;
  answered: number;
  correct: number;
  firstTry: number;
  xpGained: number;
  items: TestLine[];
  ttl?: number;
}

export const scorePct = (correct: number, total: number): number => (total > 0 ? Math.round((100 * correct) / total) : 0);

/** Question terminee: l'eleve a deja le droit de voir la bonne reponse (juste, 2 essais, ou texte a trous repondu). */
export const lineDone = (l: Pick<TestLine, 'ok' | 'n' | 'k'>): boolean => l.ok || l.n >= 2 || l.k === 'gap';

/**
 * Ajoute ou met a jour la ligne d'une question dans le passage. Une question non terminee continue (essai 2, `f` conserve);
 * rejouee apres etre terminee, elle repart a 1 essai et garde l'XP deja gagnee. Au plus MAX_ITEMS lignes.
 */
export function upsertLine(items: TestLine[], a: { q: string; rank: number; k: 'qcm' | 'gap'; correct: boolean; xp: number; at: string; choice: string }): TestLine[] {
  const c = a.choice.slice(0, MAX_CHOICE);
  const i = items.findIndex((l) => l.q === a.q);
  if (i < 0) {
    if (items.length >= MAX_ITEMS) return items;
    return [...items, { q: a.q, r: a.rank, k: a.k, ok: a.correct, n: 1, f: a.correct, xp: a.xp, at: a.at, c }];
  }
  const old = items[i];
  const again = lineDone(old);
  const next: TestLine = again
    ? { ...old, ok: a.correct, n: 1, f: a.correct, xp: old.xp + a.xp, at: a.at, c }
    : { ...old, ok: a.correct, n: Math.min(2, old.n + 1), xp: old.xp + a.xp, at: a.at, c };
  return items.map((l, j) => (j === i ? next : l));
}

/** Compteurs du passage, recalcules depuis les lignes. */
export function recount(items: TestLine[]): Pick<TestItem, 'answered' | 'correct' | 'firstTry' | 'xpGained'> {
  return { answered: items.length, correct: items.filter((l) => l.ok).length, firstTry: items.filter((l) => l.f).length, xpGained: items.reduce((s, l) => s + l.xp, 0) };
}

export interface TestSummary {
  testId: string;
  docId: string;
  titre: string;
  matiere: string;
  mode: string;
  schoolYear: string;
  startedAt: string;
  endedAt?: string;
  total: number;
  answered: number;
  correct: number;
  firstTry: number;
  scorePct: number;
  xpGained: number;
  status: 'complet' | 'incomplet';
}

/** Resume du contrat (`TestSummary`): liste blanche de champs, aucun texte de question ni reponse donnee. */
export function toSummary(it: Record<string, unknown>, testId: string): TestSummary {
  const total = Math.max(1, Number(it.total) || 1);
  const answered = Number(it.answered) || 0;
  const correct = Number(it.correct) || 0;
  return {
    testId,
    docId: String(it.docId ?? ''),
    titre: String(it.titre ?? '').slice(0, MAX_TITLE),
    matiere: String(it.matiere ?? 'autre'),
    mode: String(it.mode ?? 'mixte'),
    schoolYear: String(it.anneeScolaire ?? ''),
    startedAt: String(it.startedAt ?? ''),
    ...(typeof it.endedAt === 'string' ? { endedAt: it.endedAt } : {}),
    total,
    answered,
    correct,
    firstTry: Number(it.firstTry) || 0,
    scorePct: scorePct(correct, total),
    xpGained: Number(it.xpGained) || 0,
    status: answered >= total ? 'complet' : 'incomplet',
  };
}

/** testId d'une cle de tri `TEST#<startedAt>#<testId>`. */
export const testIdOfSk = (sk: string): string => sk.slice(sk.lastIndexOf('#') + 1);
