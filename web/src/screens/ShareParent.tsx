import { useState } from 'react';
import { api } from '../api';
import { ErrorBox, Loading } from '../components/ui';
import { useLoad } from '../hooks';
import { plural } from '../labels';
import { dayLabel } from '../share';
import type { Student } from '../types';
import { shareError, stateClass, stateLabel } from './Share';
import './share.css';

/**
 * Vue parent du partage d'un eleve: interrupteur (ferme par defaut), liens (titre, dates, lectures, signalements), revocation.
 * Jamais les questions ni le lien lui-meme. Couper = drapeau d'abord (`sharing: false`), puis suppression des liens (rejouable).
 */
export function ShareParent({ student: s }: { student: Student }) {
  const [on, setOn] = useState(s.sharing === true);
  const l = useLoad(() => api.studentShares(s.studentId), [s.studentId]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async (fn: () => Promise<unknown>) => {
    setBusy(true);
    setError(null);
    try {
      await fn();
    } catch (e) {
      setError(shareError(e));
    } finally {
      setBusy(false);
      l.reload();
    }
  };
  const turn = (value: boolean) => {
    if (!value && !window.confirm(`Couper le partage pour ${s.displayName} ? Tous ses liens seront supprimés tout de suite.`)) return;
    void run(async () => {
      await api.updateStudent(s.studentId, { sharing: value });
      setOn(value);
      if (!value) await api.deleteStudentShares(s.studentId); // si ceci echoue, `purgePending` propose de terminer
    });
  };
  const revokeAll = () => {
    if (!window.confirm(`Supprimer tous les liens de ${s.displayName} ?`)) return;
    void run(() => api.deleteStudentShares(s.studentId));
  };
  const revoke = (id: string, title: string) => {
    if (!window.confirm(`Supprimer le lien « ${title} » ?`)) return;
    void run(() => api.deleteStudentShare(s.studentId, id));
  };

  const shares = l.data?.shares ?? [];
  return (
    <section className="share-parent" aria-label={`Partage de QCM de ${s.displayName}`}>
      <h4>🔗 Partage de QCM</h4>
      <label className="check">
        <input type="checkbox" role="switch" checked={on} disabled={busy} onChange={(e) => turn(e.target.checked)} />
        <span>{on ? `${s.displayName} peut partager des QCM par lien` : `Partage fermé pour ${s.displayName}`}</span>
      </label>
      <p className="muted">
        {on
          ? 'Un lien donne accès à 5 à 20 questions que l’élève a déjà réussies, sans compte et sans point. Tu vois ci-dessous le titre, les dates, les lectures et les signalements, jamais les questions.'
          : 'Fermé par défaut. Si tu l’actives, ton enfant peut créer des liens vers des questions qu’il a déjà réussies. Tu peux les supprimer à tout moment.'}
      </p>
      <ErrorBox message={error} />
      {l.loading && !l.data && <Loading />}
      {l.error && !l.data && <p role="alert" className="error">{l.error}</p>}
      {l.data?.purgePending && (
        <p className="notice" role="status">
          Le partage est coupé, mais des liens existent encore.{' '}
          <button className="btn btn-small" disabled={busy} onClick={revokeAll}>Terminer la suppression</button>
        </p>
      )}
      {shares.length > 0 && (
        <>
          <ul className="list">
            {shares.map((x) => (
              <li key={x.shareId} className="share-row">
                <div className="grow">
                  <strong>{x.title}</strong> <span className={stateClass(x)}>{stateLabel(x)}</span>
                  <p className="muted">{x.count} questions · créé le {dayLabel(x.createdAt)} · jusqu’au {dayLabel(x.expiresAt)} · {x.reads} {plural(x.reads, 'lecture', 'lectures')} · {x.reports} {plural(x.reports, 'signalement', 'signalements')}</p>
                </div>
                <button className="btn btn-small btn-ghost" disabled={busy} onClick={() => revoke(x.shareId, x.title)} aria-label={`Supprimer le lien ${x.title}`}>Supprimer</button>
              </li>
            ))}
          </ul>
          <button className="btn btn-small btn-ghost" disabled={busy} onClick={revokeAll}>Tout supprimer</button>
        </>
      )}
      {l.data && shares.length === 0 && !l.data.purgePending && on && <p className="muted">Aucun lien pour l’instant.</p>}
    </section>
  );
}
