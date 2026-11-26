// Surnoms des eleves d'une famille (ID1, design 4.2): unicite par RESERVATION `NAME#<cle>` ecrite dans la meme ecriture que l'eleve.
// Le champ `v` de l'eleve ne suffit pas: chaque eleve est un element distinct, la condition de version de l'un ne voit pas l'ecriture de l'autre.
import { keys } from '../../../shared/ddb/keys.js';
import { nameKey } from '../../../shared/pseudo-rules.js';
import { displayNameOf } from '../game/access.js';
import type { Deps } from '../lib/deps.js';
import type { Write } from '../lib/store.js';

/**
 * Vrai si un AUTRE eleve de la famille porte deja ce surnom: par sa reservation, ou (anciens comptes sans reservation) par son surnom derive.
 * Ne regarde que la famille du jeton: aucune information sur les autres familles.
 */
export async function nameTakenByOther(deps: Deps, fid: string, sid: string, display: string): Promise<boolean> {
  const key = nameKey(display);
  const res = await deps.store.get(keys.name(fid, key));
  if (res && res.studentId !== sid) return true;
  const students = await deps.store.query(`FAMILY#${fid}`, 'STUDENT#');
  return students.some((s) => s.SK !== `STUDENT#${sid}` && nameKey(displayNameOf(s)) === key);
}

/**
 * Ecritures de reservation pour passer de `oldDisplay` a `newDisplay`: pose la nouvelle (`absent`: echoue si un autre la tient) et libere l'ancienne
 * seulement si elle est a cet eleve (un ancien compte n'en a pas, et ne doit jamais supprimer celle d'un frere). Vide si la cle ne change pas
 * (changement de casse ou d'accent): la reservation existante reste valable.
 */
export async function nameSwap(deps: Deps, fid: string, sid: string, oldDisplay: string | undefined, newDisplay: string): Promise<Write[]> {
  const newKey = nameKey(newDisplay);
  const oldKey = oldDisplay === undefined ? undefined : nameKey(oldDisplay);
  const mine = await deps.store.get(keys.name(fid, newKey));
  const out: Write[] = [];
  if (!(mine && mine.studentId === sid)) out.push({ item: { ...keys.name(fid, newKey), studentId: sid, creeLe: deps.now().toISOString() }, when: 'absent' });
  if (oldKey !== undefined && oldKey !== newKey) {
    const old = await deps.store.get(keys.name(fid, oldKey));
    if (old && old.studentId === sid) out.push({ item: { ...keys.name(fid, oldKey) }, when: 'any', remove: true });
  }
  return out;
}

/** La reservation de ce surnom est-elle tenue par un autre eleve? (apres l'echec d'une ecriture: nom pris, ou simple conflit de version) */
export async function reservedByOther(deps: Deps, fid: string, sid: string, display: string): Promise<boolean> {
  const r = await deps.store.get(keys.name(fid, nameKey(display)));
  return r !== undefined && r.studentId !== sid;
}
