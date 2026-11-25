// Code d'invitation parent (design-v2 4.7): partage par scripts/create-invite.ts et la route POST /admin/invitations.
// Seul le HACHE SHA-256 du code va dans DynamoDB (cle INVITE#<hache>); le code en clair n'est ni stocke ni journalise.
import { randomBytes } from 'node:crypto';
import { keys, type Key } from './ddb/keys.js';

/** 128 bits, 32 caracteres hexadecimaux. */
export const newInviteCode = (): string => randomBytes(16).toString('hex');

/** Element a ecrire (condition: attribute_not_exists(PK)). Aucun champ ne permet de retrouver le code. */
export function inviteItem(code: string, now: Date = new Date()): Key & { utilisee: false; creeLe: string } {
  return { ...keys.invite(code), utilisee: false, creeLe: now.toISOString() };
}
