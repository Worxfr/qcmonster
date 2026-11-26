// Changements du texte lu par l'eleve (retraits, corrections, phrases ajoutees): fonctions PURES, sans reseau ni base.
// M1 #89 (docs/M1-design.md 2): `jobs-confirm` les applique avant confirmation (api/src/pipeline/changes.ts le reexporte); le site les rejoue pour
// afficher EXACTEMENT la place que le serveur donnera aux phrases ajoutees. #90 (modifier un cours confirme) reutilisera `applyChanges` tel quel.
import { isSafeText } from './latex.js';

/** Bloc du cours (meme forme que `Block` de api/src/pipeline/blocks.ts et du contrat). */
export interface Block {
  id: string;
  kind: 'titre' | 'paragraphe' | 'liste' | 'formule' | 'figure';
  level?: number;
  ordered?: boolean;
  sentenceIds?: string[];
  figureId?: string;
}
/** Memes valeurs que `MAX_BLOCK_SENTENCES` et `MAX_BLOCKS` de blocks.ts (un test les compare). */
export const MAX_BLOCK_SENTENCES = 200;
export const MAX_BLOCKS = 400;

/** Phrase du texte de travail; `added` n'existe que sur une phrase ajoutee par l'eleve (jamais envoye au modele). */
export interface Sent {
  id: string;
  text: string;
  pages?: number[];
  doubt?: boolean;
  added?: boolean;
}
/** Page de texte (`JOB#.../TEXT#` ou `COURS#...#T`): seuls `SK`, `page` et `sentences` comptent, le reste est conserve. */
export type PageItem = Record<string, unknown> & { SK: string };

export interface AddedIn {
  key: string;
  afterId: string | null;
  text: string;
  newBlock?: boolean;
}
export interface Corr {
  id: string;
  text: string;
}
export interface ChangesIn {
  removed?: string[];
  corrections?: Corr[];
  added?: AddedIn[];
}

/** Limites de #89 (M1-P4). */
export const MAX_ADDED = 20;
export const MAX_ADDED_CHARS = 6000;
export const MIN_ADDED_CHARS = 3;

export type ChangeError = 'phrase_inconnue' | 'phrase_vide' | 'formule' | 'ancre' | 'cle' | 'ordre' | 'trop' | 'trop_long' | 'blocs';
/** Messages constants: jamais le texte d'une phrase. */
export const CHANGE_MESSAGES: Record<ChangeError, string> = {
  phrase_inconnue: 'Phrase inconnue',
  phrase_vide: 'Phrase vide',
  formule: 'Formule non valide',
  ancre: 'Phrase de départ inconnue pour un ajout',
  cle: 'Clé d\'ajout en double ou invalide',
  ordre: 'Un ajout ne peut suivre qu\'un ajout placé avant lui',
  trop: `Trop de phrases ajoutées (${MAX_ADDED} au plus)`,
  trop_long: `Texte ajouté trop long (${MAX_ADDED_CHARS} caractères au plus)`,
  blocs: 'Ce texte a atteint la limite de mise en forme',
};

export type ChangesResult<T extends PageItem> =
  | {
      ok: true;
      /** Toutes les pages, dans l'ordre d'entree, retraits et corrections appliques et phrases ajoutees comprises. */
      texts: T[];
      /** Pages dont le contenu a change (a reecrire). */
      changed: T[];
      /** Blocs avec les phrases ajoutees, SANS les phrases retirees ni les blocs de texte vides; `undefined` si le texte n'a pas de couche de blocs. */
      blocks: Block[] | undefined;
      /** Cle d'ajout -> identifiant definitif. */
      ids: Map<string, string>;
    }
  | { ok: false; error: ChangeError };

const sentsOf = (t: PageItem): Sent[] => (t.sentences as Sent[] | undefined) ?? [];
const idNum = (id: string, page: number): number => {
  const m = /^p(\d+)-s(\d+)$/.exec(id);
  return m && Number(m[1]) === page ? Number(m[2]) : 0;
};

/**
 * Ordre d'application (design 2.3): validation complete, puis corrections, ajouts (sur le texte AVANT retrait: une ancre retiree
 * garde sa place), puis retraits. Aucun identifiant existant n'est renumerote ni repris.
 */
