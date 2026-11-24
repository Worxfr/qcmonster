// Configuration lue a la compilation (VITE_*). Aucune valeur secrete: le client Cognito est public.
const e = import.meta.env;
export const API_URL: string = (e.VITE_API_URL as string | undefined) ?? 'http://localhost:4010';
export const COGNITO_CLIENT_ID: string = (e.VITE_COGNITO_CLIENT_ID as string | undefined) ?? '';
export const COGNITO_POOL_ID: string = (e.VITE_COGNITO_POOL_ID as string | undefined) ?? '';
// Mode mock: explicite, ou par defaut quand Cognito n'est pas configure (developpement contre `npm run mock`).
export const MOCK_AUTH: boolean = e.VITE_AUTH_MODE === 'mock' || !COGNITO_CLIENT_ID || !COGNITO_POOL_ID;
