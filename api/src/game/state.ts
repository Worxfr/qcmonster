// Etat de jeu d'un eleve: PROFILE, DAY# et WEEK# (seuls elements ecrits ici avec ATT#). Chargement, credit d'XP, series, gels, badges.
// Tout passe par `commitState`: une transaction conditionnelle aux versions lues, donc deux appels simultanes ne peuvent ni
// depasser le plafond quotidien ni gagner deux fois la meme recompense (le perdant relit et recommence).
import { keys, type Key } from '../../../shared/ddb/keys.js';
import { quotaDefaults } from '../../../shared/names.js';
import type { Deps } from '../lib/deps.js';
import type { Item, When, Write } from '../lib/store.js';
import { earned, type BadgeId } from './badges.js';
import { DAILY_XP_CAP, DAY_VALID_XP, FREEZES_PER_MONTH, STREAK_BONUS_EVERY, levelOf, stageOf } from './rules.js';
import { daysBetween, isoWeek, parisDate, parisMonth, resetDate } from './time.js';

export interface Series {
  n: number;
  /** Toutes les questions comptees jusqu'ici sont justes du premier coup. */
  perfect: boolean;
  /** Une question de la serie porte sur une affirmation erreur, non verifiable ou sans verdict: pas de bonus parfait. */
  risky: boolean;
  startedAt?: number;
}
export interface Profile {
  xp: number;
  correct: number;
  perfectSeries: number;
  validReports: number;
  readFirst: boolean;
  streak: number;
  lastValidDay?: string;
  freezes: number;
  freezeMonth?: string;
  badges: string[];
  xpBySubject: Record<string, number>;
  subjects: { month?: string; list: string[] };
  /** Dernier evenement « question affichee »: ouverture de session ou derniere reponse (ms epoch). */
  tick?: number;
  series: Series;
  /** Horodatages (ms) des bonnes reponses recentes, pour la detection de rafale. */
  recent: number[];
  /** Jour (Paris) ou les gains sont en quarantaine; le parent est notifie par ce marqueur (tableau de bord). */
  quarantineDay?: string;
  quarantineXp: number;
}
export interface DayData {
  xp: number;
  pagesPaid: number;
  valid: boolean;
  /** Fiches lues ce jour: 'scan' (XP de page), 'review' (revue), 'none' (aucune recompense). Une seule recompense par fiche et par jour. */
  reads: Record<string, 'scan' | 'review' | 'none'>;
}
export interface WeekData {
  xp: number;
  /** Jours valides (>= 30 XP) de la semaine: « jours actifs » du classement. */
  days: string[];
}

export const newSeries = (startedAt?: number): Series => ({ n: 0, perfect: true, risky: false, startedAt });
const newProfile = (): Profile => ({
  xp: 0, correct: 0, perfectSeries: 0, validReports: 0, readFirst: false, streak: 0, freezes: FREEZES_PER_MONTH, badges: [],
  xpBySubject: {}, subjects: { list: [] }, series: newSeries(), recent: [], quarantineXp: 0,
});

export interface State {
  fid: string;
  sid: string;
  now: number;
  today: string;
  month: string;
  profile: Profile;
  day: DayData;
  wk: WeekData;
  keys: { profile: Key; day: Key; wk: Key };
  when: { profile: When; day: When; wk: When };
}

const strip = <T extends object>(it: Item | undefined, fresh: T): { data: T; when: When } => {
  if (!it) return { data: fresh, when: 'absent' };
  const rest: Record<string, unknown> = { ...it };
  delete rest.PK;
  delete rest.SK;
  delete rest.v;
  return { data: { ...fresh, ...(rest as T) }, when: it.v ?? 'any' };
};

export async function loadState(deps: Deps, fid: string, sid: string): Promise<State> {
  const d = deps.now();
  const today = parisDate(d);
  const k = { profile: keys.profile(sid), day: keys.day(sid, today), wk: keys.week(fid, isoWeek(today), sid) };
  const [p, dy, w] = await Promise.all([deps.store.get(k.profile), deps.store.get(k.day), deps.store.get(k.wk)]);
  const profile = strip<Profile>(p, newProfile());
  const day = strip<DayData>(dy, { xp: 0, pagesPaid: 0, valid: false, reads: {} });
  const wk = strip<WeekData>(w, { xp: 0, days: [] });
  const month = parisMonth(d);
  // 2 gels par mois, stock maximum 2: le stock est remis a 2 au premier passage du mois.
  if (profile.data.freezeMonth !== month) {
    profile.data.freezes = FREEZES_PER_MONTH;
    profile.data.freezeMonth = month;
  }
  return { fid, sid, now: d.getTime(), today, month, profile: profile.data, day: day.data, wk: wk.data, keys: k, when: { profile: profile.when, day: day.when, wk: wk.when } };
}

type Part = 'profile' | 'day' | 'wk';
const ALL_PARTS: readonly Part[] = ['profile', 'day', 'wk'];

/** Ecrit PROFILE, DAY et WEEK (et `extra`) en une transaction. false = conflit, l'appelant relit et recommence. */
export function commitState(deps: Deps, st: State, extra: Write[] = [], parts: readonly Part[] = ALL_PARTS): Promise<boolean> {
  const all: Record<Part, Write> = {
    profile: { item: { ...st.keys.profile, ...st.profile }, when: st.when.profile },
    day: { item: { ...st.keys.day, ...st.day }, when: st.when.day },
    wk: { item: { ...st.keys.wk, ...st.wk }, when: st.when.wk },
  };
  return deps.store.commit([...parts.map((p) => all[p]), ...extra]);
}

