import { AuthenticationDetails, CognitoUser, CognitoUserPool } from 'amazon-cognito-identity-js';
import { COGNITO_CLIENT_ID, COGNITO_POOL_ID, MOCK_AUTH } from './env';

export type MockRole = 'parent' | 'eleve';
export type SignInResult = { kind: 'ok' } | { kind: 'mfa'; confirm: (code: string) => Promise<void> };

const ROLE_KEY = 'qcm.mockRole';
const SIGNED_OUT = new EventTarget();
export const onSignedOut = (fn: () => void) => {
  SIGNED_OUT.addEventListener('out', fn);
  return () => SIGNED_OUT.removeEventListener('out', fn);
};

let pool: CognitoUserPool | undefined;
const getPool = () => (pool ??= new CognitoUserPool({ UserPoolId: COGNITO_POOL_ID, ClientId: COGNITO_CLIENT_ID }));

/** Mode mock: le role est choisi sur l'ecran de connexion (l'API simulee renvoie toujours le meme profil). */
export function mockRole(): MockRole | null {
  const r = sessionStorage.getItem(ROLE_KEY);
  return r === 'parent' || r === 'eleve' ? r : null;
}
export function mockSignIn(role: MockRole) {
  sessionStorage.setItem(ROLE_KEY, role);
}

export function isSignedIn(): boolean {
  return MOCK_AUTH ? mockRole() !== null : getPool().getCurrentUser() !== null;
}

export function getToken(): Promise<string> {
  if (MOCK_AUTH) return Promise.resolve('mock-token');
  const user = getPool().getCurrentUser();
  if (!user) return Promise.reject(new Error('non connecte'));
  return new Promise((resolve, reject) => {
    // getSession renouvelle le jeton d'acces avec le jeton de rafraichissement si besoin.
    user.getSession((err: Error | null, s: { getIdToken(): { getJwtToken(): string } } | null) => {
      if (err || !s) reject(err ?? new Error('session absente'));
      else resolve(s.getIdToken().getJwtToken());
    });
  });
}

export function signIn(username: string, password: string): Promise<SignInResult> {
  const user = new CognitoUser({ Username: username, Pool: getPool() });
  const details = new AuthenticationDetails({ Username: username, Password: password });
  return new Promise((resolve, reject) => {
    user.authenticateUser(details, {
      onSuccess: () => resolve({ kind: 'ok' }),
      onFailure: reject,
      totpRequired: () =>
        resolve({
          kind: 'mfa',
          confirm: (code) =>
            new Promise<void>((res, rej) => {
              user.sendMFACode(code, { onSuccess: () => res(), onFailure: rej }, 'SOFTWARE_TOKEN_MFA');
            }),
        }),
      mfaRequired: () => reject(new Error('Methode MFA non prise en charge')),
      newPasswordRequired: () => reject(new Error('Mot de passe a definir via le lien d\'activation')),
    });
  });
}

export function signOut(): void {
  if (MOCK_AUTH) sessionStorage.removeItem(ROLE_KEY);
  else getPool().getCurrentUser()?.signOut();
  SIGNED_OUT.dispatchEvent(new Event('out'));
}
