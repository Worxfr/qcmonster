// Phrases oubliees ajoutees a la relecture (M1 #89). Logique pure: la place de chaque phrase vient de `shared/changes.ts`, la MEME fonction que le serveur,
// donc l'ecran montre exactement ce que le cours contiendra. Une phrase ajoutee est identifiee ici par sa cle (`n1`, `n2`...), stable tant qu'elle existe.
import { MAX_ADDED, MAX_ADDED_CHARS, MIN_ADDED_CHARS, applyChanges } from '../../../../shared/changes';
import type { Block, Sentence } from '../../types';
import type { PageText } from './blocks';

export { MAX_ADDED, MAX_ADDED_CHARS, MIN_ADDED_CHARS };

/** `afterId`: identifiant de la phrase de la lecture, cle d'une phrase ajoutee plus haut dans la liste, ou null (tout au debut). */
export interface Added { key: string; afterId: string | null; text: string; newBlock: boolean }

export const totalChars = (list: Added[]): number => list.reduce((n, a) => n + a.text.trim().length, 0);

/** Premiere cle libre (`n1`..`n99`). */
export function nextKey(list: Added[]): string {
  const used = new Set(list.map((a) => a.key));
  for (let k = 1; k < 100; k++) if (!used.has(`n${k}`)) return `n${k}`;
  return 'n99';
}

/** Pourquoi on ne peut pas ajouter ce texte (null = possible). `replacing`: texte d'une phrase ajoutee deja en place (modification). */
export function addProblem(list: Added[], text: string, replacing?: string): string | null {
  const t = text.trim();
  if (t.length < MIN_ADDED_CHARS) return `Écris au moins ${MIN_ADDED_CHARS} caractères.`;
  if (replacing === undefined && list.length >= MAX_ADDED) return `Tu peux ajouter ${MAX_ADDED} phrases au plus.`;
  if (totalChars(list) - (replacing?.trim().length ?? 0) + t.length > MAX_ADDED_CHARS) return `Les phrases ajoutées ne peuvent pas dépasser ${MAX_ADDED_CHARS} caractères en tout.`;
  return null;
}

/** Retire une phrase ajoutee; celles qui la suivaient se raccrochent a sa place (et gardent son paragraphe si elle en ouvrait un). */
export function removeAdded(list: Added[], key: string): Added[] {
  const gone = list.find((a) => a.key === key);
  if (!gone) return list;
  return list.filter((a) => a.key !== key).map((a) => (a.afterId === key ? { ...a, afterId: gone.afterId, newBlock: a.newBlock || gone.newBlock } : a));
}

/** Pages et blocs avec les phrases ajoutees a leur place; chaque phrase ajoutee porte sa cle comme identifiant et `added: true`. */
export function placeAdded(pages: PageText[], blocks: Block[] | undefined, list: Added[]): { pages: PageText[]; blocks: Block[] | undefined } {
  if (!list.length) return { pages, blocks };
  const r = applyChanges(pages.map((p) => ({ SK: `p${p.page}`, page: p.page, sentences: p.sentences })), blocks, { added: list.map((a) => ({ key: a.key, afterId: a.afterId, text: a.text, newBlock: a.newBlock })) });
  if (!r.ok) return { pages, blocks }; // incoherent (ne devrait pas arriver): on montre la lecture seule plutot que rien
  const byDef = new Map([...r.ids].map(([key, id]) => [id, key]));
  const rename = (id: string) => byDef.get(id) ?? id;
  return {
    pages: r.texts.map((t) => ({ page: t.page as number, sentences: (t.sentences as Sentence[]).map((s) => (byDef.has(s.id) ? { ...s, id: rename(s.id), added: true } : s)) })),
    blocks: r.blocks?.map((b) => (b.sentenceIds ? { ...b, sentenceIds: b.sentenceIds.map(rename) } : b)) as Block[] | undefined,
  };
}

/** Corps de la requete (`ConfirmRequest.added`). */
export const toRequest = (list: Added[]) => list.map((a) => ({ key: a.key, afterId: a.afterId, text: a.text.trim(), ...(a.newBlock ? { newBlock: true } : {}) }));
