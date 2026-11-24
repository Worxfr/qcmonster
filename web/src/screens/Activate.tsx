import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { leaveActivation, takeActivationToken } from '../activation';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';

// Meme regle que le pool (docs/api-security.md): 12 caracteres, majuscule, minuscule, chiffre. Le serveur reste juge.
export function passwordProblem(p: string): string | null {
  if (p.length < 12) return 'Au moins 12 caractères.';
  if (p.length > 128) return '128 caractères au maximum.';
  if (!/[a-z]/.test(p) || !/[A-Z]/.test(p) || !/[0-9]/.test(p)) return 'Mélange une majuscule, une minuscule et un chiffre.';
  return null;
}

export function Activate({ onDone }: { onDone: () => void }) {
  const [token, setToken] = useState(takeActivationToken);
  const [pass, setPass] = useState('');
  const [again, setAgain] = useState('');
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  const problem = pass ? passwordProblem(pass) : null;
  const mismatch = again !== '' && again !== pass;
  const ready = !!token && !passwordProblem(pass) && pass === again;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !token || busy) return;
    setBusy(true);
    setError(null);
    try {
      await api.activate(token, pass);
      setPass('');
      setAgain('');
      setToken(null); // le jeton est à usage unique: on ne le garde pas en mémoire après succès
      setDone(true);
    } catch (err) {
      if (err instanceof ApiError && err.status === 404) setError("Ce lien n'est plus valable : il a déjà servi ou il a expiré. Demande un nouveau lien à ton parent.");
      else if (err instanceof ApiError && err.status === 400) setError('Ça ne marche pas. Vérifie ton mot de passe (12 caractères, majuscule, minuscule, chiffre) ou demande un nouveau lien à ton parent.');
      else setError('Impossible de joindre le serveur. Réessaie dans un instant.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <Mascot stage={1} size={140} label={false} />
      <h1>Bienvenue sur QCMonster !</h1>
      {done ? (
        <div className="stack" role="status">
          <p className="lead">C'est prêt ! Ton compte est activé.</p>
          <p>Connecte-toi avec ton pseudo et le mot de passe que tu viens de choisir.</p>
          <button className="btn btn-big" onClick={() => { leaveActivation(); onDone(); }}>Aller à la connexion</button>
        </div>
      ) : !token ? (
        <div className="stack">
          <p role="alert" className="error">Ce lien est incomplet. Demande un nouveau lien à ton parent.</p>
          <button className="btn btn-ghost" onClick={() => { leaveActivation(); onDone(); }}>Aller à la connexion</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="lead">Choisis ton mot de passe secret.</p>
          <label>Mot de passe
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={pass} minLength={12} maxLength={128} required
              aria-describedby="pw-help" aria-invalid={!!problem} onChange={(e) => setPass(e.target.value)} />
          </label>
          <p id="pw-help" className={problem ? 'muted warn-text' : 'muted'}>{problem ?? '12 caractères ou plus, avec une majuscule, une minuscule et un chiffre.'}</p>
          <label>Écris-le encore une fois
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={again} maxLength={128} required
              aria-invalid={mismatch} aria-describedby="pw-same" onChange={(e) => setAgain(e.target.value)} />
          </label>
          <p id="pw-same" aria-live="polite" className={mismatch ? 'muted warn-text' : 'sr-only'}>{mismatch ? 'Les deux mots de passe ne sont pas les mêmes.' : ''}</p>
          <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Montrer le mot de passe</label>
          <ErrorBox message={error} />
          <button className="btn btn-big" disabled={busy || !ready}>{busy ? 'Un instant…' : 'Activer mon compte'}</button>
        </form>
      )}
    </main>
  );
}
