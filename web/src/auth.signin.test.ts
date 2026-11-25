import { beforeEach, describe, expect, it, vi } from 'vitest';
import { CognitoIdToken, CognitoAccessToken, CognitoRefreshToken, CognitoUser, CognitoUserSession } from 'amazon-cognito-identity-js';

// Hors mode simule: la vraie bibliotheque Cognito est utilisee, seul l'appel reseau authenticateUser est remplace.
vi.mock('./env', () => ({ MOCK_AUTH: false, CONFIG_ERROR: null, COGNITO_POOL_ID: 'eu-west-3_x', COGNITO_CLIENT_ID: 'web', COGNITO_SIGNUP_CLIENT_ID: 'signup', SIGNUP_ENABLED: true }));
const jwt = (p: object) => `e30.${btoa(JSON.stringify(p)).replace(/=+$/, '')}.sig`;
const STRAY = 'CognitoIdentityServiceProvider.web.u1.idToken';

localStorage.setItem(STRAY, 'vieux-jeton'); // laisse par la version fautive, present avant le chargement du module
localStorage.setItem('CognitoIdentityServiceProvider.autre.u1.idToken', 'autre-client');
const auth = await import('./auth');
const afterLoad = { stray: localStorage.getItem(STRAY), other: localStorage.getItem('CognitoIdentityServiceProvider.autre.u1.idToken') }; // lu avant le nettoyage entre tests (setup.ts)

beforeEach(() => {
  sessionStorage.clear();
  vi.spyOn(CognitoUser.prototype, 'authenticateUser').mockImplementation(function (this: CognitoUser, _d: unknown, cb: { onSuccess: (s: unknown) => void }) {
    const now = Math.floor(Date.now() / 1000);
    const session = new CognitoUserSession({
      IdToken: new CognitoIdToken({ IdToken: jwt({ sub: 's', 'cognito:username': 'u1', exp: now + 3600, iat: now }) }),
      AccessToken: new CognitoAccessToken({ AccessToken: jwt({ sub: 's', username: 'u1', exp: now + 3600, iat: now }) }),
      RefreshToken: new CognitoRefreshToken({ RefreshToken: 'r' }),
    });
    (this as unknown as { signInUserSession: unknown }).signInUserSession = session;
    (this as unknown as { cacheTokens: () => void }).cacheTokens();
    cb.onSuccess(session);
  } as never);
});

describe('connexion', () => {
  it('apres signIn, isSignedIn() voit l\'utilisateur et aucun jeton n\'est dans localStorage', async () => {
    expect(auth.isSignedIn()).toBe(false);
    await expect(auth.signIn('u1', 'x')).resolves.toEqual({ kind: 'ok' });
    expect(auth.isSignedIn()).toBe(true);
    expect(Object.keys(localStorage).filter((k) => k.includes('u1') && k !== STRAY && !k.includes('autre'))).toEqual([]);
    expect(sessionStorage.getItem('CognitoIdentityServiceProvider.web.u1.idToken')).toBeTruthy();
  });
  it('les jetons laisses en localStorage par la version fautive sont effaces au chargement; les autres cles restent', () => {
    expect(afterLoad).toEqual({ stray: null, other: 'autre-client' });
  });
  it('signOut efface aussi les jetons de localStorage', () => {
    localStorage.setItem(STRAY, 'x');
    auth.signOut();
    expect(localStorage.getItem(STRAY)).toBeNull();
  });
});
