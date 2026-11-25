// Cout de verify-run (lot L2b) ajoute au job, une seule fois par fiche ET par tentative. Partage par `sectionCost` (steps-doc.ts) et `failJob` (steps.ts).
import { DAY_S, jobKey, ttlIn, type Ctx } from './ctx.js';

/** Brouillon d'une fiche en cours d'extraction: `DOC#<docId> / DRAFT` (titre, matiere, numero de tentative d'extraction). Aucun texte de cours. */
export const draftKey = (docId: string) => ({ PK: `DOC#${docId}`, SK: 'DRAFT' });

/** Numero de la tentative d'extraction en cours pour cette fiche (0 si aucun brouillon). */
export async function currentAttempt(ctx: Ctx, docId: string): Promise<number> {
  const d = await ctx.db.get(draftKey(docId));
  return typeof d?.attempt === 'number' ? d.attempt : 0;
}

/**
 * Ajoute au job la somme des `coutMicros` des VERDICT# de `docId`, une seule fois par tentative (marqueur ecrit dans la meme transaction que
 * l'ajout). `extract` efface les verdicts d'une tentative precedente: il appelle d'abord cette fonction pour la tentative qui se termine,
 * si bien qu'une reprise ne perd aucun cout et ne le compte jamais deux fois. Renvoie les micro-euros ajoutes.
 */
export async function addVerifyCostOnce(ctx: Ctx, sid: string, jobId: string, docId: string, attempt?: number): Promise<number> {
  const n = attempt ?? (await currentAttempt(ctx, docId));
  const micros = (await ctx.db.query(`DOC#${docId}`, 'VERDICT#')).reduce((a, v) => a + (typeof v.coutMicros === 'number' && Number.isFinite(v.coutMicros) ? v.coutMicros : 0), 0);
  if (micros <= 0) return 0;
  const added = await ctx.db.transact([
    { put: { PK: `JOB#${jobId}`, SK: `COSTADDED#${docId}#${n}`, ttl: ttlIn(ctx, 7 * DAY_S) }, ifNotExists: true },
    { key: jobKey(sid, jobId), spec: { add: { coutMicros: micros }, cond: { exists: true } } },
  ]);
  return added ? micros : 0;
}
