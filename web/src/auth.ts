import { AuthenticationDetails, CognitoUser, CognitoUserAttribute, CognitoUserPool, type CognitoRefreshToken } from 'amazon-cognito-identity-js';
import { CONFIG_ERROR, COGNITO_CLIENT_ID, COGNITO_SIGNUP_CLIENT_ID, COGNITO_POOL_ID, MOCK_AUTH } from './env';

export type MockRole = 'parent' | 'eleve';
export type SignInResult = { kind: 'ok' } | { kind: 'mfa'; confirm: (code: string) => Promise<void> };

const ROLE_KEY = 'qcm.mockRole';
const SIGNED_OUT = new EventTarget();
export const onSignedOut = (fn: () => void) => {
  SIGNED_OUT.addEventListener('out', fn);
  return () => SIGNED_OUT.removeEventListener('out', fn);
};

let pool: CognitoUserPool | undefined;
// Jetons dans sessionStorage (perdus a la fermeture de l'onglet), pas dans localStorage.
const getPool = () => (pool ??= new CognitoUserPool({ UserPoolId: COGNITO_POOL_ID, ClientId: COGNITO_CLIENT_ID, Storage: window.sessionStorage }));

/** Mode mock: le role est choisi sur l'ecran de connexion (l'API simulee renvoie toujours le meme profil). */
export function mockRole(): MockRole | null {
  const r = sessionStorage.getItem(ROLE_KEY);
  return r === 'parent' || r === 'eleve' ? r : null;
}
export function mockSignIn(role: MockRole) {
  sessionStorage.setItem(ROLE_KEY, role);
}

const ADMIN_KEY = 'qcm.mockAdmin';
/** Mode mock: connexion comme administrateur (en plus de parent). */
export function mockAdminSignIn() {
  mockSignIn('parent');
  sessionStorage.setItem(ADMIN_KEY, '1');
}

/** Groupes Cognito du jeton d'identite (affichage seulement: le serveur controle l'acces). */
export async function getGroups(): Promise<string[]> {
  if (MOCK_AUTH) return sessionStorage.getItem(ADMIN_KEY) === '1' ? ['admin'] : [];
  const part = (await getToken()).split('.')[1];
  if (!part) return [];
  const claims = JSON.parse(new TextDecoder().decode(Uint8Array.from(atob(part.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0)))) as { 'cognito:groups'?: unknown };
  const g = claims['cognito:groups'];
  return Array.isArray(g) ? g.map(String) : [];
}

