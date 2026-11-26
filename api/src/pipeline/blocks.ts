// Blocs, figures et fiche structuree (R1, docs/R1-design.md 2 et 8.2). Fonctions pures: aucun appel de modele, aucun reseau.
import { cleanLabel } from '../../../shared/scans.js';
import { sanitizeFormulaBlock, sanitizeLatex } from '../../../shared/latex.js';
import { assembleParts, MAX_SENTENCE, splitSentences, type AssembledPage } from './text.js';

export const MAX_BLOCKS = 400;
export const MAX_BLOCK_SENTENCES = 200;
export const MAX_FIGURES = 8;
/** Au-dela, les marquages « douteux » ne disent plus rien: le code les supprime tous (P11, a ajuster a la mesure). */
export const DOUBT_MAX_RATIO = 0.4;
const BOX_MIN_AREA = 0.03;
const BOX_MAX_AREA = 0.9;

export interface Block {
  id: string;
  kind: 'titre' | 'paragraphe' | 'liste' | 'formule' | 'figure';
  level?: number;
  ordered?: boolean;
  sentenceIds?: string[];
  figureId?: string;
}
export interface FigureBox {
  x: number;
  y: number;
  w: number;
  h: number;
}
export const FIGURE_KINDS = ['schema', 'graphique', 'tableau', 'carte', 'photo', 'autre'] as const;
export interface FigureMeta {
  figureId: string;
  page: number;
  kind: (typeof FIGURE_KINDS)[number];
  alt: string;
  caption?: string;
  /** Absent: page entiere (cadre introuvable) ou cadre a verifier (`boxInvalid`). */
  box?: FigureBox;
  /** Le cadre propose est faux: une reprise par un modele plus gros est permise (3.5), sinon page entiere. */
  boxInvalid?: boolean;
  /** Identifiant donne par le modele sur la page (sert a la reprise). */
  modelId?: string;
}

export interface RawFigure {
  id: string;
  box?: number[];
  kind?: string;
  alt?: string;
  caption?: string;
}
export interface RawPage {
  page: number;
  suite: boolean;
  md?: string;
  lines?: string[];
  figures?: RawFigure[];
}

/** Cadre [x, y, w, h] en fractions de la page: dans [0,1], surface entre 3 % et 90 %. */
export function validBox(b: number[] | undefined): FigureBox | undefined {
  if (!b || b.length !== 4 || b.some((n) => !Number.isFinite(n))) return undefined;
  const [x, y, w, h] = b;
  if (x < 0 || y < 0 || w <= 0 || h <= 0 || x + w > 1.0001 || y + h > 1.0001) return undefined;
  const area = w * h;
  if (area < BOX_MIN_AREA || area > BOX_MAX_AREA) return undefined;
  return { x, y, w, h };
}

// ---------------------------------------------------------------- Markdown restreint -> unites
interface UnitSentence {
  text: string;
  doubt: boolean;
}
interface Unit {
  kind: Block['kind'];
  level?: number;
  ordered?: boolean;
  sentences: UnitSentence[];
  figRef?: string;
}

/** Une ligne du Markdown restreint (`#`, `-`, `1.`, `=`, `[[f1]]`, `~` de doute), ligne vide = nouveau paragraphe. */
export function parseUnits(md: string): Unit[] {
  const units: Unit[] = [];
  let para: Unit | undefined;
  let list: Unit | undefined;
  const close = () => {
    para = undefined;
    list = undefined;
  };
  for (const raw of md.split(/\r?\n/)) {
    let line = raw.trim();
    if (!line) {
      close();
      continue;
    }
    const doubt = line.startsWith('~');
    if (doubt) line = line.slice(1).trim();
    if (!line) continue;
    const fig = /^\[\[(f\d+)\]\]$/.exec(line);
    const head = /^(#{1,3})\s+(.+)$/.exec(line);
    const item = /^(?:([-*•])|(\d{1,3})[.)])\s+(.+)$/.exec(line);
    const formula = /^=\s+(.+)$/.exec(line);
    if (fig) {
      close();
      units.push({ kind: 'figure', sentences: [], figRef: fig[1] });
    } else if (head) {
      close();
      units.push({ kind: 'titre', level: head[1].length, sentences: [{ text: head[2].trim().slice(0, MAX_SENTENCE), doubt }] });
    } else if (formula) {
      close();
      units.push({ kind: 'formule', sentences: [{ text: formula[1].trim(), doubt }] });
    } else if (item) {
      para = undefined;
      const ordered = item[2] !== undefined;
      if (!list || list.ordered !== ordered) {
        list = { kind: 'liste', ordered, sentences: [] };
        units.push(list);
      }
      list.sentences.push({ text: item[3].trim().slice(0, MAX_SENTENCE), doubt });
    } else {
      list = undefined;
      if (!para) {
        para = { kind: 'paragraphe', sentences: [] };
        units.push(para);
      }
      for (const t of splitSentences(line)) para.sentences.push({ text: t, doubt });
    }
  }
  return units;
}

