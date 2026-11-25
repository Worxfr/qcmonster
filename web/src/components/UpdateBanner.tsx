import { useEffect, useState } from 'react';

const CHECK_EVERY_MS = 60 * 60 * 1000;

/**
 * Bandeau « Nouvelle version » (mode PWA `prompt`): le nouveau service worker attend, et la page ne se recharge qu'au clic,
 * pour ne jamais couper un envoi de photo en cours. Hors build de production (dev, tests) rien n'est enregistre.
 * Une verification de mise a jour a lieu au retour sur l'onglet et toutes les heures (sinon le navigateur ne verifie qu'a la navigation).
 */
export function UpdateBanner() {
  const [apply, setApply] = useState<null | (() => void)>(null);

  useEffect(() => {
    if (!import.meta.env.PROD || !('serviceWorker' in navigator)) return;
    let stop = () => {};
    void import('virtual:pwa-register').then(({ registerSW }) => {
      let reg: ServiceWorkerRegistration | undefined;
      const update = registerSW({
        immediate: true,
        onNeedRefresh: () => setApply(() => () => void update(true)),
        onRegisteredSW: (_url, r) => { reg = r; },
      });
      const check = () => { if (document.visibilityState === 'visible') void reg?.update().catch(() => {}); };
      const timer = setInterval(check, CHECK_EVERY_MS);
      document.addEventListener('visibilitychange', check);
      stop = () => { clearInterval(timer); document.removeEventListener('visibilitychange', check); };
    });
    return () => stop();
  }, []);

  if (!apply) return null;
  return (
    <div role="status" className="update-banner">
      <span>Nouvelle version disponible.</span>
      <button className="btn btn-small" onClick={apply}>Recharger</button>
    </div>
  );
}
