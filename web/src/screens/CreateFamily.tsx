import { useState } from 'react';
import { ApiError, api } from '../api';
import { refreshSession, signOut } from '../auth';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';

/** Premier passage d'un parent invité: crée la famille, puis renouvelle le jeton (il ne contient pas encore famille ni groupe). */
export function CreateFamily({ onReady }: { onReady: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      try {
        await api.createFamily();
      } catch (e) {
        if (!(e instanceof ApiError && e.status === 409)) throw e; // 409: la famille existe déjà, seul le jeton est périmé
      }
      await refreshSession();
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
      <button className="btn btn-big" onClick={create} disabled={busy}>{busy ? 'Création…' : 'Créer ma famille'}</button>
      <button className="link" onClick={signOut}>Se déconnecter</button>
    </main>
  );
}
