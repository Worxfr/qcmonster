import { useState, type FormEvent } from 'react';
import { requestPasswordReset, resetPassword } from '../auth';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { passwordProblem } from './Activate';

/** Mot de passe oublié (parent): code par e-mail, puis nouveau mot de passe. Même réponse que le compte existe ou non. */
export function ForgotPassword() {
  const [step, setStep] = useState<'email' | 'code' | 'done'>('email');
  const [email, setEmail] = useState('');
  const [code, setCode] = useState('');
  const [pass, setPass] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const problem = pass ? passwordProblem(pass) : null;

  async function run(e: FormEvent, fn: () => Promise<void>, next: 'code' | 'done') {
    e.preventDefault();
    if (busy) return;
    setBusy(true);
    setError(null);
    try {
      await fn();
      setStep(next);
      setPass('');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="login">
      <Mascot stage={1} size={140} label={false} />
      <h1>Mot de passe oublié</h1>
      {step === 'email' && (
        <form className="stack" onSubmit={(e) => run(e, () => requestPasswordReset(email.trim()), 'code')}>
          <p className="muted">Pour les comptes parents. Un élève demande à son parent de lui créer un nouveau lien d'activation.</p>
          <label>Ton e-mail
            <input type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <ErrorBox message={error} />
          <button className="btn btn-big" disabled={busy || !email.trim()}>{busy ? 'Un instant…' : 'Recevoir un code'}</button>
        </form>
      )}
      {step === 'code' && (
        <form className="stack" onSubmit={(e) => run(e, () => resetPassword(email.trim(), code.trim(), pass), 'done')}>
          <p className="lead">Regarde tes e-mails.</p>
          <p className="muted">Si un compte parent existe pour cette adresse, un code à 6 chiffres vient d'être envoyé.</p>
          <label>Code reçu par e-mail
            <input inputMode="numeric" autoComplete="one-time-code" autoFocus pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <label>Nouveau mot de passe
            <input type="password" autoComplete="new-password" value={pass} maxLength={128} required aria-describedby="fp-pw-help" aria-invalid={!!problem} onChange={(e) => setPass(e.target.value)} />
          </label>
          <p id="fp-pw-help" className={problem ? 'muted warn-text' : 'muted'}>{problem ?? '12 caractères ou plus, avec une majuscule, une minuscule et un chiffre.'}</p>
          <ErrorBox message={error} />
          <button className="btn btn-big" disabled={busy || code.trim().length !== 6 || !!passwordProblem(pass)}>{busy ? 'Un instant…' : 'Changer mon mot de passe'}</button>
        </form>
      )}
      {step === 'done' && (
        <div className="stack" role="status">
          <p className="lead">C'est fait !</p>
          <p>Ton mot de passe est changé. Tu peux te connecter.</p>
          <a className="btn btn-big" href="#/">Aller à la connexion</a>
        </div>
      )}
      {step !== 'done' && <p className="muted"><a href="#/">Retour à la connexion</a></p>}
    </main>
  );
}