/** Ancien format (`lines`): une ligne = un paragraphe. */
const unitsFromLines = (lines: string[]): Unit[] =>
  lines.flatMap((l) => {
    const sentences = splitSentences(l).map((text) => ({ text, doubt: false }));
    return sentences.length ? [{ kind: 'paragraphe' as const, sentences }] : [];
  });

export interface ParsedRead {
  pages: AssembledPage[];
  /** Absent: pas de couche de blocs (plus de 400 blocs): l'ecran affiche les phrases. */
  blocks?: Block[];
  figures: FigureMeta[];
  /** Plus de 40 % de phrases douteuses: les marquages ont ete supprimes. */
  doubtDropped: boolean;
}

/**
 * Sortie de lecture -> phrases numerotees, blocs et figures. Le code reste maitre: bornes 2.5, figures valides (8 au plus), LaTeX controle,
 * recollage des phrases coupees par un saut de page (le paragraphe suivant rejoint le paragraphe precedent), garde-fou des phrases douteuses.
 * `figures: false` (interrupteur FIGURES_ENABLED): aucune figure n'est retenue.
 */
export function parseBlocks(read: RawPage[], opts: { figures?: boolean } = {}): ParsedRead {
  const withFigures = opts.figures !== false;
  const sorted = [...read].sort((a, b) => a.page - b.page);
  const perPage = sorted.map((p) => {
    const md = p.md?.trim();
    let units = md ? parseUnits(md) : [];
    if (!units.some((u) => u.sentences.length > 0 || u.kind === 'figure')) units = unitsFromLines(p.lines ?? []);
    // Texte controle: formule seule sure ou retombee en paragraphe de texte simple; LaTeX en ligne controle.
    units = units.map((u) => {
      if (u.kind === 'formule') {
        const src = sanitizeFormulaBlock(u.sentences[0].text);
        return src ? { ...u, sentences: [{ ...u.sentences[0], text: src }] } : { ...u, kind: 'paragraphe' as const, sentences: [{ ...u.sentences[0], text: sanitizeLatex(u.sentences[0].text.replace(/\$/g, '')) }] };
      }
      return { ...u, sentences: u.sentences.map((s) => ({ ...s, text: sanitizeLatex(s.text) })).filter((s) => s.text.trim()) };
    });
    return { p, units: units.filter((u) => u.kind === 'figure' || u.sentences.length > 0) };
  });

  const assembled = assembleParts(perPage.map(({ p, units }) => ({ page: p.page, suite: p.suite, parts: units.flatMap((u) => u.sentences.map((s) => s.text)) })));

  // Figures: identifiants globaux dans l'ordre du document, 8 au plus; marqueur sans figure declaree ignore, figure sans marqueur ajoutee en fin de page.
  const figures: FigureMeta[] = [];
  const blocks: Block[] = [];
  let nextBlock = 1;
  const addBlock = (b: Omit<Block, 'id'>) => blocks.push({ id: `b${nextBlock++}`, ...b });

  perPage.forEach(({ p, units }, idx) => {
    const page = assembled[idx];
    const declared = new Map((withFigures ? (p.figures ?? []) : []).map((f) => [f.id, f]));
    const used = new Set<string>();
    const ordered: Unit[] = [];
    for (const u of units) {
      if (u.kind !== 'figure') ordered.push(u);
      else if (u.figRef && declared.has(u.figRef) && !used.has(u.figRef)) {
        used.add(u.figRef);
        ordered.push(u);
      }
    }
    for (const id of declared.keys()) if (!used.has(id)) ordered.push({ kind: 'figure', sentences: [], figRef: id });

    // Phrases du texte assemble, dans l'ordre; la premiere phrase du premier bloc de texte est absorbee par la page precedente si `glued`.
    const flat = page.sentences;
    let cursor = 0;
    const firstUnit = units.find((u) => u.sentences.length > 0);
    const absorbed = units.reduce((n, u) => n + u.sentences.length, 0) - flat.length; // 0 ou 1
    for (const u of ordered) {
      if (u.kind === 'figure') {
        if (figures.length >= MAX_FIGURES) continue;
        const f = declared.get(u.figRef!)!;
        const figureId = `f${figures.length + 1}`;
        const box = validBox(f.box);
        const kind = (FIGURE_KINDS as readonly string[]).includes(f.kind ?? '') ? (f.kind as FigureMeta['kind']) : 'autre';
        const alt = sanitizeLatex(cleanLabel(f.alt, 300) ?? `Figure de la page ${p.page}`);
        const caption = cleanLabel(f.caption, 200);
        figures.push({ figureId, page: p.page, kind, alt, ...(caption ? { caption: sanitizeLatex(caption) } : {}), ...(box ? { box } : { boxInvalid: true }), modelId: f.id });
        addBlock({ kind: 'figure', figureId });
        continue;
      }
      const skip = absorbed > 0 && u === firstUnit ? 1 : 0;
      if (skip && u.sentences[0].doubt) markTailDoubt(assembled, idx); // le doute d'une phrase absorbee passe a celle qui l'a recue
      const mine = u.sentences.slice(skip);
      const sents = flat.slice(cursor, cursor + mine.length);
      cursor += mine.length;
      mine.forEach((s, k) => {
        if (s.doubt) sents[k].doubt = true;
      });
      if (sents.length === 0) continue;
      const ids = sents.map((s) => s.id);
      const prev = blocks[blocks.length - 1];
      if (skip && u.kind === 'paragraphe' && prev?.kind === 'paragraphe') {
        prev.sentenceIds = [...(prev.sentenceIds ?? []), ...ids]; // le paragraphe continue sur la page suivante
        continue;
      }
      addBlock({ kind: u.kind, ...(u.kind === 'titre' ? { level: u.level } : {}), ...(u.kind === 'liste' ? { ordered: u.ordered === true } : {}), sentenceIds: ids });
    }
  });

  // Paragraphes devenus trop longs apres recollage: coupes en blocs consecutifs de 200 phrases.
  const finalBlocks = blocks.flatMap((b) => {
    if (!b.sentenceIds || b.sentenceIds.length <= MAX_BLOCK_SENTENCES) return [b];
    const out: Block[] = [];
    for (let k = 0; k < b.sentenceIds.length; k += MAX_BLOCK_SENTENCES) out.push({ ...b, sentenceIds: b.sentenceIds.slice(k, k + MAX_BLOCK_SENTENCES) });
    return out;
  }).map((b, k) => ({ ...b, id: `b${k + 1}` }));

  // Garde-fou du doute.
  const all = assembled.flatMap((a) => a.sentences);
  const doubtN = all.filter((s) => s.doubt).length;
  const doubtDropped = all.length > 0 && doubtN / all.length > DOUBT_MAX_RATIO;
  for (const s of all) {
    if (doubtDropped || !s.doubt) delete s.doubt;
  }

  if (finalBlocks.length > MAX_BLOCKS) return { pages: assembled, figures: [], doubtDropped };
  return { pages: assembled, blocks: finalBlocks, figures, doubtDropped };
}

