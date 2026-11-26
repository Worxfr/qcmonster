// Fin sans correction d'une copie (E1, design 5.3 et 8): echec technique, copie deja rendue, cout ou illisible. UNE seule fonction pour
// `copie-fail`, `copie-correct` (illisible, plafond) et `copies-submit` (demarrage impossible), sous condition d'etat `en_correction`:
// un `Catch` rejoue ne rembourse jamais deux fois. Ecrit seulement STUDENT# et FAMILY# (aucun PROFILE, aucun TEST#).
import { keys } from '../../../shared/ddb/keys.js';
import { parseExoRef } from '../../../shared/exo.js';
import type { Deps } from '../lib/deps.js';
import type { Item, Write } from '../lib/store.js';
import { parisDate, parisMonth } from '../game/time.js';
import { pageKey, type CopieFiles, type CopieInput } from './ports.js';

export type Motif = 'copie_deja_rendue' | 'budget' | 'technique' | 'plafond_cout';
const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** Ecriture qui libere le verrou `COPIEACTIVE` s'il porte CETTE copie (sous condition de version: le verrou d'une autre copie n'est jamais libere). */
export async function releaseLockWrite(deps: Deps, sid: string, copieId: string): Promise<Write | undefined> {
  const lock = await deps.store.get(keys.copieActive(sid));
  if (!lock || lock.copieId !== copieId) return undefined;
  return { item: { ...keys.copieActive(sid), copieId: '', depuis: 0 }, when: lock.v ?? 'any' };
}

export const pageKeys = (sid: string, copieId: string, pages: number): string[] => Array.from({ length: pages }, (_, i) => pageKey(sid, copieId, i + 1));

/**
 * Passe la copie a `echec` (ou `illisible`) et rembourse. `refundAttempt`: l'essai n'est pas compte (echec technique, illisible); les pages sont
 * toujours remboursees pour un echec, jamais pour `illisible` (design 12). Renvoie false si la copie n'etait plus `en_correction`.
 */
export async function endWithoutCorrection(
  deps: Deps,
  input: CopieInput,
  o: { etat: 'echec' | 'illisible'; motif?: Motif; refundPages: boolean; refundAttempt: boolean; files?: Pick<CopieFiles, 'deleteKeys'> },
): Promise<boolean> {
  if (o.files) await o.files.deleteKeys(pageKeys(input.sid, input.copieId, input.pages)); // images d'abord (S3 puis base), cles exactes
  const now = deps.now();
  for (let attempt = 0; attempt < 4; attempt++) {
    const c = await deps.store.get(keys.copie(input.sid, input.copieId));
    if (!c || c.etat !== 'en_correction') return false;
    const writes: Write[] = [{ item: { ...c, etat: o.etat, ...(o.motif ? { motif: o.motif } : {}), retourAt: now.toISOString(), ttl: Math.floor(now.getTime() / 1000) + 2 * 86_400 }, when: c.v ?? 'any' }];
    const month = parisMonth(new Date(num(c.submittedAt) || now.getTime()));
    if (o.refundPages) {
      for (const pk of [`STUDENT#${input.sid}`, `FAMILY#${input.fid}`]) {
        const q = await deps.store.get(keys.copieQ(pk, month));
        if (q) writes.push({ item: { ...q, pages: Math.max(0, num(q.pages) - input.pages) }, when: q.v ?? 'any' });
      }
    }
    if (o.refundAttempt) {
      const ref = parseExoRef(input.exoRef);
      const p = ref ? await deps.store.get(keys.exop(input.sid, ref.docId, ref.nn)) : undefined;
      if (p) writes.push({ item: { ...p, nbCopies: Math.max(0, num(p.nbCopies) - 1) }, when: p.v ?? 'any' });
      const day = await deps.store.get(keys.copieJ(input.sid, parisDate(new Date(num(c.submittedAt) || now.getTime()))));
      if (day) writes.push({ item: { ...day, corr: Math.max(0, num(day.corr) - 1), ...(o.etat === 'illisible' && ref ? { illisible: { ...((day.illisible ?? {}) as Record<string, number>), [input.exoRef]: num((day.illisible as Record<string, number> | undefined)?.[input.exoRef]) + 1 } } : {}) }, when: day.v ?? 'any' });
    }
    const lock = await releaseLockWrite(deps, input.sid, input.copieId);
    if (lock) writes.push(lock);
    if (await deps.store.commit(writes)) return true;
  }
  throw new Error('fin de copie: conflit persistant');
}

export type { Item };
