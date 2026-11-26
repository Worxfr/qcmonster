import { useEffect, useRef, useState } from 'react';
import { COPIE_WAIT_MS, POLL_MS } from './exo';

/**
 * Appelle `tick` toutes les 2 s tant qu'il renvoie `false` (`true` = fini). `active` = false suspend l'interrogation.
 * Apres `maxMs`, arrete et passe `timedOut` a vrai. Une erreur reseau ne coupe pas l'attente (on reessaie au tour suivant).
 */
export function usePoll(tick: () => Promise<boolean>, active: boolean, key: string, maxMs = COPIE_WAIT_MS): { timedOut: boolean } {
  const [timedOut, setTimedOut] = useState(false);
  const fn = useRef(tick);
  fn.current = tick;
  useEffect(() => {
    if (!active) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const t0 = Date.now();
    setTimedOut(false);
    const run = async () => {
      let done = false;
      try {
        done = await fn.current();
      } catch {
        done = false;
      }
      if (!live || done) return;
      if (Date.now() - t0 >= maxMs) {
        setTimedOut(true);
        return;
      }
      timer = setTimeout(run, POLL_MS);
    };
    timer = setTimeout(run, POLL_MS);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [active, key, maxMs]);
  return { timedOut };
}
