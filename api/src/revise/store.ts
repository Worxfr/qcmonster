// Modification d'un cours confirme (M1 #90): lectures partagees (texte du cours, requete, fiche) et vue de l'etat. Aucun contenu dans les journaux.
import { keys } from '../../../shared/ddb/keys.js';
import { applyChanges, type Block } from '../pipeline/changes.js';
import type { Ctx } from '../pipeline/ctx.js';
import type { Item } from '../pipeline/ports.js';
import { MSG_REVISION } from './lock.js';

/** Requete d'une modification, telle que gardee sous `JOB#<revisionId>/CHANGES` (7 jours, supprimee a la fin). */
export interface Changes {
  corrections: { id: string; text: string }[];
  removed: string[];
  added: { key: string; afterId: string | null; text: string; newBlock?: boolean }[];
}

/** Pages du cours (celles de l'en-tete seulement: le texte d'un ajout interrompu n'en fait pas partie) et couche de blocs. */
export async function loadCours(ctx: Ctx, sid: string, coursId: string, head: Item): Promise<{ texts: Item[]; blocks: Item | undefined }> {
  const prefix = `COURS#${coursId}#T`;
  const texts = (await ctx.db.query(`STUDENT#${sid}`, prefix)).filter((t) => t.SK.startsWith(prefix) && Number(t.page) <= Number(head.pages)).sort((a, b) => Number(a.page) - Number(b.page));
  return { texts, blocks: await ctx.db.get(keys.coursBlocks(sid, coursId)) };
}

/** Meme resultat a chaque appel (fonction pure): `rev-extract` et `rev-commit` la rejouent depuis le cours, que le verrou fige. */
export const applyTo = (texts: Item[], blocks: Item | undefined, c: Changes) => applyChanges(texts, blocks?.blocks as Block[] | undefined, { removed: c.removed, corrections: c.corrections, added: c.added });

export async function loadChanges(ctx: Ctx, revisionId: string): Promise<Changes> {
  const it = await ctx.db.get(keys.revChanges(revisionId));
  if (!it) throw new Error('requete de la modification introuvable');
  return { corrections: (it.corrections as Changes['corrections']) ?? [], removed: (it.removed as string[]) ?? [], added: (it.added as Changes['added']) ?? [] };
}

/** Une fiche de la modification, figee a la creation par le verrou (numeros libres, nombre de modifications, affirmations touchees). */
export interface RevFiche {
  docId: string;
  workDocId: string;
  sectionIndex: number;
  claimMax: number;
  qcmMax: number;
  gapMax: number;
  rev: number;
  /** Numeros des affirmations retirees par cette modification. */
  retired: number[];
  numerosRestants: number;
}
export const fichesOf = (job: Item): RevFiche[] => (job.fiches as RevFiche[] | undefined) ?? [];
export const revisionIdOf = (job: Item): string => job.SK.slice('JOB#'.length);

type Etat = 'en_cours' | 'terminee' | 'echec';
export const etatOf = (job: Item): Etat => (job.state === 'termine' ? 'terminee' : ['rejete', 'echec', 'expire'].includes(job.state as string) ? 'echec' : 'en_cours');
/** Vue du contrat (`Revision`): identifiants, etat, etape, fiches, message constant. Jamais un texte du cours. */
export function revisionView(job: Item) {
  const etat = etatOf(job);
  const etape = job.etape as 'preparation' | 'verification' | 'generation' | 'validation' | undefined;
  const message = job.state === 'termine' ? MSG_REVISION.done : job.state === 'rejete' ? MSG_REVISION.cancelled : etat === 'echec' ? (typeof job.restoredAt === 'string' ? MSG_REVISION.failed : MSG_REVISION.stuck) : undefined;
  return {
    revisionId: revisionIdOf(job),
    coursId: job.coursId as string,
    etat,
    ...(etape && etat === 'en_cours' ? { etape } : {}),
    fiches: fichesOf(job).map((f) => ({ docId: f.docId, etat, numerosRestants: f.numerosRestants })),
    ...(message ? { message } : {}),
    createdAt: job.createdAt as string,
  };
}
