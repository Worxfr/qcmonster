/**
 * Lien d'activation: /activer#token=<jeton>. Le jeton est lu une seule fois, puis retire de l'URL
 * (historique, signets, en-tete Referer) et gardé en mémoire seulement. Longueur bornée 20-200 comme le contrat; sinon lien « incomplet ». Jamais écrit dans un stockage ni journalisé.
 */
export const ACTIVATION_PATH = '/activer';
let taken: { token: string | null } | null = null;

export function isActivationRoute(): boolean {
  return taken !== null || window.location.pathname === ACTIVATION_PATH;
}

export function takeActivationToken(): string | null {
  if (taken) return taken.token;
  if (window.location.pathname !== ACTIVATION_PATH) return null;
  const m = /(?:^|[#&])token=([A-Za-z0-9._~-]{20,200})(?=&|$)/.exec(window.location.hash);
  taken = { token: m ? m[1] : null };
  window.history.replaceState(null, '', ACTIVATION_PATH);
  return taken.token;
}

/** Identifiant a pre-remplir sur l'ecran de connexion apres l'activation: en memoire seulement, lu une fois (jamais dans l'URL ni dans un stockage). */
let remembered: string | null = null;
export const rememberLoginId = (id: string): void => {
  remembered = id;
};
export const takeRememberedLoginId = (): string | null => {
  const id = remembered;
  remembered = null;
  return id;
};

/** Quitte l'écran d'activation vers la connexion. */
export function leaveActivation(): void {
  taken = null;
  window.history.replaceState(null, '', '/');
}
