import { describe, expect, it } from 'vitest';
import type { PreSignUpTriggerEvent } from 'aws-lambda';
import { createHash } from 'node:crypto';
import { checkInvite } from './pre-signup.js';

const ev = (triggerSource: string, inviteCode?: string) =>
  ({ triggerSource, request: { userAttributes: {}, clientMetadata: inviteCode ? { inviteCode } : undefined }, response: {} }) as unknown as PreSignUpTriggerEvent;
const CODE = 'a1b2c3d4e5f6a7b8c9d0';

describe('PreSignUp: invitation obligatoire', () => {
  it('accepte une invitation valide, consommee par son hache SHA-256', async () => {
    const seen: string[] = [];
    await checkInvite(ev('PreSignUp_SignUp', CODE), 't', async (_t, h) => (seen.push(h), true));
    expect(seen).toEqual([createHash('sha256').update(CODE).digest('hex')]);
  });
  it('refuse sans code, avec un code trop court, ou deja utilise', async () => {
    const never = async () => true;
    await expect(checkInvite(ev('PreSignUp_SignUp'), 't', never)).rejects.toThrow('invitation_invalide');
    await expect(checkInvite(ev('PreSignUp_SignUp', 'court'), 't', never)).rejects.toThrow('invitation_invalide');
    await expect(checkInvite(ev('PreSignUp_SignUp', CODE), 't', async () => false)).rejects.toThrow('invitation_invalide');
  });
  it('laisse passer la creation d\'un eleve par le serveur, refuse le federe', async () => {
    const never = async () => { throw new Error('ne doit pas etre appele'); };
    await expect(checkInvite(ev('PreSignUp_AdminCreateUser'), 't', never)).resolves.toBeTruthy();
    await expect(checkInvite(ev('PreSignUp_ExternalProvider', CODE), 't', never)).rejects.toThrow('inscription_refusee');
  });
});
