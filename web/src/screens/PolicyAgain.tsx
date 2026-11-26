import { useState } from 'react';
import { api } from '../api';
import { signOut } from '../auth';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { POLICY_VERSION } from '../../../shared/policy';
import { PolicyLink } from './Policy';

/** Le texte de la politique a changé depuis le consentement de la famille (GET /me: policyOutdated): le parent la relit et l'accepte. */
export function PolicyAgain({ onDone }: { onDone: () => void }) {
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    if (!consent) return;
    setBusy(true);
    setError(null);
    try {
      await api.acceptPolicy({ consent: true, policyVersion: POLICY_VERSION });
      onDone();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <Mascot stage={3} size={120} label={false} />
      <h1>La politique de confidentialité a changé</h1>
      <p className="lead">Nous gardons maintenant l'historique des tests de tes enfants, et tu peux le suivre en lecture seule. Relis le nouveau texte pour continuer.</p>
      <p className="calm">📄 Lire la <PolicyLink /> (elle s'ouvre dans un nouvel onglet).</p>
      <ErrorBox message={error} />
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>J'ai lu la nouvelle politique de confidentialité et je l'accepte pour ma famille. Je peux retirer mon accord à tout moment en supprimant les comptes.</span>
      </label>
      <button className="btn btn-big" onClick={() => void accept()} disabled={busy || !consent}>{busy ? 'Enregistrement…' : "J'accepte la nouvelle politique"}</button>
      <button className="link" onClick={signOut}>Se déconnecter</button>
    </main>
  );
}
