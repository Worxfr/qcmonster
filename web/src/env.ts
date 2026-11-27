// Configuration lue a la compilation (VITE_*). Aucune valeur secrete: le client Cognito est public.
const e = import.meta.env;
export const API_URL: string = (e.VITE_API_URL as string | undefined) ?? (e.PROD ? '' : 'http://localhost:4010');
export const COGNITO_CLIENT_ID: string = (e.VITE_COGNITO_CLIENT_ID as string | undefined) ?? '';
export const COGNITO_SIGNUP_CLIENT_ID: string = (e.VITE_COGNITO_SIGNUP_CLIENT_ID as string | undefined) ?? '';
export const COGNITO_POOL_ID: string = (e.VITE_COGNITO_POOL_ID as string | undefined) ?? '';
// Mock: uniquement si demande explicitement (VITE_AUTH_MODE=mock, voir .env.development) ET hors build de production.
export const MOCK_AUTH: boolean = e.VITE_AUTH_MODE === 'mock' && !e.PROD;
// Une configuration incomplete doit se voir, jamais retomber sur le mock.
export const CONFIG_ERROR: string | null =
  !API_URL ? 'Configuration manquante : VITE_API_URL.' : !MOCK_AUTH && (!COGNITO_CLIENT_ID || !COGNITO_POOL_ID) ? 'Configuration manquante : VITE_COGNITO_POOL_ID et VITE_COGNITO_CLIENT_ID.' : null;
// Inscription et recuperation du mot de passe: client Cognito -signup (public, SignUp/ConfirmSignUp/ForgotPassword seulement). Absent = fonction masquee.
export const SIGNUP_ENABLED: boolean = MOCK_AUTH || (!CONFIG_ERROR && !!COGNITO_SIGNUP_CLIENT_ID);

/** M1 #90: ecran « Modifier ce cours ». Ferme par defaut, comme `REVISE_ENABLED` cote serveur; a ouvrir ensemble (VITE_REVISE_ENABLED=true). */
export const REVISE_ENABLED: boolean = e.VITE_REVISE_ENABLED === 'true';

/** S1 #34: partage de QCM par lien (bouton, ecrans, page publique /p). Ferme par defaut, comme `SHARE_PUBLIC_ENABLED` cote serveur; a ouvrir ensemble (VITE_SHARE_ENABLED=true). */
export const SHARE_ENABLED: boolean = e.VITE_SHARE_ENABLED === 'true';
