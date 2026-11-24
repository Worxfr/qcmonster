import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from './api';
import { isActivationRoute } from './activation';
import { AppContext } from './app-context';
import { isSignedIn, mockRole, onSignedOut, signOut } from './auth';
import { ErrorBox, Loading } from './components/ui';
import { MOCK_AUTH } from './env';
import { errMsg } from './hooks';
import { useRoute } from './router';
import { Activate } from './screens/Activate';
import { CreateFamily } from './screens/CreateFamily';
import { DocView as Doc } from './screens/Doc';
import { Game } from './screens/Game';
import { Home } from './screens/Home';
import { Login } from './screens/Login';
import { Parent } from './screens/Parent';
import { JobView, Scan } from './screens/Scan';
import { Quiz } from './screens/Quiz';
import type { Me, Progress } from './types';

export function App() {
  const [signed, setSigned] = useState(isSignedIn);
  const [activating, setActivating] = useState(isActivationRoute);
  useEffect(() => onSignedOut(() => setSigned(false)), []);
  if (activating) return <Activate onDone={() => setActivating(false)} />;
  if (!signed) return <Login onDone={() => setSigned(true)} />;
  return <Shell />;
}

function Shell() {
  const [me, setMe] = useState<Me | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [badges, setBadges] = useState<string[]>([]);
  const [noFamily, setNoFamily] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const route = useRoute();

  const refreshProgress = useCallback(async () => {
    try {
      setProgress(await api.progress());
    } catch (e) {
      setError(errMsg(e));
    }
  }, []);

  useEffect(() => {
    let live = true;
    api.me().then(
      (m) => {
        if (!live) return;
        const role = MOCK_AUTH ? (mockRole() ?? m.role) : m.role; // en mock, l'API renvoie toujours le meme profil
        setMe({ ...m, role });
        if (role === 'eleve') void refreshProgress();
      },
      (e) => {
        if (!live) return;
        // Parent invité qui n'a pas encore de famille: le profil est absent (404). Un 403 reste une erreur affichée (compte suspendu ou sans droit).
        if (e instanceof ApiError && e.status === 404) setNoFamily(true);
        else setError(errMsg(e));
      },
    );
    return () => {
      live = false;
    };
  }, [refreshProgress, attempt]);

  const addBadges = useCallback((ids: string[]) => {
    setBadges((cur) => Array.from(new Set([...cur, ...ids])));
  }, []);

  if (!me && noFamily) return <CreateFamily onReady={() => { setNoFamily(false); setError(null); setAttempt((n) => n + 1); }} />;
  if (!me) return <main className="page">{error ? <ErrorBox message={error} /> : <Loading />}{error && <button className="btn" onClick={signOut}>Se déconnecter</button>}</main>;

  const parent = me.role === 'parent';
  const [, seg, arg] = route.split('/');
  const id = arg ? decodeURIComponent(arg) : '';
  let body;
  if (parent) body = <Parent />;
  else if (seg === 'scan') body = <Scan />;
  else if (seg === 'job' && id) body = <JobView id={id} />;
  else if (seg === 'doc' && id) body = <Doc id={id} />;
  else if (seg === 'quiz' && id) body = <Quiz docId={id} />;
  else if (seg === 'jeu') body = <Game />;
  else body = <Home />;

  const tab = (path: string, label: string, icon: string, active: boolean) => (
    <a href={`#${path}`} aria-current={active ? 'page' : undefined}><span aria-hidden="true">{icon}</span>{label}</a>
  );

  return (
    <AppContext.Provider value={{ me, progress, setProgress, refreshProgress, earnedBadges: badges, addBadges }}>
      <a className="skip" href="#contenu">Aller au contenu</a>
      <header className="top">
        <span className="logo">QCMonster</span>
        <button className="link" onClick={signOut}>Déconnexion</button>
      </header>
      <main id="contenu" className="page" tabIndex={-1}>
        {error && <ErrorBox message={error} />}
        {body}
      </main>
      {!parent && (
        <nav className="tabs" aria-label="Navigation principale">
          {tab('/', 'Accueil', '🏠', !seg || seg === 'doc' || seg === 'quiz')}
          {tab('/scan', 'Scanner', '📷', seg === 'scan' || seg === 'job')}
          {tab('/jeu', 'Jeu', '🏆', seg === 'jeu')}
        </nav>
      )}
    </AppContext.Provider>
  );
}
