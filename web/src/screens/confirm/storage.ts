import type { Added } from './added';
// Corrections non envoyées: gardées dans CET onglet seulement (sessionStorage), effacées après l'envoi.
// Aucun cache hors ligne: le texte du cours n'est ni dans localStorage ni dans le service worker.
const key = (jobId: string) => `qcm.confirm.${jobId}`;

export function loadEdits(jobId: string, original: Map<string, string>): Record<string, string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(key(jobId)) ?? '{}') as unknown;
    if (!raw || typeof raw !== 'object') return {};
    const out: Record<string, string> = {};
    for (const [id, text] of Object.entries(raw)) {
      if (typeof text === 'string' && original.has(id) && text !== original.get(id)) out[id] = text;
    }
    return out;
  } catch {
    return {};
  }
}

export function saveEdits(jobId: string, edits: Record<string, string>) {
  try {
    if (Object.keys(edits).length) sessionStorage.setItem(key(jobId), JSON.stringify(edits));
    else sessionStorage.removeItem(key(jobId));
  } catch {
    /* stockage plein ou interdit: on continue sans sauvegarde */
  }
}

const skey = (jobId: string) => `qcm.confirm.sections.${jobId}`;
export function loadSections(jobId: string): unknown {
  try {
    return JSON.parse(sessionStorage.getItem(skey(jobId)) ?? 'null');
  } catch {
    return null;
  }
}
export function saveSections(jobId: string, secs: unknown) {
  try {
    sessionStorage.setItem(skey(jobId), JSON.stringify(secs));
  } catch {
    /* stockage plein ou interdit */
  }
}
/** Retraits (`removed`), passages douteux valides (`ok`): listes d'identifiants de phrases, dans CET onglet seulement. */
const lkey = (kind: 'removed' | 'ok', jobId: string) => `qcm.confirm.${kind}.${jobId}`;
export function loadIds(jobId: string, kind: 'removed' | 'ok', known: Set<string>): Set<string> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(lkey(kind, jobId)) ?? '[]') as unknown;
    return new Set(Array.isArray(raw) ? raw.filter((x): x is string => typeof x === 'string' && known.has(x)) : []);
  } catch {
    return new Set();
  }
}
export function saveIds(jobId: string, kind: 'removed' | 'ok', ids: Set<string>) {
  try {
    if (ids.size) sessionStorage.setItem(lkey(kind, jobId), JSON.stringify([...ids]));
    else sessionStorage.removeItem(lkey(kind, jobId));
  } catch {
    /* stockage plein ou interdit */
  }
}

/** Choix de l'eleve pour chaque figure proposee. Absent = non gardee (jamais gardee par defaut). */
export type FigChoice = { keep: boolean; alt?: string };
const fkey = (jobId: string) => `qcm.confirm.figs.${jobId}`;
export function loadFigs(jobId: string, known: Set<string>): Record<string, FigChoice> {
  try {
    const raw = JSON.parse(sessionStorage.getItem(fkey(jobId)) ?? '{}') as Record<string, unknown>;
    const out: Record<string, FigChoice> = {};
    for (const [id, v] of Object.entries(raw ?? {})) {
      const c = v as Partial<FigChoice> | null;
      if (known.has(id) && c && typeof c.keep === 'boolean') out[id] = { keep: c.keep, ...(typeof c.alt === 'string' ? { alt: c.alt } : {}) };
    }
    return out;
  } catch {
    return {};
  }
}
export function saveFigs(jobId: string, figs: Record<string, FigChoice>) {
  try {
    if (Object.keys(figs).length) sessionStorage.setItem(fkey(jobId), JSON.stringify(figs));
    else sessionStorage.removeItem(fkey(jobId));
  } catch {
    /* stockage plein ou interdit */
  }
}

/** Phrases ajoutees (M1 #89), dans CET onglet seulement. On ne garde que des entrees coherentes: ancre connue ou ajout PLUS HAUT dans la liste. */
const akey = (jobId: string) => `qcm.confirm.added.${jobId}`;
export function loadAdded(jobId: string, known: Set<string>): Added[] {
  try {
    const raw = JSON.parse(sessionStorage.getItem(akey(jobId)) ?? '[]') as unknown;
    const out: Added[] = [];
    for (const r of Array.isArray(raw) ? (raw as Partial<Added>[]) : []) {
      const okAnchor = r.afterId === null || (typeof r.afterId === 'string' && (known.has(r.afterId) || out.some((a) => a.key === r.afterId)));
      if (typeof r?.key === 'string' && /^n\d{1,2}$/.test(r.key) && !out.some((a) => a.key === r.key) && okAnchor && typeof r.text === 'string' && r.text.trim().length >= 3 && r.text.length <= 2000 && out.length < 20) {
        out.push({ key: r.key, afterId: r.afterId as string | null, text: r.text, newBlock: r.newBlock === true });
      }
    }
    return out;
  } catch {
    return [];
  }
}
export function saveAdded(jobId: string, list: Added[]) {
  try {
    if (list.length) sessionStorage.setItem(akey(jobId), JSON.stringify(list));
    else sessionStorage.removeItem(akey(jobId));
  } catch {
    /* stockage plein ou interdit */
  }
}

export const clearEdits = (jobId: string) => {
  saveAdded(jobId, []);
  saveEdits(jobId, {});
  saveIds(jobId, 'removed', new Set());
  saveIds(jobId, 'ok', new Set());
  saveFigs(jobId, {});
  try {
    sessionStorage.removeItem(skey(jobId));
  } catch {
    /* rien */
  }
};
