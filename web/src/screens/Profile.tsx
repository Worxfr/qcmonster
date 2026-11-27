import { useApp } from '../app-context';
import { Card } from '../components/ui';
import { SHARE_ENABLED } from '../env';
import { LoginIdCard } from '../components/LoginIdCard';

/** « Mon profil »: surnom et identifiant de connexion, en lecture seule (seul le parent change le surnom ou l'identifiant). */
export function Profile() {
  const { me } = useApp();
  return (
    <>
      <Card title="Mon profil">
        <p>Ton surnom : <strong>{me.displayName ?? me.pseudo ?? '—'}</strong></p>
        {me.loginId ? <LoginIdCard loginId={me.loginId} label="Ton identifiant pour te connecter" /> : <p>Demande ton identifiant à ton parent.</p>}
        <p className="muted">Tu t'en sers avec ton mot de passe. Pour changer ton surnom ou ton identifiant, demande à ton parent.</p>
        {SHARE_ENABLED && <a className="btn btn-ghost" href="#/partages">🔗 Mes liens de partage</a>}
        <a className="btn btn-ghost" href="#/">← Retour</a>
      </Card>
    </>
  );
}
