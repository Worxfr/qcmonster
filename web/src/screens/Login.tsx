import { useState, type FormEvent } from 'react';
import { signIn, mockSignIn, mockAdminSignIn, type MockRole } from '../auth';
import { CONFIG_ERROR, MOCK_AUTH, SIGNUP_ENABLED } from '../env';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { takeRememberedLoginId } from '../activation';
import { normalizeLoginInput } from '../loginId';

export function Login({ onDone }: { onDone: () => void }) {
  const [user, setUser] = useState(() => takeRememberedLoginId() ?? '');
  const [pass, setPass] = useState('');
  const [code, setCode] = useState('');
  const [confirm, setConfirm] = useState<((c: string) => Promise<void>) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const pick = (role: MockRole) => {
    mockSignIn(role);
    onDone();
  };

  async function submit(e: FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      if (confirm) {
        await confirm(code.trim());
        onDone();
      } else {
        const r = await signIn(normalizeLoginInput(user), pass);
        if (r.kind === 'mfa') setConfirm(() => r.confirm);
        else onDone();
      }
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <Mascot stage={2} size={140} label={false} />
      <h1>QCMonster</h1>
      <p className="lead">Scanne ton cours, deviens plus fort.</p>
      {CONFIG_ERROR ? (
        <p role="alert" className="error">{CONFIG_ERROR}</p>
      ) : MOCK_AUTH ? (
        <div className="stack">
          <p className="muted">Mode démo : l'API simulée remplace la connexion.</p>
          <button className="btn" onClick={() => pick('eleve')}>Entrer comme élève</button>
          <button className="btn btn-alt" onClick={() => pick('parent')}>Entrer comme parent</button>
          <button className="btn btn-ghost" onClick={() => { mockAdminSignIn(); onDone(); }}>Entrer comme administrateur</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {confirm ? (
            <label>Code de ton application d'authentification
              <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
          ) : (
            <>
              <label>Identifiant ou e-mail
                {/* Pas de majuscule automatique ni de correction: sur un telephone, « Lila » au lieu de « lila » ferait echouer la connexion. */}
                <input autoComplete="username" autoCapitalize="none" autoCorrect="off" spellCheck={false} value={user} aria-describedby="login-help" onChange={(e) => setUser(e.target.value)} required />
              </label>
              <p id="login-help" className="muted">Ton identifiant ressemble à lila-7k2fm. Un parent se connecte avec son e-mail.</p>
              <label>Mot de passe
                <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} required />
              </label>
            </>
          )}
          <ErrorBox message={error} />
          <button className="btn" disabled={busy}>{confirm ? 'Valider le code' : 'Se connecter'}</button>
        </form>
      )}
      {SIGNUP_ENABLED && !CONFIG_ERROR && (
        <p className="muted">
          <a href="#/inscription">Créer un compte parent</a> · <a href="#/mot-de-passe-oublie">Mot de passe oublié</a>
        </p>
      )}
      <p className="muted"><a href="#/politique">Politique de confidentialité</a></p>
    </main>
  );
}
