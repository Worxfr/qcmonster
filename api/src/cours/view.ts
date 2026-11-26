// Lecture des blocs, figures et marques d'un cours (R1, contrat 1.5). Eleve seulement: les appelants refusent le parent avant d'arriver ici.
// Isolation par le handler: les cles S3 sont construites avec le `sid` du jeton et seuls les `figureId` ecrits dans `COURS#<id>#B` de CET eleve sont signes.
import { keys } from '../../../shared/ddb/keys.js';
import { retiredClaims } from '../../../shared/items.js';
import { ID_RE, type Ctx } from '../pipeline/ctx.js';
import type { Block, FigureMeta } from '../pipeline/blocks.js';
import { FIGURE_URL_TTL_S, figureKey } from '../pipeline/figures.js';
import type { Item } from '../pipeline/ports.js';
import { claimStatus } from '../pipeline/steps-doc.js';

type Rec = Record<string, unknown>;
export const MAX_MARKS = 500;

/** Blocs et figures conserves du cours; absent pour un cours ancien. */
export async function loadCoursBlocks(ctx: Ctx, sid: string, coursId: string): Promise<{ blocks: Block[]; figures: FigureMeta[] } | undefined> {
  const b = await ctx.db.get(keys.coursBlocks(sid, coursId));
  return b ? { blocks: (b.blocks as Block[]) ?? [], figures: (b.figures as FigureMeta[]) ?? [] } : undefined;
}

/** Figures avec URL pre-signee de 5 minutes, re-signee a chaque lecture. */
export async function signFigures(ctx: Ctx, sid: string, coursId: string, figs: FigureMeta[]) {
  const expire = new Date(ctx.now().getTime() + FIGURE_URL_TTL_S * 1000).toISOString();
  return Promise.all(
    figs.map(async (f) => ({ figureId: f.figureId, page: f.page, kind: f.kind, alt: f.alt, ...(f.caption ? { caption: f.caption } : {}), ...(f.box ? { box: f.box } : {}), url: await ctx.figures.presignGet(figureKey(sid, coursId, f.figureId), FIGURE_URL_TTL_S), urlExpireAt: expire })),
  );
}

/** Rang de chaque phrase dans l'ordre du cours, a partir des textes (pages triees numeriquement). */
export const sentenceOrder = (texts: Item[]): Map<string, number> => {
  const order = new Map<string, number>();
  for (const t of [...texts].sort((a, b) => Number(a.page) - Number(b.page))) for (const s of (t.sentences as { id: string }[] | undefined) ?? []) order.set(s.id, order.size);
  return order;
};

/**
 * Rang d'une fiche parmi les sections non ignorees du COURS (F10): le `sectionIndex` d'une fiche d'ajout est local a son scan, alors que
 * `figuresOfSection` compte sur tout le cours. On retrouve la section par le `docId` de la fiche; sans lien (cours ancien), le `sectionIndex` de la fiche.
 */
export function sectionRank(head: Rec, docId: string, fallback: number): number {
  const kept = (Array.isArray(head.sections) ? (head.sections as { docId?: string; ignore?: boolean }[]) : []).filter((s) => s.ignore !== true);
  const k = kept.findIndex((s) => s.docId === docId);
  return k >= 0 ? k : fallback;
}

/**
 * Figures de la section `sectionIndex` (rang parmi les sections avec fiche): toutes les figures des blocs de la section, de sa premiere phrase a la
 * phrase qui precede la section suivante. Une figure est rattachee a la section qui contient le bloc de texte precedent.
 */
export function figuresOfSection(head: Rec, order: Map<string, number>, blocks: Block[], figs: FigureMeta[], sectionIndex: number): FigureMeta[] {
  const all = Array.isArray(head.sections) ? (head.sections as { fromSentenceId?: string; ignore?: boolean }[]) : [];
  const starts = all.map((s) => order.get(String(s.fromSentenceId)) ?? Infinity);
  const kept = all.map((s, n) => ({ s, n })).filter((x) => x.s.ignore !== true);
  const target = kept[sectionIndex]?.n;
  if (target === undefined) return [];
  const sectionOf = (idx: number): number => starts.reduce((acc, st, n) => (st <= idx ? n : acc), 0);
  let current = 0;
  const wanted = new Set<string>();
  for (const b of blocks) {
    if (b.kind !== 'figure') {
      const first = b.sentenceIds?.[0] !== undefined ? order.get(b.sentenceIds[0]) : undefined;
      if (first !== undefined) current = sectionOf(first);
    } else if (current === target && b.figureId) wanted.add(b.figureId);
  }
  return figs.filter((f) => wanted.has(f.figureId));
}

/**
 * Marques de verification par phrase: statut le plus severe (erreur > non_verifiable > verifiee) parmi les affirmations de la phrase.
 * Seules les fiches de l'en-tete du cours qui existent chez CET eleve sont lues (un `docId` etranger n'est jamais lu). Plafond de 500.
 */
export async function coursMarks(ctx: Ctx, sid: string, head: Rec): Promise<{ sentenceId: string; status: 'verifiee' | 'erreur' | 'non_verifiable'; docId: string; claimId: string }[]> {
  const sections = Array.isArray(head.sections) ? (head.sections as { docId?: unknown }[]) : [];
  const ids = [...new Set(sections.map((s) => s.docId).filter((d): d is string => typeof d === 'string' && ID_RE.test(d)))];
  const rank = { erreur: 0, non_verifiable: 1, verifiee: 2 } as const;
  const best = new Map<string, { sentenceId: string; status: keyof typeof rank; docId: string; claimId: string }>();
  for (const docId of ids) {
    const fiche = await ctx.db.get(keys.doc(sid, docId));
    if (!fiche) continue;
    const gone = retiredClaims(fiche);
    const part = (await ctx.db.query(`DOC#${docId}`)).filter((x) => !(x.SK.startsWith('CLAIM#') && gone.has(Number(x.SK.slice('CLAIM#'.length)))));
    const verdicts = new Map(part.filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [x.SK.slice('VERDICT#'.length), x]));
    for (const c of part.filter((x) => x.SK.startsWith('CLAIM#'))) {
      const nn = c.SK.slice('CLAIM#'.length);
      const st = claimStatus(c, verdicts.get(nn));
      const sentenceId = (c.origine as { phraseId?: string } | undefined)?.phraseId;
      if (st === 'non_factuelle' || !sentenceId) continue;
      const cur = best.get(sentenceId);
      if (!cur || rank[st] < rank[cur.status]) best.set(sentenceId, { sentenceId, status: st, docId, claimId: nn });
    }
  }
  return [...best.values()].sort((a, b) => rank[a.status] - rank[b.status]).slice(0, MAX_MARKS);
}
