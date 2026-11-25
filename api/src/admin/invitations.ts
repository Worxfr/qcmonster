// POST /admin/invitations: un administrateur (groupe Cognito `admin`) cree un code d'invitation parent.
// Le code n'existe en clair que dans la reponse: seul son hache est stocke, rien n'est journalise avec lui.
import { keys, sha256, type Key } from '../../../shared/ddb/keys.js';
import { inviteItem, newInviteCode } from '../../../shared/invite.js';
import { log } from '../../../shared/log/index.js';
import { HttpError } from '../lib/http.js';

/** Codes par jour (UTC) et par administrateur. */
export const DAILY_LIMIT = 20;
/** Les elements d'audit expirent (TTL DynamoDB) apres 1 an. */
const AUDIT_TTL_S = 365 * 24 * 3600;

/** Seule operation d'ecriture dont le role a besoin: PutItem conditionnel sur INVITE#*. */
export interface InviteDb {
  /** Ecrit l'element s'il n'existe pas; false s'il existait deja. */
  putNew<T extends Key>(item: T): Promise<boolean>;
}
export interface InviteDeps {
  db: InviteDb;
  now: () => Date;
  newCode?: () => string;
}
export interface CreatedInvitation {
  code: string;
  createdAt: string;
  remainingToday: number;
}

/** Auteur pseudonyme pour le journal: les 16 premiers caracteres du SHA-256 du `sub`. */
export const actorOf = (sub: string): string => sha256(sub).slice(0, 16);

/**
 * Limite de debit sans lecture ni compteur (le role n'a que PutItem): on reserve le premier emplacement libre
 * (N#01..N#20) du jour; chaque emplacement est aussi la ligne d'audit (qui, quand). Plein = refus.
 * shortcut: jusqu'a 20 ecritures conditionnelles par appel, acceptable pour un usage admin; passer a un compteur UpdateItem si le volume monte.
 */
async function reserveSlot(deps: InviteDeps, actor: string, at: Date): Promise<number> {
  const day = at.toISOString().slice(0, 10);
  for (let n = 1; n <= DAILY_LIMIT; n++) {
    const ok = await deps.db.putNew({
      ...keys.inviteAudit(actor, day, n),
      evenement: 'invitation_creee',
      actor,
      creeLe: at.toISOString(),
      ttl: Math.floor(at.getTime() / 1000) + AUDIT_TTL_S,
    });
    if (ok) return n;
  }
  throw new HttpError(429, 'quota_epuise', `Limite de ${DAILY_LIMIT} codes par jour atteinte`);
}

export async function createInvitation(deps: InviteDeps, admin: { sub: string }): Promise<CreatedInvitation> {
  const at = deps.now();
  const actor = actorOf(admin.sub);
  const slot = await reserveSlot(deps, actor, at);
  const code = (deps.newCode ?? newInviteCode)();
  if (!(await deps.db.putNew(inviteItem(code, at)))) throw new Error('collision'); // 128 bits: quasi impossible, 500 generique
  log({ step: 'admin-invitation', status: 'ok', audit: 'invitation_creee', actor });
  return { code, createdAt: at.toISOString(), remainingToday: DAILY_LIMIT - slot };
}
