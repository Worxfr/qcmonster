import { useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { getGroups, signOut } from '../auth';
import { Mascot } from '../components/Mascot';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg } from '../hooks';
import type { InvitationCreated } from '../types';

/** Vrai si le jeton porte le groupe `admin`. Simple confort d'affichage: le serveur refuse (403) tout autre compte. */
export function useIsAdmin(): boolean | null {
  const [admin, setAdmin] = useState<boolean | null>(null);
  useEffect(() => {
    let live = true;
    getGroups().then(
      (g) => live && setAdmin(g.includes('admin')),
      () => live && setAdmin(false),
    );
    return () => {
      live = false;
    };
  }, []);
  return admin;
}

/** Page `#/admin`: génère un code d'invitation parent. Le code n'est montré qu'une fois, dans cette page, et jamais conservé. */
export function Admin() {
  const admin = useIsAdmin();
  const [created, setCreated] = useState<InvitationCreated | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);

  async function generate() {
    setBusy(true);
    setError(null);
    setCopied(false);
    try {
      setCreated(await api.createInvitation());
    } catch (e) {
      setCreated(null);
      setError(e instanceof ApiError && e.status === 429 ? "Tu as atteint la limite de codes pour aujourd'hui. Reviens demain !" : e instanceof ApiError && e.status === 403 ? 'Ce compte n\'a pas accès à cette page.' : errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function copy() {
    if (!created) return;
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
    } catch {
      setError('Copie impossible : sélectionne le code et copie-le à la main.');
    }
  }

  return (
    <>
      <header className="top">
        <span className="logo">QCMonster</span>
        <button className="link" onClick={signOut}>Déconnexion</button>
      </header>
      <main id="contenu" className="page" tabIndex={-1}>
        {admin === null ? (
          <Loading />
        ) : !admin ? (
          <Card title="Page introuvable">
            <p className="muted">Cette page n'existe pas.</p>
            <a className="btn btn-ghost" href="#/">Retour à l'accueil</a>
          </Card>
        ) : (
          <>
            <Card title="Invitations">
              <Mascot stage={2} size={96} label={false} />
              <p className="lead">Invite un parent : génère un code et transmets-le-lui.</p>
              <button className="btn btn-big" onClick={generate} disabled={busy}>{busy ? 'Génération…' : 'Générer un code'}</button>
              <ErrorBox message={error} />
            </Card>
            {created && (
              <Card title="Ton code d'invitation">
                <p className="invite-code" data-testid="invite-code">{created.code}</p>
                <button className="btn" onClick={copy}>{copied ? 'Copié ✔' : 'Copier le code'}</button>
                <p role="status" className="muted">
                  Ce code ne peut servir qu'une seule fois et ne sera plus affiché ensuite : copie-le maintenant. Il est utilisé dès que le parent envoie son inscription.
                </p>
                <p className="muted">Il te reste {created.remainingToday} code{created.remainingToday > 1 ? 's' : ''} aujourd'hui.</p>
              </Card>
            )}
            <a className="link" href="#/">Retour à l'accueil</a>
          </>
        )}
      </main>
    </>
  );
}
