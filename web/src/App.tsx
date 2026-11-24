import { useCallback, useEffect, useState } from 'react';
import { api } from './api';
import { AppContext } from './app-context';
import { isSignedIn, mockRole, onSignedOut, signOut } from './auth';
import { ErrorBox, Loading } from './components/ui';
import { MOCK_AUTH } from './env';
import { EARNED_KEY } from './game';
import { errMsg } from './hooks';
import { useRoute } from './router';
import { DocView as Doc } from './screens/Doc';
import { Game } from './screens/Game';
import { Home } from './screens/Home';
import { Login } from './screens/Login';
import { Parent } from './screens/Parent';
import { JobView, Scan } from './screens/Scan';
import { Quiz } from './screens/Quiz';
import type { Me, Progress } from './types';

const loadBadges = (): string[] => {
  try {
    const v = JSON.parse(localStorage.getItem(EARNED_KEY) ?? '[]') as unknown;
    return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
};

export function App() {
  const [signed, setSigned] = useState(isSignedIn);
  useEffect(() => onSignedOut(() => setSigned(false)), []);
  if (!signed) return <Login onDone={() => setSigned(true)} />;
  return <Shell />;
}

function Shell() {
  const [me, setMe] = useState<Me | null>(null);
  const [progress, setProgress] = useState<Progress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [badges, setBadges] = useState<string[]>(loadBadges);
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
      (e) => live && setError(errMsg(e)),
    );
    return () => {
      live = false;
    };
  }, [refreshProgress]);

  const addBadges = useCallback((ids: string[]) => {
    setBadges((cur) => {
      const next = Array.from(new Set([...cur, ...ids]));
      localStorage.setItem(EARNED_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

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
