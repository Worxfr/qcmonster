import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hors mode simule: les erreurs Cognito sont traduites en messages génériques, et la requête porte le code d'invitation.
vi.mock('./env', () => ({ MOCK_AUTH: false, CONFIG_ERROR: null, COGNITO_POOL_ID: 'eu-west-3_x', COGNITO_CLIENT_ID: 'web', COGNITO_SIGNUP_CLIENT_ID: 'signup', SIGNUP_ENABLED: true }));
const state: { err: { code: string } | null; meta?: unknown; username?: string; clientId?: string } = { err: null };
vi.mock('amazon-cognito-identity-js', () => ({
  CognitoUserPool: class { constructor(o: { ClientId: string }) { state.clientId = o.ClientId; } signUp(u: string, _p: string, _a: unknown, _v: unknown, cb: (e: unknown) => void, meta: unknown) { state.username = u; state.meta = meta; cb(state.err); } },
  CognitoUser: class { confirmRegistration(_c: string, _f: boolean, cb: (e: unknown) => void) { cb(state.err); } forgotPassword(cbs: { onFailure: (e: unknown) => void; onSuccess: (d: unknown) => void }) { if (state.err) cbs.onFailure(state.err); else cbs.onSuccess({}); } confirmPassword(_c: string, _p: string, cbs: { onFailure: (e: unknown) => void; onSuccess: (d: string) => void }) { if (state.err) cbs.onFailure(state.err); else cbs.onSuccess('ok'); } },
  CognitoUserAttribute: class { constructor(public o: unknown) {} },
  AuthenticationDetails: class {},
}));
const auth = await import('./auth');

beforeEach(() => { state.err = null; state.meta = undefined; sessionStorage.clear(); });

describe('inscription (client -signup)', () => {
  it("envoie le code d'invitation en clientMetadata avec le client -signup et un identifiant interne qui n'est pas un e-mail", async () => {
    const u = await auth.signUpParent('a@example.org', 'Motdepasse12', 'c'.repeat(32));
    expect(state.clientId).toBe('signup');
    expect(state.meta).toEqual({ inviteCode: 'c'.repeat(32) });
    expect(u).toMatch(/^p[0-9a-f]{20}$/);
    expect(auth.pendingSignup()).toBe(u);
  });
  it("traduit chaque erreur d'inscription en message précis, sans message brut de Cognito", async () => {
    const run = (e: object) => { state.err = e as { code: string }; return auth.signUpParent('a@example.org', 'Motdepasse12', 'c'.repeat(32)); };
    await expect(run({ code: 'UserLambdaValidationException', message: 'PreSignUp failed with error invitation_invalide.' })).rejects.toThrow("Ce code d'invitation est invalide ou déjà utilisé");
    await expect(run({ code: 'UserLambdaValidationException', message: 'PreSignUp failed with error AccessDeniedException: arn:x' })).rejects.toThrow("pas disponible");
    await expect(run({ code: 'NotAuthorizedException', message: 'SignUp is not permitted for this user pool' })).rejects.toThrow("pas disponible");
    await expect(run({ code: 'UnexpectedLambdaException' })).rejects.toThrow("pas disponible");
    await expect(run({ code: 'InvalidPasswordException' })).rejects.toThrow(/Mot de passe refusé/);
    await expect(run({ code: 'InvalidParameterException', message: 'Password did not conform with policy' })).rejects.toThrow(/Mot de passe refusé/);
    await expect(run({ code: 'UsernameExistsException' })).rejects.toThrow(/déjà utilisée/);
    await expect(run({ code: 'TooManyRequestsException' })).rejects.toThrow(/Trop d'essais/);
    await expect(run({ code: 'NetworkError', message: 'Network error' })).rejects.toThrow(/connexion/i);
    await expect(run({ code: 'InvalidParameterException', message: 'autre' })).rejects.toThrow(/Ça n'a pas marché/);
    expect(auth.pendingSignup()).toBeNull();
  });
  it('confirmation: e-mail déjà pris par un autre compte, code faux, erreur inconnue', async () => {
    state.err = { code: 'CodeMismatchException' };
    await expect(auth.confirmSignUpParent('p1', '000000')).rejects.toThrow('Code incorrect ou expiré.');
    state.err = { code: 'AliasExistsException' };
    await expect(auth.confirmSignUpParent('p1', '000000')).rejects.toThrow(/déjà utilisée/);
    state.err = { code: 'Autre' };
    await expect(auth.confirmSignUpParent('p1', '000000')).rejects.toThrow(/Ça n'a pas marché/);
  });
  it('mot de passe oublié: un compte inconnu ou non vérifié répond comme un succès', async () => {
    state.err = { code: 'UserNotFoundException' };
    await expect(auth.requestPasswordReset('x@example.org')).resolves.toBeUndefined();
    state.err = { code: 'LimitExceededException' };
    await expect(auth.requestPasswordReset('x@example.org')).rejects.toThrow(/Trop d'essais/);
  });
});
