// Port Cognito (administration des comptes). L'identifiant du pool vient de l'environnement (valeur lue dans SSM par CDK).
import {
  AdminAddUserToGroupCommand,
  AdminCreateUserCommand,
  AdminDeleteUserCommand,
  AdminDisableUserCommand,
  AdminEnableUserCommand,
  AdminGetUserCommand,
  AdminSetUserPasswordCommand,
  AdminUpdateUserAttributesCommand,
  AdminUserGlobalSignOutCommand,
  CognitoIdentityProviderClient,
} from '@aws-sdk/client-cognito-identity-provider';

export class InvalidPasswordError extends Error {}
export class AliasTakenError extends Error {}

export interface Identity {
  /** Cree l'eleve (groupe `eleve`, `famille_id`), sans message. Le nom d'utilisateur est `studentId`. Renvoie le `sub`. */
  createStudent(a: { studentId: string; familyId: string; alias: string }): Promise<{ sub: string }>;
  /** Mot de passe permanent choisi par l'eleve. Leve InvalidPasswordError si la politique du pool le refuse. */
  setPassword(username: string, password: string): Promise<void>;
  /** Parent: pose `famille_id` et le groupe `parent`. Renvoie false si le compte a deja une famille. */
  attachFamily(username: string, familyId: string): Promise<boolean>;
  setEnabled(username: string, enabled: boolean): Promise<void>;
  /** Supprime l'utilisateur; absent = deja supprime (idempotent). */
  deleteUser(username: string): Promise<void>;
}

const name = (e: unknown) => (e as { name?: string }).name;

export function cognitoIdentity(userPoolId: string, client: CognitoIdentityProviderClient = new CognitoIdentityProviderClient({})): Identity {
  return {
    async createStudent({ studentId, familyId, alias }) {
      try {
        const r = await client.send(
          new AdminCreateUserCommand({
            UserPoolId: userPoolId,
            Username: studentId,
            MessageAction: 'SUPPRESS', // aucun e-mail: le lien d'activation est montre au parent
            UserAttributes: [
              { Name: 'custom:famille_id', Value: familyId },
              { Name: 'preferred_username', Value: alias },
              // Le pool exige un e-mail (attribut requis, non modifiable apres creation du pool): valeur factice, jamais verifiee, jamais utilisee.
              { Name: 'email', Value: `${studentId}@eleve.invalid` },
            ],
          }),
        );
        await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: studentId, GroupName: 'eleve' }));
        const sub = r.User?.Attributes?.find((a) => a.Name === 'sub')?.Value;
        if (!sub) throw new Error('sub absent');
        return { sub };
      } catch (e) {
        if (name(e) === 'AliasExistsException') throw new AliasTakenError();
        throw e;
      }
    },
    async setPassword(username, password) {
      try {
        await client.send(new AdminSetUserPasswordCommand({ UserPoolId: userPoolId, Username: username, Password: password, Permanent: true }));
      } catch (e) {
        if (name(e) === 'InvalidPasswordException') throw new InvalidPasswordError();
        throw e;
      }
    },
    async attachFamily(username, familyId) {
      const u = await client.send(new AdminGetUserCommand({ UserPoolId: userPoolId, Username: username }));
      if (u.UserAttributes?.some((a) => a.Name === 'custom:famille_id' && a.Value)) return false;
      await client.send(new AdminUpdateUserAttributesCommand({ UserPoolId: userPoolId, Username: username, UserAttributes: [{ Name: 'custom:famille_id', Value: familyId }] }));
      await client.send(new AdminAddUserToGroupCommand({ UserPoolId: userPoolId, Username: username, GroupName: 'parent' }));
      return true;
    },
    async setEnabled(username, enabled) {
      if (enabled) await client.send(new AdminEnableUserCommand({ UserPoolId: userPoolId, Username: username }));
      else {
        await client.send(new AdminDisableUserCommand({ UserPoolId: userPoolId, Username: username }));
        await client.send(new AdminUserGlobalSignOutCommand({ UserPoolId: userPoolId, Username: username })); // revoque les jetons de rafraichissement
      }
    },
    async deleteUser(username) {
      try {
        await client.send(new AdminDeleteUserCommand({ UserPoolId: userPoolId, Username: username }));
      } catch (e) {
        if (name(e) !== 'UserNotFoundException') throw e;
      }
    },
  };
}

/** Faux Cognito pour les tests. */
export function memoryIdentity(): Identity & {
  users: Map<string, { sub: string; familyId?: string; alias?: string; enabled: boolean; password?: string; groups: string[] }>;
  failPasswordPolicy: boolean;
  failCreate: number;
} {
  const users = new Map<string, { sub: string; familyId?: string; alias?: string; enabled: boolean; password?: string; groups: string[] }>();
  const self = {
    users,
    failPasswordPolicy: false,
    failCreate: 0,
    async createStudent(a: { studentId: string; familyId: string; alias: string }) {
      await Promise.resolve();
      if (self.failCreate > 0) {
        self.failCreate--;
        throw new AliasTakenError();
      }
      const sub = `sub-${a.studentId}`;
      users.set(a.studentId, { sub, familyId: a.familyId, alias: a.alias, enabled: true, groups: ['eleve'] });
      return { sub };
    },
    async setPassword(username: string, password: string) {
      await Promise.resolve();
      if (self.failPasswordPolicy) throw new InvalidPasswordError();
      const u = users.get(username);
      if (!u) throw new Error('UserNotFound');
      u.password = password;
    },
    async attachFamily(username: string, familyId: string) {
      await Promise.resolve();
      const u = users.get(username) ?? { sub: `sub-${username}`, enabled: true, groups: [] };
      users.set(username, u);
      if (u.familyId) return false;
      u.familyId = familyId;
      u.groups.push('parent');
      return true;
    },
    async setEnabled(username: string, enabled: boolean) {
      await Promise.resolve();
      const u = users.get(username);
      if (u) u.enabled = enabled;
    },
    async deleteUser(username: string) {
      await Promise.resolve();
      users.delete(username);
    },
  };
  return self;
}
