// Ajout de pages a un cours existant (F10, docs/F10-design.md). Un ajout est un scan ordinaire dont le job porte `appendTo` (le cours) et `appendBase`
// (l'etat du cours a la creation, jamais recalcule). Le verrou `appendJobId` sur l'en-tete du cours est pose dans la meme transaction que le job et
// libere en DERNIER pas de la restauration. Aucun texte de cours dans les journaux ni les erreurs.
import { keys } from '../../../shared/ddb/keys.js';
import { deleteDocTree } from '../../../shared/delete-tree.js';
import { CoursBlocksItemSchema } from '../../../shared/items.js';
import { MAX_COURS_PAGES, MAX_COURS_SECTIONS } from '../../../shared/scans.js';
import { iso, jobKey, type Ctx } from './ctx.js';
import type { Block, FigureMeta } from './blocks.js';
import { figureKey } from './figures.js';
import { treeDbFrom, type Item } from './ports.js';

/** Etat du cours a la creation de l'ajout. Le cours est fige par le verrou: cette base reste vraie jusqu'a la fin de l'ajout. */
export interface AppendBase {
  pagesBefore: number;
  sectionsBefore: number;
  nbPhrasesBefore: number;
  /** Le cours a une couche de blocs (`COURS#<id>#B`): sinon l'ajout n'en cree pas (l'ecran affiche les phrases). */
  hasBlocks: boolean;
  /** Plus grand numero de bloc et de figure deja pris (`b<n>`, `f<n>`): les nouveaux identifiants s'y ajoutent (P15, uniques dans tout le cours). */
  blockMax: number;
  figureMax: number;
}

export const MSG_APPEND = {
  notFinished: 'Ce cours est encore en cours de création',
  open: 'Un autre ajout est en cours pour ce cours',
  full: 'Ce cours est complet (30 pages et 20 sections au plus)',
  deleting: 'Ce cours est en cours de suppression',
  deleteBusy: 'Un ajout est en cours',
} as const;

/** Valeur du verrou posee par `DELETE /cours`: aucun ajout ne peut demarrer pendant la suppression. */
export const DELETING = 'suppression';

const num = (id: string): number => Number(id.slice(1)) || 0;
export const appendBaseOf = (job: Item): AppendBase | undefined => (job.appendBase && typeof job.appendTo === 'string' ? (job.appendBase as AppendBase) : undefined);
export const isAppend = (job: Item): boolean => appendBaseOf(job) !== undefined;
/** Rang du premier element du plan du job dans la liste de sections du cours. */
export const sectionOffset = (job: Item): number => appendBaseOf(job)?.sectionsBefore ?? 0;
/** Index de la photo d'une page (numerotee a la suite du cours) dans le job: `scans/<eleve>/<job>/<index>`. */
export const photoIndex = (job: Item, page: number): number => page - 1 - (appendBaseOf(job)?.pagesBefore ?? 0);

/** Les deux dernieres phrases du cours, en texte seul (contexte de lecture, jamais reecrites). Les textes d'un ajout en cours ne comptent pas. */
export async function lastSentences(ctx: Ctx, sid: string, coursId: string, pagesBefore: number, n = 2): Promise<{ id: string; text: string }[]> {
  const prefix = `COURS#${coursId}#T`;
  const texts = (await ctx.db.query(`STUDENT#${sid}`, prefix)).filter((t) => t.SK.startsWith(prefix) && Number(t.page) <= pagesBefore).sort((a, b) => Number(a.page) - Number(b.page));
  return texts.flatMap((t) => (t.sentences as { id: string; text: string }[]) ?? []).slice(-n).map((s) => ({ id: s.id, text: s.text }));
}

/** Etat du cours pour la base d'un ajout: lu une fois a la creation. */
export async function baseOf(ctx: Ctx, sid: string, head: Item): Promise<AppendBase> {
  const b = await ctx.db.get(keys.coursBlocks(sid, head.SK.slice('COURS#'.length)));
  const blocks = (b?.blocks as Block[] | undefined) ?? [];
  const figures = (b?.figures as FigureMeta[] | undefined) ?? [];
  return {
    pagesBefore: head.pages as number,
    sectionsBefore: (head.sections as unknown[]).length,
    nbPhrasesBefore: head.nbPhrases as number,
    hasBlocks: b !== undefined,
    blockMax: blocks.reduce((m, x) => Math.max(m, num(x.id)), 0),
    figureMax: figures.reduce((m, x) => Math.max(m, num(x.figureId)), 0),
  };
}

export type Refusal = { code: 'etat_invalide' | 'cours_plein'; message: string };
/** Un ajout de `pages` pages tient-il dans le cours? (30 pages, 20 sections). */
export function fits(head: Item, pages: number): Refusal | undefined {
  if ((head.pages as number) + pages > MAX_COURS_PAGES || (head.sections as unknown[]).length >= MAX_COURS_SECTIONS) return { code: 'cours_plein', message: MSG_APPEND.full };
  return undefined;
}

/** Libere le verrou si, et seulement si, il appartient a ce job. Dernier pas de toute fin d'ajout. */
export async function releaseLock(ctx: Ctx, sid: string, coursId: string, jobId: string): Promise<void> {
  await ctx.db.update(keys.cours(sid, coursId), { remove: ['appendJobId'], cond: { exists: true, eq: { appendJobId: jobId } } });
}

/**
 * Le verrou d'un cours est-il repris? `holder` = job qui le porte. Un verrou n'est repris que si son job est termine, ou final ET restaure, ou absent
 * (expire apres 7 jours: un job final est toujours restaure avant). Un job final non restaure est restaure ici (sa restauration libere le verrou).
 * Renvoie vrai si le verrou est libre apres l'appel.
 */
