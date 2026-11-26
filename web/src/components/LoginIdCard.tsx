import { useState } from 'react';

/** Identifiant de connexion en gros, avec un bouton pour le copier. Jamais ecrit dans l'URL ni dans un stockage: il n'existe qu'a l'ecran. */
export function LoginIdCard({ loginId, label = 'Ton identifiant pour te connecter' }: { loginId: string; label?: string }) {
  const [copied, setCopied] = useState(false);
  async function copy() {
    try {
      await navigator.clipboard.writeText(loginId);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      setCopied(false); // pas de presse-papiers (navigateur ancien): l'identifiant reste lisible a l'ecran
    }
  }
  return (
    <div className="login-id soft">
      <p className="login-id-label" id="login-id-label">{label}</p>
      <p className="login-id-value" aria-labelledby="login-id-label" data-testid="login-id">{loginId}</p>
      <button type="button" className="btn btn-small" onClick={() => void copy()}>{copied ? 'Copié !' : 'Copier'}<span className="sr-only"> l'identifiant</span></button>
      <span role="status" className="sr-only">{copied ? 'Identifiant copié' : ''}</span>
    </div>
  );
}
