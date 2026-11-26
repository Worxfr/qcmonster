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
      <p className="lead">Nous avons ajouté des nouveautés : chaque élève peut garder des schémas de ses cours, un par un et seulement s'il le choisit ; les formules s'écrivent et s'affichent mieux ; on peut ajouter des pages à un cours ; chaque élève a un identifiant de connexion et un surnom ; et nous gardons l'historique des tests, que tu suis en lecture seule. Viennent s'y ajouter des exercices de raisonnement, où l'élève peut photographier sa copie pour la faire corriger par une IA (la photo est supprimée dès la fin de la correction), une banque de questions variées avec un entraînement sur plusieurs fiches, l'ajout d'une phrase oubliée à la relecture et une archive que l'élève télécharge lui-même. Le texte décrit aussi la modification d'un cours déjà confirmé, qui ouvrira plus tard. Relis le nouveau texte pour continuer.</p>
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
        <p>Tu peux retirer ton accord : récupère d'abord tes données, puis supprime la famille. Tous les comptes de la famille et leurs données seront effacés, sans retour possible.</p>
        <div className="btn-row">
          <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => void run(downloadExport)}>Télécharger mes données</button>
          <button className="btn btn-small btn-danger" disabled={busy} onClick={() => void remove()}>Supprimer la famille et les comptes</button>
        </div>
      </section>
    </main>
  );
}
