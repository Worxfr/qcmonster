// Decoupage du cours en sections (une fiche par sujet). Logique pure: aucun acces reseau ni DOM.
import { countWords } from '../../labels';
import type { ConfirmSection, Sentence, Subject, SuggestedSection } from '../../types';

export interface Sec { from: string; subject: Subject | ''; topic: string; title: string; folderId: string; ignore: boolean }

export const MIN_WORDS = 40;
export const TOPIC_MAX = 80;
export const TITLE_MAX = 120;
/** 2 sections au plus par page du scan, 6 en tout. */
export const maxSections = (pages: number) => Math.min(6, 2 * Math.max(1, pages));

const blank = (from: string, subject: Subject | '' = '', topic = ''): Sec => ({ from, subject, topic, title: '', folderId: '', ignore: false });

/** Proposition de Claude si elle est coherente avec le texte, sinon une seule section (la premiere commence toujours a la premiere phrase). */
export function initSections(all: Sentence[], suggested: SuggestedSection[] | undefined, subject: Subject | undefined, topic: string | undefined, pages: number): Sec[] {
  const first = all[0]?.id ?? '';
  const single = [blank(first, subject ?? '', topic ?? '')];
  if (!suggested || suggested.length < 2) {
    const s = suggested?.[0];
    return s && s.fromSentenceId === first ? [{ ...blank(first, s.subject, s.topic ?? ''), title: s.title ?? '' }] : single;
  }
  const pos = new Map(all.map((s, i) => [s.id, i]));
  let last = -1;
  for (const s of suggested) {
    const p = pos.get(s.fromSentenceId);
    if (p === undefined || p <= last) return single; // phrase inconnue ou coupes dans le desordre
    last = p;
  }
  if (suggested[0].fromSentenceId !== first || suggested.length > maxSections(pages)) return single;
  return suggested.map((s) => ({ ...blank(s.fromSentenceId, s.subject, s.topic ?? ''), title: s.title ?? '' }));
}

/** Garde seulement des sections valides (apres rechargement): ids connus, dans l'ordre, premiere = premiere phrase. */
export function sanitize(raw: unknown, all: Sentence[], pages: number): Sec[] | null {
  if (!Array.isArray(raw) || !raw.length || !all.length) return null;
  const pos = new Map(all.map((s, i) => [s.id, i]));
  const out: Sec[] = [];
  let last = -1;
  for (const r of raw as Partial<Sec>[]) {
    const p = typeof r?.from === 'string' ? pos.get(r.from) : undefined;
    if (p === undefined || p <= last || typeof r.subject !== 'string' || typeof r.topic !== 'string') return null;
    last = p;
    out.push({ from: r.from!, subject: r.subject as Subject | '', topic: r.topic.slice(0, TOPIC_MAX), title: typeof r.title === 'string' ? r.title : '', folderId: typeof r.folderId === 'string' ? r.folderId : '', ignore: r.ignore === true });
  }
  return out[0].from === all[0].id && out.length <= maxSections(pages) ? out : null;
}

export function addCut(secs: Sec[], all: Sentence[], before: string): Sec[] {
  const pos = new Map(all.map((s, i) => [s.id, i]));
  const p = pos.get(before);
  if (p === undefined || p === 0 || secs.some((s) => s.from === before)) return secs;
  let at = secs.findIndex((s) => (pos.get(s.from) ?? 0) > p);
  if (at < 0) at = secs.length;
  const parent = secs[at - 1];
  const next = [...secs];
  next.splice(at, 0, { ...blank(before, parent.subject), folderId: parent.folderId });
  return next;
}

export const removeCut = (secs: Sec[], from: string): Sec[] => (secs[0].from === from ? secs : secs.filter((s) => s.from !== from));

/** Index de section de chaque phrase (par id). */
export function sectionIndex(secs: Sec[], all: Sentence[]): Map<string, number> {
  const m = new Map<string, number>();
  const starts = new Map(secs.map((s, i) => [s.from, i]));
  let cur = 0;
  for (const s of all) {
    cur = starts.get(s.id) ?? cur;
    m.set(s.id, cur);
  }
  return m;
}

export interface Plan { kept: number; ignored: number; words: number; subjects: Subject[]; missingSubject: boolean }
export function plan(secs: Sec[], all: Sentence[], textOf: (s: Sentence) => string): Plan {
  const idx = sectionIndex(secs, all);
  const words = all.reduce((n, s) => (secs[idx.get(s.id) ?? 0].ignore ? n : n + countWords(textOf(s))), 0);
  const kept = secs.filter((s) => !s.ignore);
  return { kept: kept.length, ignored: secs.length - kept.length, words, subjects: [...new Set(kept.map((s) => s.subject).filter(Boolean))] as Subject[], missingSubject: kept.some((s) => !s.subject) };
}

/** Corps de `POST /jobs/{id}/confirm` (sans `corrections`). Une section simple passe par les raccourcis `subject`/`topic`/`folderId`, jamais les deux. */
export function confirmBody(secs: Sec[]): { sections?: ConfirmSection[]; subject?: Subject; topic?: string; folderId?: string } {
  const one = secs.length === 1 && !secs[0].ignore && !secs[0].title.trim();
  if (one) {
    const s = secs[0];
    return { subject: s.subject as Subject, ...(s.topic.trim() ? { topic: s.topic.trim() } : {}), ...(s.folderId ? { folderId: s.folderId } : {}) };
  }
  return {
    sections: secs.map((s) => ({
      fromSentenceId: s.from,
      subject: (s.subject || 'autre') as Subject,
      ...(s.topic.trim() ? { topic: s.topic.trim() } : {}),
      ...(s.title.trim() ? { title: s.title.trim() } : {}),
      ...(s.folderId ? { folderId: s.folderId } : {}),
      ...(s.ignore ? { ignore: true } : {}),
    })),
  };
}
