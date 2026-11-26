import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { leaveActivation, rememberLoginId, takeActivationToken } from '../activation';
import { nicknameFormOk } from '../../../shared/pseudo-rules';
import { LoginIdCard } from '../components/LoginIdCard';
import type { ActivationResponse } from '../types';
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
  const [nick, setNick] = useState('');
  const [nickError, setNickError] = useState<string | null>(null);
  const [done, setDone] = useState<{ result: ActivationResponse | undefined } | null>(null);
  const problem = pass ? passwordProblem(pass) : null;
  const mismatch = again !== '' && again !== pass;
  // Forme seulement, en direct: la liste de mots n'est jamais consultee ici (le serveur decide, sans dire pourquoi).
  const nickBad = nick.trim() !== '' && !nicknameFormOk(nick);
  const ready = !!token && !passwordProblem(pass) && pass === again && !nickBad;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!ready || !token || busy) return;
    setBusy(true);
    setError(null);
    setNickError(null);
    try {
      const result = await api.activate(token, pass, nick.trim() || undefined);
      setPass('');
      setAgain('');
      setToken(null); // le jeton est à usage unique: on ne le garde pas en mémoire après succès
      if (result) rememberLoginId(result.loginId);
      setDone({ result });
    } catch (err) {
      // Surnom refusé ou déjà pris: le lien reste valable, le formulaire reste actif, le message est près du champ surnom.
      if (err instanceof ApiError && err.code === 'pseudo_refuse') setNickError("Ce surnom n'est pas possible, essaie-en un autre.");
      else if (err instanceof ApiError && err.code === 'pseudo_pris') setNickError('Ce surnom est déjà pris dans ta famille, essaie-en un autre.');
      else if (err instanceof ApiError && err.status === 404) setError("Ce lien n'est plus valable : il a déjà servi ou il a expiré. Demande un nouveau lien à ton parent.");
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
          {done.result ? (
            <>
              {done.result.displayNameChanged && <p className="notice">Ton surnom était déjà pris, on t'a donné <strong>{done.result.displayName}</strong>. Ton parent pourra le changer.</p>}
              <LoginIdCard loginId={done.result.loginId} />
              <p>Écris-le quelque part, ou demande à ton parent : il peut le retrouver. Tu en as besoin avec le mot de passe que tu viens de choisir.</p>
            </>
          ) : (
            <p>Demande ton identifiant à ton parent : il le voit dans sa liste d'élèves. Tu te connecteras avec lui et le mot de passe que tu viens de choisir.</p>
          )}
          <button className="btn btn-big" onClick={() => { leaveActivation(); onDone(); }}>Aller à la connexion</button>
        </div>
      ) : !token ? (
        <div className="stack">
          <p role="alert" className="error">Ce lien est incomplet. Demande un nouveau lien à ton parent.</p>
          <button className="btn btn-ghost" onClick={() => { leaveActivation(); onDone(); }}>Aller à la connexion</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          <p className="lead">Choisis ton surnom et ton mot de passe secret.</p>
          <label>Ton surnom
            <input value={nick} maxLength={20} autoComplete="off" aria-describedby="nick-help nick-err" aria-invalid={nickBad || !!nickError} onChange={(e) => { setNick(e.target.value); setNickError(null); }} />
          </label>
          <p id="nick-help" className={nickBad ? 'muted warn-text' : 'muted'}>
            {nickBad ? '2 à 20 caractères : lettres, espace ou tiret, et 2 chiffres au plus.' : "Invente un surnom. Pas ton nom de famille, ni ton école, ni ta date de naissance. Si tu n'en mets pas, on garde celui de ton parent."}
          </p>
          <p id="nick-err" role="alert" className={nickError ? 'error' : 'sr-only'}>{nickError ?? ''}</p>
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