function markTailDoubt(pages: AssembledPage[], idx: number): void {
  for (let k = idx - 1; k >= 0; k--) {
    const last = pages[k].sentences[pages[k].sentences.length - 1];
    if (last) {
      last.doubt = true;
      return;
    }
  }
}

/** Texte envoye au classement: chaque ligne porte un prefixe de bloc (`# `, `- `, `= `) pour que le modele voie les titres. */
export function classifyLines(pages: AssembledPage[], blocks: Block[] | undefined): { id: string; text: string }[] {
  const prefix = new Map<string, string>();
  for (const b of blocks ?? []) {
    const p = b.kind === 'titre' ? `${'#'.repeat(b.level ?? 2)} ` : b.kind === 'liste' ? '- ' : b.kind === 'formule' ? '= ' : '';
    if (p) for (const id of b.sentenceIds ?? []) prefix.set(id, p);
  }
  return pages.flatMap((pg) => pg.sentences.map((s) => ({ id: s.id, text: `${prefix.get(s.id) ?? ''}${s.text}` })));
}

/** Renumerotation a l'ecriture dans un cours qui existe deja (ajout de pages, 2.6): `b<n + decalage>`, `f<n + decalage>`. Les phrases ne changent pas. */
export function renumber(blocks: Block[], figures: FigureMeta[], offset: { block: number; figure: number }): { blocks: Block[]; figures: FigureMeta[] } {
  const num = (id: string, d: number) => `${id[0]}${Number(id.slice(1)) + d}`;
  return {
    blocks: blocks.map((b) => ({ ...b, id: num(b.id, offset.block), ...(b.figureId ? { figureId: num(b.figureId, offset.figure) } : {}) })),
    figures: figures.map((f) => ({ ...f, figureId: num(f.figureId, offset.figure) })),
  };
}

