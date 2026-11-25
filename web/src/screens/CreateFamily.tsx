import { useState } from 'react';
import { ApiError, api } from '../api';
import { refreshSession, signOut } from '../auth';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { POLICY_VERSION } from '../../../shared/policy';
import { PolicyLink } from './Policy';
import { errMsg } from '../hooks';

/** Premier passage d'un parent invité: crée la famille, puis renouvelle le jeton (il ne contient pas encore famille ni groupe). */
export function CreateFamily({ onReady }: { onReady: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [relogin, setRelogin] = useState(false);
  const [consent, setConsent] = useState(false);

  async function create() {
    if (!consent) return;
    setBusy(true);
    setError(null);
    try {
      try {
        await api.createFamily({ consent: true, policyVersion: POLICY_VERSION });
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e; // 409: la famille existe déjà, seul le jeton est périmé
      }
      try {
        await refreshSession();
      } catch {
        // La famille existe, mais les jetons n'ont pas pu être renouvelés: une nouvelle connexion les met à jour.
        setRelogin(true);
        setError('Ta famille est créée. Reconnecte-toi pour continuer.');
        setBusy(false);
        return;
      }
      onReady();
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "Ce compte ne peut pas créer de famille. Il faut une invitation." : errMsg(e));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <Mascot stage={2} size={140} label={false} />
      <h1>Bienvenue !</h1>
      <p className="lead">Crée l'espace de ta famille pour inviter tes enfants.</p>
      <p className="muted">Tu pourras ensuite ajouter chaque élève, suivre ses progrès et régler ses pages du mois.</p>
      <ErrorBox message={error} />
      {relogin ? (
        <button className="btn btn-big" onClick={signOut}>Se reconnecter</button>
      ) : (
        <>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>J'ai lu la <PolicyLink /> et je l'accepte pour ma famille. Je sais que je peux retirer mon accord à tout moment, ce qui supprime les comptes et leurs données.</span>
          </label>
          <button className="btn btn-big" onClick={create} disabled={busy || !consent}>{busy ? 'Création…' : 'Créer ma famille'}</button>
          <button className="link" onClick={signOut}>Se déconnecter</button>
        </>
      )}
    </main>
  );
}