export function applyChanges<T extends PageItem>(texts: T[], blocks: Block[] | undefined, c: ChangesIn): ChangesResult<T> {
  const removed = new Set(c.removed ?? []);
  const known = new Set(texts.flatMap((t) => sentsOf(t).map((s) => s.id)));
  for (const id of removed) if (!known.has(id)) return { ok: false, error: 'phrase_inconnue' };

  // Corrections: le texte seul change (les pages d'une phrase recollee restent celles de la lecture; le doute est eteint, l'eleve a relu).
  const pages = texts.map((t) => ({ item: t, page: Number(t.page), sentences: sentsOf(t).map((s) => ({ ...s })), dirty: false }));
  const where = new Map<string, Sent>();
  for (const p of pages) for (const s of p.sentences) where.set(s.id, s);
  const pageOf = new Map<string, (typeof pages)[number]>();
  for (const p of pages) for (const s of p.sentences) pageOf.set(s.id, p);
  for (const corr of c.corrections ?? []) {
    const s = where.get(corr.id);
    if (!s) return { ok: false, error: 'phrase_inconnue' };
    if (removed.has(corr.id)) continue; // corrigee puis retiree: le retrait gagne
    const text = corr.text.trim();
    if (!text) return { ok: false, error: 'phrase_vide' };
    if (!isSafeText(text)) return { ok: false, error: 'formule' };
    s.text = text;
    delete s.doubt;
    pageOf.get(corr.id)!.dirty = true;
  }

  const idsOut = new Map<string, string>();
  let work = blocks?.map((b) => ({ ...b, ...(b.sentenceIds ? { sentenceIds: [...b.sentenceIds] } : {}) }));
  const added = c.added ?? [];
  if (added.length > MAX_ADDED) return { ok: false, error: 'trop' };
  let chars = 0;
  const keys = new Set<string>();
  for (const a of added) {
    if (!/^n\d{1,2}$/.test(a.key) || keys.has(a.key)) return { ok: false, error: 'cle' };
    keys.add(a.key);
    const text = a.text.trim();
    if (text.length < MIN_ADDED_CHARS) return { ok: false, error: 'phrase_vide' };
    chars += text.length;
  }
  if (chars > MAX_ADDED_CHARS) return { ok: false, error: 'trop_long' };

  // Prochain numero par page: plus grand numero du texte lu (retraits compris) + 1.
  const nextN = new Map<number, number>();
  const nextFor = (page: number): number => {
    if (!nextN.has(page)) nextN.set(page, 1 + Math.max(0, ...pages.flatMap((p) => p.sentences.map((s) => idNum(s.id, page)))));
    const n = nextN.get(page)!;
    nextN.set(page, n + 1);
    return n;
  };
  let blockSeq = Math.max(0, ...(work ?? []).map((b) => Number(b.id.slice(1)) || 0));
  const blockOf = new Map<string, Block>();
  for (const b of work ?? []) for (const id of b.sentenceIds ?? []) blockOf.set(id, b);

  /** Emplacement juste apres la phrase `id`: une phrase recollee sur deux pages cede la place a la derniere de ses pages (design 2.3). */
  const after = (id: string): { p: number; i: number } | undefined => {
    for (let p = 0; p < pages.length; p++) {
      const i = pages[p].sentences.findIndex((s) => s.id === id);
      if (i < 0) continue;
      const s = pages[p].sentences[i];
      const last = s.pages && s.pages.length > 1 ? s.pages[s.pages.length - 1] : undefined;
      const q = last !== undefined && i === pages[p].sentences.length - 1 ? pages.findIndex((x, k) => k > p && x.page === last) : -1;
      return q >= 0 ? { p: q, i: 0 } : { p, i: i + 1 };
    }
    return undefined;
  };

  for (const a of added) {
    const text = a.text.trim();
    if (!isSafeText(text)) return { ok: false, error: 'formule' };
    let at: { p: number; i: number } | undefined;
    let joined: Block | undefined; // bloc que la phrase rejoint
    let newAfter: Block | undefined; // sinon: nouveau paragraphe apres ce bloc
    let atStart = false;
    if (a.afterId === null) {
      if (!pages.length) return { ok: false, error: 'ancre' };
      at = { p: 0, i: 0 };
      atStart = true;
    } else {
      if (a.afterId.startsWith('n') ? !idsOut.has(a.afterId) : !where.has(a.afterId)) return { ok: false, error: a.afterId.startsWith('n') && keys.has(a.afterId) ? 'ordre' : 'ancre' };
      const anchor = a.afterId.startsWith('n') ? idsOut.get(a.afterId)! : a.afterId;
      const block = blockOf.get(anchor);
      if (work && block && (block.kind === 'paragraphe' || block.kind === 'liste') && !a.newBlock && (block.sentenceIds?.length ?? 0) < MAX_BLOCK_SENTENCES) joined = block;
      else if (work) {
        // Ancre hors de tout bloc (texte ancien partiel): l'ordre des blocs divergerait de celui des phrases, on refuse plutot que de deviner.
        if (!block) return { ok: false, error: 'ancre' };
        newAfter = block;
      }
      // Un nouveau bloc se place apres la derniere phrase du bloc de l'ancre: on ne coupe jamais un paragraphe en deux.
      const ref = joined || !block?.sentenceIds?.length ? anchor : block.sentenceIds[block.sentenceIds.length - 1];
      at = after(ref);
      if (!at) return { ok: false, error: 'ancre' };
    }
    const page = pages[at.p];
    const id = `p${page.page}-s${nextFor(page.page)}`;
    const s: Sent = { id, text, added: true };
    page.sentences.splice(at.i, 0, s);
    page.dirty = true;
    where.set(id, s);
    pageOf.set(id, page);
    idsOut.set(a.key, id);
    if (work) {
      if (joined) {
        const ids = joined.sentenceIds!;
        const anchorId = idsOut.get(a.afterId ?? '') ?? a.afterId!;
        ids.splice(ids.indexOf(anchorId) + 1, 0, id);
        blockOf.set(id, joined);
      } else {
        const nb: Block = { id: `b${++blockSeq}`, kind: 'paragraphe', sentenceIds: [id] };
        const pos = atStart ? 0 : newAfter ? work.indexOf(newAfter) + 1 : work.length;
        work.splice(pos, 0, nb);
        blockOf.set(id, nb);
      }
      if (work.length > MAX_BLOCKS) return { ok: false, error: 'blocs' };
    }
  }

  // Retraits.
  for (const p of pages) {
    if (p.sentences.some((s) => removed.has(s.id))) {
      p.sentences = p.sentences.filter((s) => !removed.has(s.id));
      p.dirty = true;
    }
  }
  if (work) work = work.map((b) => (b.sentenceIds ? { ...b, sentenceIds: b.sentenceIds.filter((id) => !removed.has(id)) } : b)).filter((b) => b.kind === 'figure' || (b.sentenceIds?.length ?? 0) > 0);

  const out = pages.map((p) => (p.dirty ? ({ ...p.item, sentences: p.sentences } as T) : p.item));
  return { ok: true, texts: out, changed: out.filter((_, k) => pages[k].dirty), blocks: work, ids: idsOut };
}