// ---------------------------------------------------------------- fiche structuree (8.2)
export interface ClaimForFiche {
  texte: string;
  status: 'verifiee' | 'erreur' | 'non_verifiable' | 'non_factuelle';
}
export interface FicheParagraph {
  heading?: string;
  text: string;
  claimIds?: string[];
}
export interface RecallItem {
  kind: 'date' | 'formule' | 'definition' | 'nombre';
  text: string;
  claimId: string;
  verified: boolean;
}
export const MAX_FICHE_PARAGRAPHS = 6;
export const MAX_PARAGRAPH_WORDS = 150;
export const MAX_FICHE_WORDS = 350;
export const MAX_RECALL = 12;
const RECALL_KINDS = ['date', 'formule', 'definition', 'nombre'] as const;
const wordCount = (s: string) => s.split(/\s+/).filter(Boolean).length;

/**
 * Controle de la fiche du modele. `undefined` = illisible ou hors limites: l'appelant retombe sur le `resume` (un paragraphe, pas de rappel).
 * Le texte du rappel est COPIE de l'affirmation citee, jamais ecrit par le modele; une affirmation en erreur ou non factuelle n'est jamais reprise.
 */
export function validFiche(raw: unknown, claims: Map<string, ClaimForFiche>): { body: FicheParagraph[]; recall: RecallItem[] } | undefined {
  const r = raw as { paragraphes?: unknown; rappel?: unknown } | undefined;
  if (!r || !Array.isArray(r.paragraphes) || r.paragraphes.length === 0) return undefined;
  const body: FicheParagraph[] = [];
  let total = 0;
  for (const p of r.paragraphes.slice(0, MAX_FICHE_PARAGRAPHS) as { heading?: unknown; text?: unknown; claimIds?: unknown }[]) {
    const text = typeof p?.text === 'string' ? sanitizeLatex(p.text.trim()) : '';
    if (!text || text.length > 1200) return undefined;
    const n = wordCount(text);
    total += n;
    if (n > MAX_PARAGRAPH_WORDS || total > MAX_FICHE_WORDS) return undefined;
    const heading = cleanLabel(p.heading, 120);
    const ids = Array.isArray(p.claimIds) ? [...new Set(p.claimIds.filter((c): c is string => typeof c === 'string' && claims.has(c)))].slice(0, 20) : [];
    body.push({ ...(heading ? { heading: sanitizeLatex(heading) } : {}), text, ...(ids.length ? { claimIds: ids } : {}) });
  }
  const recall: RecallItem[] = [];
  const seen = new Set<string>();
  if (Array.isArray(r.rappel)) {
    for (const it of r.rappel as { kind?: unknown; claimId?: unknown }[]) {
      const c = typeof it?.claimId === 'string' ? claims.get(it.claimId) : undefined;
      if (!c || (c.status !== 'verifiee' && c.status !== 'non_verifiable') || seen.has(it.claimId as string)) continue;
      if (!(RECALL_KINDS as readonly unknown[]).includes(it.kind)) continue;
      const kind = it.kind === 'formule' && !c.texte.includes('=') ? 'definition' : (it.kind as RecallItem['kind']);
      seen.add(it.claimId as string);
      recall.push({ kind, text: sanitizeLatex(c.texte.slice(0, 1000)), claimId: it.claimId as string, verified: c.status === 'verifiee' });
      if (recall.length >= MAX_RECALL) break;
    }
  }
  return { body, recall };
}