export async function reclaimLock(ctx: Ctx, sid: string, head: Item): Promise<boolean> {
  const holder = head.appendJobId;
  if (typeof holder !== 'string') return true;
  if (holder === DELETING) return false;
  const coursId = head.SK.slice('COURS#'.length);
  const job = await ctx.db.get(jobKey(sid, holder));
  const final = job && ['rejete', 'echec', 'expire'].includes(job.state as string);
  if (job && !final && job.state !== 'termine') return false; // un ajout est reellement ouvert
  if (job && final && typeof job.restoredAt !== 'string') {
    try {
      await restoreAfterFailedAppend(ctx, sid, job);
    } catch {
      return false; // restauration impossible avec les droits de ce handler (ajout deja confirme): le verrou reste, `DELETE /cours` ou l'expiration la termine
    }
  }
  await releaseLock(ctx, sid, coursId, holder);
  return true;
}

/**
 * Restauration du cours d'origine apres un ajout qui n'aboutit pas (echec, rejet, annulation, expiration, course perdue). Jamais `deleteCoursTree`.
 * Idempotente, sure a tout etat. Les ecritures sur le cours exigent `appendJobId = <ce job>`: rejouee apres qu'un autre ajout a pris le verrou,
 * elle ne touche ni le cours ni l'ajout suivant (seules les donnees propres a ce job sont supprimees). Le verrou est libere en dernier.
 */
export async function restoreAfterFailedAppend(ctx: Ctx, sid: string, job: Item): Promise<void> {
  const base = appendBaseOf(job);
  if (!base) return;
  const jobId = job.SK.slice('JOB#'.length);
  const coursId = job.appendTo as string;
  const tree = treeDbFrom(ctx.db);
  // Avant `confirmStartedAt`, ce job n'a rien ecrit dans le cours ni dans S3: seuls le marqueur et le verrou sont a traiter (droits etroits de `jobs-cancel` et `scans-create`).
  if (job.confirmStartedAt === undefined) {
    await ctx.db.update(jobKey(sid, jobId), { set: { restoredAt: iso(ctx) }, cond: { exists: true } });
    await releaseLock(ctx, sid, coursId, jobId);
    return;
  }
  // 1. fiches du job (propres a ce job, quel que soit le verrou)
  const ids = new Set<string>();
  if (typeof job.docId === 'string') ids.add(job.docId);
  for (const d of (job.docIds as string[] | undefined) ?? []) ids.add(d);
  for (const s of (job.sections as { docId?: string }[] | undefined) ?? []) if (s.docId) ids.add(s.docId);
  for (const docId of ids) {
    await deleteDocTree(tree, sid, docId);
    const rest = await ctx.db.query(`DOC#${docId}`);
    if (rest.length) await ctx.db.remove(rest.map((o) => ({ PK: o.PK, SK: o.SK })));
  }
  const head = await ctx.db.get(keys.cours(sid, coursId));
  const mine = head?.appendJobId === jobId;
  if (head && mine) {
    // 2. textes des nouvelles pages
    const prefix = `COURS#${coursId}#T`;
    const extra = (await ctx.db.query(`STUDENT#${sid}`, prefix)).filter((t) => t.SK.startsWith(prefix) && Number(t.page) > base.pagesBefore);
    if (extra.length) await ctx.db.remove(extra.map((t) => ({ PK: t.PK, SK: t.SK })));
    // 3. en-tete: affectation depuis la base (jamais un decrement)
    await ctx.db.update(keys.cours(sid, coursId), { set: { pages: base.pagesBefore, nbPhrases: base.nbPhrasesBefore, sections: (head.sections as unknown[]).slice(0, base.sectionsBefore) }, cond: { exists: true, eq: { appendJobId: jobId } } });
    // blocs et figures du cours: ceux de la base seulement; images des nouvelles figures supprimees
    const b = await ctx.db.get(keys.coursBlocks(sid, coursId));
    if (b) {
      const figures = (b.figures as FigureMeta[]) ?? [];
      const blocks = ((b.blocks as Block[]) ?? []).filter((x) => num(x.id) <= base.blockMax);
      const oldFigures = figures.filter((f) => num(f.figureId) <= base.figureMax);
      if (blocks.length !== (b.blocks as unknown[]).length || oldFigures.length !== figures.length) {
        for (const f of figures.filter((x) => num(x.figureId) > base.figureMax)) await ctx.figures.deleteAll(figureKey(sid, coursId, f.figureId));
        await ctx.db.update(keys.coursBlocks(sid, coursId), { set: CoursBlocksItemSchema.pick({ blocks: true, figures: true }).parse({ blocks, figures: oldFigures }), cond: { exists: true } });
      }
    }
  }
  // 4. copie de travail du texte et des blocs du job (et figures copiees par une confirmation interrompue avant l'ecriture des blocs)
  const meta = mine ? await ctx.db.get(keys.jobBlocks(jobId)) : undefined;
  for (const f of (meta?.figures as FigureMeta[] | undefined) ?? []) await ctx.figures.deleteAll(figureKey(sid, coursId, `f${base.figureMax + num(f.figureId)}`));
  const work = (await ctx.db.query(`JOB#${jobId}`)).filter((t) => t.SK.startsWith('TEXT#') || t.SK === 'BLOCKS').map((t) => ({ PK: t.PK, SK: t.SK }));
  if (work.length) await ctx.db.remove(work);
  // 5. marqueur, 6. verrou en dernier
  await ctx.db.update(jobKey(sid, jobId), { set: { restoredAt: iso(ctx) }, cond: { exists: true } });
  if (mine) await releaseLock(ctx, sid, coursId, jobId);
}
