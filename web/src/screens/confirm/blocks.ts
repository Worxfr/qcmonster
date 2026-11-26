// Document de relecture et de cours: des blocs (titre, paragraphe, liste, formule, figure) au-dessus des phrases.
// Les phrases restent l'unite des corrections, des coupes et des retraits (design R1 §2.1).
import type { Block, Figure, Sentence } from '../../types';

export interface PageText { page: number; sentences: Sentence[] }

export interface DocModel {
  blocks: Block[];
  /** Phrases dans l'ordre d'affichage (celui des blocs). */
  all: Sentence[];
  byId: Map<string, Sentence>;
  pageOf: Map<string, number>;
  figures: Map<string, Figure>;
  pages: number[];
}

/**
 * Blocs du serveur s'ils sont coherents (chaque phrase dans exactement un bloc, figures connues); sinon (job ou cours ancien, ou
 * blocs incoherents) un paragraphe par phrase: l'ecran affiche alors les phrases comme avant, sans rien perdre.
 */
export function buildModel(texts: PageText[], blocks?: Block[], figures?: Figure[]): DocModel {
  const byId = new Map<string, Sentence>();
  const pageOf = new Map<string, number>();
  for (const p of texts) for (const s of p.sentences) { byId.set(s.id, s); pageOf.set(s.id, p.page); }
  const figs = new Map((figures ?? []).map((f) => [f.figureId, f]));
  const flat = (): Block[] => texts.flatMap((p) => p.sentences.map((s, i): Block => ({ id: `s-${s.id}-${i}`, kind: 'paragraphe', sentenceIds: [s.id] })));

  let use: Block[] | null = blocks && blocks.length ? blocks.filter((b) => b.kind !== 'figure' || (b.figureId && figs.has(b.figureId))) : null;
  if (use) {
    const seen = new Set<string>();
    for (const b of use) {
      for (const id of b.sentenceIds ?? []) {
        if (!byId.has(id) || seen.has(id)) { use = null; break; }
        seen.add(id);
      }
      if (!use) break;
    }
    if (use && seen.size !== byId.size) use = null;
  }
  const list = use ?? flat();
  const all = list.flatMap((b) => (b.sentenceIds ?? []).map((id) => byId.get(id)!));
  return { blocks: list, all, byId, pageOf, figures: figs, pages: texts.map((p) => p.page) };
}

/** Page d'un bloc: celle de sa premiere phrase, ou de sa figure. */
export function blockPage(m: DocModel, b: Block): number | undefined {
  const id = b.sentenceIds?.[0];
  return id ? m.pageOf.get(id) : b.figureId ? m.figures.get(b.figureId)?.page : undefined;
}
