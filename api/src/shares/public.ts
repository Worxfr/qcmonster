// Routes PUBLIQUES du partage (S1 #34, design 4, 5 et 7): ouverture et signalement. Role `sharePublic`: GetItem, UpdateItem et PutItem sur `SHARE#*` SEULEMENT, jamais de Query.
// Reponse UNIQUE `404 lien_indisponible` pour tout lien inutilisable: interrupteur ferme, jeton mal forme, inconnu, expire, suspendu, plafond du jour. Un jeton inconnu n'ecrit RIEN.
// Jeton mal forme: 404 (contrat 1.12.0, description des deux routes), sans hachage ni acces a la table. 400 seulement pour un corps illisible, un jeton non textuel ou un motif hors liste.
import { z } from 'zod';
import { keys } from '../../../shared/ddb/keys.js';
import { SHARE_READS_PER_DAY, SHARE_REPORTS_TO_SUSPEND, SHARE_REPORT_REASONS, SHARE_REPORT_TTL_S, SHARE_TOKEN_RE, SHARE_TTL_GRACE_S } from '../../../shared/share-rules.js';
import type { Item } from '../pipeline/ports.js';
import { dayOf, hashToken, isExpired, lienIndisponible, type ShareCtx } from './ctx.js';

/** Corps: le jeton est une chaine (sa forme est controlee a part, pour repondre 404 et non 400). */
export const OpenBodySchema = z.object({ token: z.string() });
export const ReportBodySchema = z.object({ token: z.string(), reason: z.enum(SHARE_REPORT_REASONS) });

/** Copie figee lisible: existe, `actif`, pas echue, moins de 3 signalements. */
const usable = (m: Item | undefined, c: ShareCtx): m is Item => !!m && m.state === 'actif' && !isExpired(m, c) && Number(m.reports ?? 0) < SHARE_REPORTS_TO_SUSPEND;

/** Jeton -> hache, ou 404 (interrupteur ferme ou forme invalide) AVANT toute lecture. */
function hashOrGone(c: ShareCtx, token: string): string {
  if (!c.publicEnabled || !SHARE_TOKEN_RE.test(token)) throw lienIndisponible();
  return hashToken(token);
}

/** `POST /shares/open`. Lit `META` d'abord; le compteur du jour n'est ecrit que si `META` est ouvrable (condition `n < 1000`: sinon le meme 404). */
export async function openShare(c: ShareCtx, token: string) {
  const hash = hashOrGone(c, token);
  const m = await c.db.get(keys.share(hash));
  if (!usable(m, c)) throw lienIndisponible();
  const ttl = Math.floor(new Date(String(m.expiresAt)).getTime() / 1000) + SHARE_TTL_GRACE_S;
  const day = await c.db.update(keys.shareDay(hash, dayOf(c)), { add: { n: 1 }, set: { ttl }, cond: { lt: { n: SHARE_READS_PER_DAY } } });
  if (!day) throw lienIndisponible();
  // LISTE BLANCHE a la lecture aussi: meme si un element portait un champ en trop, il ne sort pas.
  const questions = (m.questions as Item[]).map((q) =>
    q.kind === 'qcm' ? { kind: 'qcm', prompt: q.prompt, choices: q.choices, answer: q.answer } : { kind: 'gap', prompt: q.prompt, expected: q.expected },
  );
  return { title: m.title, ...(typeof m.subject === 'string' ? { subject: m.subject } : {}), questions, expiresAt: m.expiresAt };
}

/** `POST /shares/report`: transaction (signalement + compteur, sous condition que la copie existe encore et soit active), puis suspension a 3. Aucun texte libre, aucune adresse. */
export async function reportShare(c: ShareCtx, token: string, reason: (typeof SHARE_REPORT_REASONS)[number]): Promise<void> {
  const hash = hashOrGone(c, token);
  const m = await c.db.get(keys.share(hash));
  if (!usable(m, c)) throw lienIndisponible();
  const at = c.now().toISOString();
  const ttl = Math.floor(c.now().getTime() / 1000) + SHARE_REPORT_TTL_S;
  const ok = await c.db.transact([
    { key: keys.share(hash), spec: { add: { reports: 1 }, cond: { exists: true, eq: { state: 'actif' } } } },
    { put: { ...keys.shareReport(hash, c.newId()), reason, at, ttl }, ifNotExists: true },
  ]);
  if (!ok) throw lienIndisponible();
  const after = await c.db.get(keys.share(hash));
  if (after && Number(after.reports ?? 0) >= SHARE_REPORTS_TO_SUSPEND) await c.db.update(keys.share(hash), { set: { state: 'suspendu' }, cond: { exists: true } });
}