/** Relit et recommence tant que la transaction est en conflit (3 essais au plus). `step` renvoie les ecritures en plus et le resultat. */
export async function mutate<T>(deps: Deps, fid: string, sid: string, step: (st: State) => Promise<{ extra?: Write[]; result: T }> | { extra?: Write[]; result: T }, onConflict: () => Error, parts: readonly Part[] = ALL_PARTS): Promise<{ st: State; result: T }> {
  for (let i = 0; i < 3; i++) {
    const st = await loadState(deps, fid, sid);
    const { extra, result } = await step(st);
    if (await commitState(deps, st, extra, parts)) return { st, result };
  }
  throw onConflict();
}

/** La serie survit-elle a `today`? Un trou de n jours consomme n gels; sinon la serie repart de 1. */
function survives(p: Profile, today: string): { ok: boolean; missed: number } {
  if (!p.lastValidDay) return { ok: false, missed: 0 };
  const gap = daysBetween(p.lastValidDay, today);
  if (gap <= 1) return { ok: true, missed: 0 };
  return { ok: p.freezes >= gap - 1, missed: gap - 1 };
}

/** Serie affichee: celle enregistree si elle est encore vivante (aujourd'hui, hier, ou rattrapable par des gels), sinon 0. */
export const effectiveStreak = (p: Profile, today: string): number => (survives(p, today).ok ? p.streak : 0);

export interface Credit {
  gained: number;
  /** Serie de 7 jours (ou multiple) atteinte par ce credit: +2 pages a accorder. */
  streakBonus: boolean;
}

/** Credite `amount` XP (plafond quotidien, quarantaine), met a jour semaine, matiere, jour valide et serie. */
export function credit(st: State, amount: number, subject: string): Credit {
  const p = st.profile;
  if (p.quarantineDay === st.today) {
    p.quarantineXp += amount; // compte mais non credite: visible du parent
    return { gained: 0, streakBonus: false };
  }
  const gained = Math.max(0, Math.min(amount, DAILY_XP_CAP - st.day.xp));
  if (gained === 0) return { gained: 0, streakBonus: false };
  p.xp += gained;
  st.day.xp += gained;
  st.wk.xp += gained;
  p.xpBySubject[subject] = (p.xpBySubject[subject] ?? 0) + gained;
  if (subject !== 'autre') {
    if (p.subjects.month !== st.month) p.subjects = { month: st.month, list: [] };
    if (!p.subjects.list.includes(subject)) p.subjects.list.push(subject);
  }
  let streakBonus = false;
  if (!st.day.valid && st.day.xp >= DAY_VALID_XP) {
    st.day.valid = true;
    if (!st.wk.days.includes(st.today)) st.wk.days.push(st.today);
    const s = survives(p, st.today);
    if (s.ok) {
      p.freezes -= s.missed;
      p.streak += 1;
    } else p.streak = 1;
    p.lastValidDay = st.today;
    streakBonus = p.streak % STREAK_BONUS_EVERY === 0;
  }
  return { gained, streakBonus };
}

/** Ajoute les badges nouvellement merites; renvoie leurs identifiants. */
export function awardBadges(st: State): BadgeId[] {
  const p = st.profile;
  const subjectsThisMonth = p.subjects.month === st.month ? p.subjects.list.length : 0;
  const fresh = earned({ readFirst: p.readFirst, streak: p.streak, correct: p.correct, perfectSeries: p.perfectSeries, validReports: p.validReports, subjectsThisMonth, xpBySubject: p.xpBySubject }).filter((b) => !p.badges.includes(b));
  p.badges.push(...fresh);
  return fresh;
}

export interface Progress {
  xp: number;
  level: number;
  streakDays: number;
  freezes: number;
  stage: number;
  pagesRemaining: number;
  pagesLimit: number;
  resetDate: string;
  badges: string[];
}

/** Progression exposee (contrat `Progress`). Quota: element du mois s'il existe, sinon limite de l'eleve et rien d'utilise. */
export async function progressOf(deps: Deps, fid: string, sid: string, profile: Profile, studentQuota: number | undefined, today: string): Promise<Progress> {
  const month = today.slice(0, 7);
  const q = await deps.store.get(keys.quota(fid, month, sid));
  const fallback = typeof studentQuota === 'number' && Number.isFinite(studentQuota) ? studentQuota : quotaDefaults(deps.env).studentPages;
  const limit = typeof q?.limite === 'number' ? q.limite : fallback;
  const remaining = typeof q?.restant === 'number' ? q.restant : limit;
  const level = levelOf(profile.xp);
  return {
    xp: profile.xp,
    level,
    streakDays: effectiveStreak(profile, today),
    freezes: profile.freezeMonth === month ? profile.freezes : FREEZES_PER_MONTH,
    stage: stageOf(level),
    pagesRemaining: Math.max(0, remaining),
    pagesLimit: limit,
    resetDate: resetDate(today),
    badges: [...profile.badges],
  };
}

/** Profil lu pour affichage seulement (sans ecriture). */
export async function readProfile(deps: Deps, sid: string): Promise<Profile> {
  const it = await deps.store.get(keys.profile(sid));
  return strip<Profile>(it, newProfile()).data;
}
