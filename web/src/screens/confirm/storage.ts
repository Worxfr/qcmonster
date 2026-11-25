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
export const clearEdits = (jobId: string) => {
  saveEdits(jobId, {});
  try {
    sessionStorage.removeItem(skey(jobId));
  } catch {
    /* rien */
  }
};
