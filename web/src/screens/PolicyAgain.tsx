import { useState } from 'react';
import { api } from '../api';
import { signOut } from '../auth';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { downloadExport } from './Parent';
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

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  async function remove() {
    if (!window.confirm('Supprimer la famille, tous les comptes des élèves et toutes leurs données ? Cette action est définitive.')) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteFamily();
      signOut();
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <Mascot stage={3} size={120} label={false} />
      <h1>La politique de confidentialité a changé</h1>
      <p className="lead">Nous avons ajouté des nouveautés. Relis le nouveau texte pour continuer.</p>
      <ul className="lead news">
        <li>Chaque élève peut garder des schémas de ses cours, un par un et seulement s'il le choisit.</li>
        <li>Les formules s'écrivent et s'affichent mieux, et on peut ajouter des pages à un cours.</li>
        <li>Chaque élève a un identifiant de connexion et un surnom.</li>
        <li>Nous gardons l'historique des tests, que tu suis en lecture seule.</li>
        <li>Exercices de raisonnement : l'élève peut photographier sa copie pour la faire corriger par une IA (la photo est supprimée dès la fin de la correction).</li>
        <li>Une banque de questions variées et un entraînement sur plusieurs fiches.</li>
        <li>L'ajout d'une phrase oubliée à la relecture.</li>
        <li>Une archive complète que l'élève télécharge lui-même.</li>
        <li>Bientôt : la modification d'un cours déjà confirmé. Le texte la décrit déjà.</li>
      </ul>
      <p className="calm">📄 Lire la <PolicyLink /> (elle s'ouvre dans un nouvel onglet).</p>
      <ErrorBox message={error} />
      <label className="check">
        <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
        <span>J'ai lu la nouvelle politique de confidentialité et je l'accepte pour ma famille. Je peux retirer mon accord à tout moment en supprimant les comptes.</span>
      </label>
      <button className="btn btn-big" onClick={() => void accept()} disabled={busy || !consent}>{busy ? 'Enregistrement…' : "J'accepte la nouvelle politique"}</button>
      <button className="link" onClick={signOut}>Se déconnecter</button>
      <section className="card refuse" aria-labelledby="refuse-t">
        <h2 id="refuse-t">Tu ne veux pas accepter ?</h2>
        <p>Tu peux retirer ton accord : récupère d'abord tes données (le bouton ci-dessous donne l'export JSON de la famille, sans l'historique des tests ; l'archive complète est dans le tableau de bord, après acceptation), puis supprime la famille. Tous les comptes de la famille et leurs données seront effacés, sans retour possible.</p>
        <div className="btn-row">
          <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(downloadExport)}>Télécharger mes données</button>
          <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove()}>Supprimer la famille et les comptes</button>
        </div>
      </section>
    </main>
  );
}
