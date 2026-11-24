import { useState, type FormEvent } from 'react';
import { signIn, mockSignIn, type MockRole } from '../auth';
import { MOCK_AUTH } from '../env';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';

export function Login({ onDone }: { onDone: () => void }) {
  const [user, setUser] = useState('');
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
        const r = await signIn(user.trim(), pass);
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
      {MOCK_AUTH ? (
        <div className="stack">
          <p className="muted">Mode démo : l'API simulée remplace la connexion.</p>
          <button className="btn" onClick={() => pick('eleve')}>Entrer comme élève</button>
          <button className="btn btn-alt" onClick={() => pick('parent')}>Entrer comme parent</button>
        </div>
      ) : (
        <form className="stack" onSubmit={submit}>
          {confirm ? (
            <label>Code de ton application d'authentification
              <input inputMode="numeric" autoComplete="one-time-code" value={code} onChange={(e) => setCode(e.target.value)} required />
            </label>
          ) : (
            <>
              <label>Pseudo ou e-mail
                <input autoComplete="username" value={user} onChange={(e) => setUser(e.target.value)} required />
              </label>
              <label>Mot de passe
                <input type="password" autoComplete="current-password" value={pass} onChange={(e) => setPass(e.target.value)} required />
              </label>
            </>
          )}
          <ErrorBox message={error} />
          <button className="btn" disabled={busy}>{confirm ? 'Valider le code' : 'Se connecter'}</button>
        </form>
      )}
    </main>
  );
}
