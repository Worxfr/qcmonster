import { useRef, useState, type FormEvent } from 'react';
import { clearPendingSignup, confirmSignUpParent, mockSignIn, pendingSignup, resendSignUpCode, signIn, signUpParent } from '../auth';
import { Mascot } from '../components/Mascot';
import { ErrorBox } from '../components/ui';
import { MOCK_AUTH } from '../env';
import { errMsg } from '../hooks';
import { go } from '../router';
import { passwordProblem } from './Activate';
import { PolicyLink } from './Policy';

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** Inscription d'un parent invité: formulaire, puis code à 6 chiffres reçu par e-mail, puis connexion automatique. */
export function Signup({ onDone }: { onDone: () => void }) {
  const [username, setUsername] = useState<string | null>(pendingSignup);
  const [email, setEmail] = useState('');
  const [pass, setPass] = useState('');
  const [invite, setInvite] = useState('');
  const [consent, setConsent] = useState(false);
  const [show, setShow] = useState(false);
  const [code, setCode] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [info, setInfo] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const password = useRef(''); // gardé en mémoire pour la connexion automatique, jamais stocké
  const problem = pass ? passwordProblem(pass) : null;
  const ready = EMAIL.test(email.trim()) && !passwordProblem(pass) && invite.trim().length >= 16 && consent;

  async function submitForm(e: FormEvent) {
    e.preventDefault();
    if (!ready || busy) return;
    setBusy(true);
    setError(null);
    try {
      password.current = pass;
      setUsername(await signUpParent(email.trim(), pass, invite.trim()));
      setPass('');
      setInvite('');
    } catch (err) {
      setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  async function submitCode(e: FormEvent) {
    e.preventDefault();
    if (!username || busy) return;
    setBusy(true);
    setError(null);
    try {
      await confirmSignUpParent(username, code.trim());
    } catch (err) {
      setError(errMsg(err));
      setBusy(false);
      return;
    }
    try {
      if (MOCK_AUTH) mockSignIn('parent');
      else if (password.current) await signIn(username, password.current);
      else throw new Error('pas de mot de passe en mémoire');
      password.current = '';
      onDone(); // l'écran « Créer ma famille » s'ouvre tout seul au premier passage
    } catch {
      password.current = '';
      setUsername(null);
      go('/');
      setBusy(false);
    }
  }

  async function resend() {
    if (!username) return;
    setError(null);
    setInfo(null);
    try {
      await resendSignUpCode(username);
      setInfo('Un nouveau code vient d\'être envoyé.');
    } catch (err) {
      setError(errMsg(err));
    }
  }

  const restart = () => {
    clearPendingSignup();
    password.current = '';
    setUsername(null);
    setCode('');
    setError(null);
    setInfo(null);
  };

  return (
    <main className="login">
      <Mascot stage={1} size={140} label={false} />
      <h1>Créer mon compte parent</h1>
      {username ? (
        <form className="stack" onSubmit={submitCode}>
          <p className="lead">Regarde tes e-mails !</p>
          <p className="muted">Nous t'avons envoyé un code à 6 chiffres. Écris-le ici pour finir l'inscription. Pense à regarder dans les courriers indésirables.</p>
          <label>Code reçu par e-mail
            <input inputMode="numeric" autoComplete="one-time-code" autoFocus pattern="[0-9]{6}" maxLength={6} value={code} onChange={(e) => setCode(e.target.value)} required />
          </label>
          <ErrorBox message={error} />
          {info && <p role="status" className="muted">{info}</p>}
          <button className="btn btn-big" disabled={busy || code.trim().length !== 6}>{busy ? 'Un instant…' : 'Valider mon compte'}</button>
          <button type="button" className="link" onClick={resend}>Renvoyer le code</button>
          <button type="button" className="link" onClick={restart}>Recommencer avec un autre e-mail</button>
        </form>
      ) : (
        <form className="stack" onSubmit={submitForm}>
          <p className="muted">L'inscription demande un code d'invitation. Tu l'as reçu de la personne qui te propose QCMonster.</p>
          <label>Ton e-mail
            <input type="email" autoComplete="email" autoFocus value={email} onChange={(e) => setEmail(e.target.value)} required />
          </label>
          <label>Mot de passe
            <input type={show ? 'text' : 'password'} autoComplete="new-password" value={pass} maxLength={128} required
              aria-describedby="su-pw-help" aria-invalid={!!problem} onChange={(e) => setPass(e.target.value)} />
          </label>
          <p id="su-pw-help" className={problem ? 'muted warn-text' : 'muted'}>{problem ?? '12 caractères ou plus, avec une majuscule, une minuscule et un chiffre.'}</p>
          <label className="check"><input type="checkbox" checked={show} onChange={(e) => setShow(e.target.checked)} /> Montrer le mot de passe</label>
          <label>Code d'invitation
            <input autoComplete="off" autoCapitalize="none" spellCheck={false} value={invite} maxLength={128} onChange={(e) => setInvite(e.target.value)} required />
          </label>
          <label className="check">
            <input type="checkbox" checked={consent} onChange={(e) => setConsent(e.target.checked)} />
            <span>J'ai lu la <PolicyLink /> et je l'accepte.</span>
          </label>
          <ErrorBox message={error} />
          <button className="btn btn-big" disabled={busy || !ready}>{busy ? 'Un instant…' : 'Créer mon compte'}</button>
        </form>
      )}
      <p className="muted"><a href="#/">J'ai déjà un compte</a></p>
    </main>
  );
}