export function isSignedIn(): boolean {
  if (CONFIG_ERROR) return false;
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

/**
 * Force le renouvellement des jetons avec le jeton de rafraichissement. Apres POST /family, le jeton deja emis ne contient
 * ni groupe ni famille_id: sans cela le parent devrait se reconnecter. Rejette si le rafraichissement echoue.
 */
export function refreshSession(): Promise<void> {
  if (MOCK_AUTH) return Promise.resolve();
  const user = getPool().getCurrentUser();
  if (!user) return Promise.reject(new Error('non connecte'));
  return new Promise((resolve, reject) => {
    user.getSession((err: Error | null, s: { getRefreshToken(): CognitoRefreshToken } | null) => {
      if (err || !s) return reject(err ?? new Error('session absente'));
      user.refreshSession(s.getRefreshToken(), (e: Error | null) => (e ? reject(e) : resolve()));
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

// --- Inscription du parent et mot de passe oublie (client -signup, sans secret, sans flux de connexion) ---
// Les messages ne disent jamais si un compte existe, ni pourquoi un code d'invitation est refuse (« invalide ou expire »).
export class AuthFlowError extends Error {}
const fail = (m: string) => new AuthFlowError(m);
const codeOf = (e: unknown) => (e as { code?: string; name?: string } | null)?.code ?? (e as { name?: string } | null)?.name ?? '';
const GENERIC = "Ça n'a pas marché. Vérifie ce que tu as écrit et réessaie dans un instant.";
const WAIT = 'Trop d\'essais. Attends quelques minutes avant de réessayer.';
const BAD_CODE = 'Code incorrect ou expiré.';
const BAD_PASSWORD = 'Mot de passe refusé : 12 caractères ou plus, avec une majuscule, une minuscule et un chiffre.';
const MOCK_CODE = '123456';
const MOCK_BAD_INVITE = 'invalide'; // mock: tout code commencant ainsi est refuse

let signupPool: CognitoUserPool | undefined;
const getSignupPool = () => (signupPool ??= new CognitoUserPool({ UserPoolId: COGNITO_POOL_ID, ClientId: COGNITO_SIGNUP_CLIENT_ID, Storage: window.sessionStorage }));
const signupUser = (username: string) => new CognitoUser({ Username: username, Pool: getSignupPool(), Storage: window.sessionStorage });

const PENDING_KEY = 'qcm.pendingSignup';
/** Identifiant technique du compte en attente de confirmation (pas un secret, ni l'e-mail): permet de reprendre apres un rechargement. */
export const pendingSignup = (): string | null => sessionStorage.getItem(PENDING_KEY);
export const clearPendingSignup = () => sessionStorage.removeItem(PENDING_KEY);

/** Identifiant interne aleatoire: l'e-mail sert a se connecter (alias), le pool interdit un identifiant au format e-mail. */
function newUsername(): string {
  const b = crypto.getRandomValues(new Uint8Array(10));
  return 'p' + Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

/** Cree le compte parent. Renvoie l'identifiant interne a garder pour la confirmation. */
export async function signUpParent(email: string, password: string, inviteCode: string): Promise<string> {
  const username = newUsername();
  if (MOCK_AUTH) {
    if (inviteCode.startsWith(MOCK_BAD_INVITE)) throw fail("Code d'invitation invalide ou expiré.");
  } else {
    await new Promise<void>((resolve, reject) => {
      getSignupPool().signUp(username, password, [new CognitoUserAttribute({ Name: 'email', Value: email })], [], (err) => (err ? reject(err) : resolve()), { inviteCode });
    }).catch((e) => {
      const c = codeOf(e);
      if (c === 'UserLambdaValidationException' || c === 'UnexpectedLambdaException') throw fail("Code d'invitation invalide ou expiré.");
      if (c === 'InvalidPasswordException') throw fail(BAD_PASSWORD);
      if (c === 'TooManyRequestsException' || c === 'LimitExceededException') throw fail(WAIT);
      throw fail(GENERIC);
    });
  }
  sessionStorage.setItem(PENDING_KEY, username);
  return username;
}

export async function confirmSignUpParent(username: string, code: string): Promise<void> {
  if (MOCK_AUTH) {
    if (code !== MOCK_CODE) throw fail(BAD_CODE);
  } else {
    await new Promise<void>((resolve, reject) => {
      signupUser(username).confirmRegistration(code, false, (err) => (err ? reject(err) : resolve()));
    }).catch((e) => {
      const c = codeOf(e);
      if (c === 'CodeMismatchException' || c === 'ExpiredCodeException') throw fail(BAD_CODE);
      if (c === 'TooManyRequestsException' || c === 'LimitExceededException' || c === 'TooManyFailedAttemptsException') throw fail(WAIT);
      throw fail(GENERIC);
    });
  }
  clearPendingSignup();
}

export async function resendSignUpCode(username: string): Promise<void> {
  if (MOCK_AUTH) return;
  await new Promise<void>((resolve, reject) => {
    signupUser(username).resendConfirmationCode((err) => (err ? reject(err) : resolve()));
  }).catch((e) => {
    const c = codeOf(e);
    throw fail(c === 'TooManyRequestsException' || c === 'LimitExceededException' ? WAIT : GENERIC);
  });
}

/** Demande un code par e-mail. Reussit toujours en apparence (compte inconnu, e-mail non verifie): seule la limite d'essais est dite. */
export async function requestPasswordReset(email: string): Promise<void> {
  if (MOCK_AUTH) return;
  await new Promise<void>((resolve, reject) => {
    signupUser(email).forgotPassword({ onSuccess: () => resolve(), onFailure: reject, inputVerificationCode: () => resolve() });
  }).catch((e) => {
    const c = codeOf(e);
    if (c === 'TooManyRequestsException' || c === 'LimitExceededException') throw fail(WAIT);
    // tout le reste (compte inconnu, e-mail non verifie, eleve sans e-mail): meme reponse qu'un succes
  });
}

export async function resetPassword(email: string, code: string, password: string): Promise<void> {
  if (MOCK_AUTH) {
    if (code !== MOCK_CODE) throw fail(BAD_CODE);
    return;
  }
  await new Promise<void>((resolve, reject) => {
    signupUser(email).confirmPassword(code, password, { onSuccess: () => resolve(), onFailure: reject });
  }).catch((e) => {
    const c = codeOf(e);
    if (c === 'InvalidPasswordException') throw fail(BAD_PASSWORD);
    if (c === 'TooManyRequestsException' || c === 'LimitExceededException' || c === 'TooManyFailedAttemptsException') throw fail(WAIT);
    throw fail(BAD_CODE); // code faux, expire ou compte inconnu: meme message
  });
}
