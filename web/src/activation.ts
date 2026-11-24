/**
 * Lien d'activation: /activer#token=<jeton>. Le jeton est lu une seule fois, puis retire de l'URL
 * (historique, signets, en-tete Referer) et gardé en mémoire seulement. Jamais écrit dans un stockage ni journalisé.
 */
export const ACTIVATION_PATH = '/activer';
let taken: { token: string | null } | null = null;

export function isActivationRoute(): boolean {
  return taken !== null || window.location.pathname === ACTIVATION_PATH;
}

export function takeActivationToken(): string | null {
  if (taken) return taken.token;
  if (window.location.pathname !== ACTIVATION_PATH) return null;
  const m = /(?:^|[#&])token=([A-Za-z0-9._~-]+)/.exec(window.location.hash);
  taken = { token: m ? m[1] : null };
  window.history.replaceState(null, '', ACTIVATION_PATH);
  return taken.token;
}

/** Quitte l'écran d'activation vers la connexion. */
export function leaveActivation(): void {
  taken = null;
  window.history.replaceState(null, '', '/');
}
