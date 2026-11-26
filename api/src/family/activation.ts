// Jeton d'activation (design-v2 4.8): aleatoire (256 bits), valable 24 h, a usage unique. Seul le hache SHA-256 est stocke (ACTIVATION#<hache>).
import { timingSafeEqual } from 'node:crypto';
import { keys, sha256, type Key } from '../../../shared/ddb/keys.js';
import type { Deps } from '../lib/deps.js';
import { checkNickname, nameKey } from '../../../shared/pseudo-rules.js';
import { displayNameOf, loginIdOf } from '../game/access.js';
import { badRequest, conflict, notFound, pseudoPris, pseudoRefuse } from '../lib/http.js';
import { nameSwap, nameTakenByOther, reservedByOther } from './names.js';
import { InvalidPasswordError, UserGoneError, type Identity } from '../lib/identity.js';
import type { Item, Write } from '../lib/store.js';

export const ACTIVATION_TTL_MS = 24 * 3600 * 1000;

export interface Issued {
  hash: string;
  url: string;
  expiresAt: string;
  write: Write;
}

/** Prepare un nouveau jeton: l'ecriture ACTIVATION#<hache> (a faire dans la meme transaction que l'eleve) et le lien. Le jeton en clair ne sort que dans `url`. */
export function issueActivation(deps: Deps, webOrigin: string, fid: string, sid: string): Issued {
  if (!webOrigin) throw new Error('WEB_ORIGIN manquant');
  const token = deps.newToken();
  const hash = sha256(token);
  const expires = deps.now().getTime() + ACTIVATION_TTL_MS;
  return {
    hash,
    // Le jeton est dans le fragment (#): il n'est jamais envoye au serveur du front ni journalise.
    url: `${webOrigin}/activer#token=${token}`,
    expiresAt: new Date(expires).toISOString(),
    write: { item: { ...keys.activation(token), hash, sid, fid, expiresAt: new Date(expires).toISOString(), creeLe: deps.now().toISOString(), ttl: Math.floor(expires / 1000) }, when: 'absent' },
  };
}

// La cle de lecture est deja le hache du jeton fourni: cette comparaison en temps constant est une garde en plus (element corrompu), pas la protection.
// La protection reelle est le hachage SHA-256 d'un jeton aleatoire de 256 bits.
const sameHash = (stored: unknown, hash: string): boolean => typeof stored === 'string' && stored.length === hash.length && timingSafeEqual(Buffer.from(stored), Buffer.from(hash));

/**
 * POST /activation (route publique). Jeton inconnu, expire, deja utilise ou remplace: la MEME reponse 404.
 * Le jeton est reserve de facon atomique (ecriture conditionnelle a la version) avant de poser le mot de passe; si la politique de mot
 * de passe du pool refuse, il est libere (400) pour que l'eleve puisse reessayer avec un autre mot de passe.
 */
export interface ActivationResult {
  loginId: string;
  displayName: string;
  /** Le surnom demande est devenu indisponible apres le mot de passe: on a garde le surnom de depart. */
  displayNameChanged?: true;
}

export async function activate(deps: Deps, identity: Identity, body: { token: string; password: string; displayName?: string }): Promise<ActivationResult> {
  const hash = sha256(body.token);
  const key: Key = { PK: `ACTIVATION#${hash}`, SK: 'META' };
  const it = await deps.store.get(key);
  const live = it && sameHash(it.hash, hash) && typeof it.expiresAt === 'string' && Date.parse(it.expiresAt) > deps.now().getTime() && it.usedAt === undefined;
  if (!it || !live) throw notFound();
  // Surnom: controle AVANT de consommer le jeton (refus ou deja pris: l'eleve corrige et reessaie avec le meme lien). Jeton valide seulement: pas d'oracle pour un inconnu.
  let chosen: string | undefined;
  if (body.displayName !== undefined) {
    const nick = checkNickname(body.displayName);
    if (!nick.ok) throw pseudoRefuse();
    chosen = nick.value;
    if (await nameTakenByOther(deps, String(it.fid), String(it.sid), chosen)) throw pseudoPris();
  }
  const claimed = await deps.store.commit([{ item: { ...it, usedAt: deps.now().toISOString() }, when: it.v ?? 'any' }]);
  if (!claimed) throw notFound();
  const release = async () => {
    const original: Item = { ...it };
    delete original.v;
    await deps.store.commit([{ item: original, when: (it.v ?? 0) + 1 }]);
  };

  const sid = String(it.sid);
  const fid = String(it.fid);
  const student = await deps.store.get(keys.student(fid, sid));
  if (!student || student.activationHash !== hash) {
    await deps.store.remove(key); // eleve supprime ou jeton remplace par un lien plus recent
    throw notFound();
  }
  try {
    await identity.setPassword(sid, body.password);
  } catch (e) {
    await release();
    if (e instanceof InvalidPasswordError) throw badRequest('Mot de passe refusé : 12 caractères, avec majuscule, minuscule et chiffre');
    if (e instanceof UserGoneError) {
      await deps.store.remove(key); // utilisateur supprime cote Cognito seulement: meme 404 que tout jeton inutilisable
      throw notFound();
    }
    throw e;
  }
  await deps.store.remove(key);
  // Le mot de passe est pose, le compte est actif: plus d'erreur a renvoyer apres ce point. On CONTROLE le resultat de l'ecriture finale (eleve + reservation
  // du surnom): conflit de version (le parent change le niveau au meme instant) = relecture et nouvel essai; surnom pris entre-temps = surnom de depart.
  let changed = false;
  let cur = student;
  for (let attempt = 0; attempt < 5; attempt++) {
    const next: Item = { ...cur };
    delete next.activationHash;
    const writes: Write[] = [{ item: next, when: cur.v ?? 'any' }];
    if (chosen !== undefined && nameKey(chosen) !== nameKey(displayNameOf(cur))) {
      next.displayName = chosen;
      writes.push(...(await nameSwap(deps, fid, sid, displayNameOf(cur), chosen)));
    } else if (chosen !== undefined) next.displayName = chosen; // meme cle (casse, accent): la reservation existante reste valable
    if (await deps.store.commit(writes)) return { loginId: loginIdOf(next), displayName: displayNameOf(next), ...(changed ? { displayNameChanged: true as const } : {}) };
    if (chosen !== undefined && (await reservedByOther(deps, fid, sid, chosen))) {
      chosen = undefined; // pris entre-temps: on garde le surnom de depart, que cet eleve tient deja
      changed = true;
    }
    const again = await deps.store.get(keys.student(fid, sid));
    if (!again) throw notFound(); // eleve supprime pendant l'activation
    cur = again;
  }
  throw conflict('Réessaie'); // conflit persistant: tres improbable; le compte est actif, le parent peut redonner un lien
}
