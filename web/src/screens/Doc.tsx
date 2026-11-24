import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Loading, Pill } from '../components/ui';
import { safeUrl } from '../game';
import { errMsg, useLoad } from '../hooks';
import { go } from '../router';
import type { Claim } from '../types';

export function DocView({ id }: { id: string }) {
  const d = useLoad(() => api.doc(id), [id]);
  const [error, setError] = useState<string | null>(null);
  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox message={d.error} />;
  const doc = d.data;

  async function remove() {
    if (!window.confirm('Supprimer cette fiche et ses questions ?')) return;
    try {
      await api.deleteDoc(id);
      go('/');
    } catch (e) {
      setError(errMsg(e));
    }
  }

  return (
    <>
      <Card title={doc.title}>
        <p>{doc.summary}</p>
        <button className="btn btn-big" onClick={() => go(`/quiz/${encodeURIComponent(id)}`)}>🎮 S'entraîner</button>
      </Card>
      <Card title="Ce que dit ta fiche">
        <p className="muted">Chaque affirmation est contrôlée avec des sources. Clique pour les lire.</p>
        <ul className="list">
          {doc.claims.map((c) => <ClaimItem key={c.claimId} docId={id} claim={c} />)}
        </ul>
      </Card>
      <ErrorBox message={error} />
      <button className="btn btn-ghost" onClick={remove}>Supprimer cette fiche</button>
    </>
  );
}

function ClaimItem({ docId, claim }: { docId: string; claim: Claim }) {
  const [open, setOpen] = useState(false);
  const [report, setReport] = useState(false);
  const [comment, setComment] = useState('');
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    try {
      await api.report(docId, comment.trim(), claim.claimId);
      setMsg('Merci ! Ton parent va regarder ton signalement.');
      setReport(false);
      setComment('');
    } catch (x) {
      setErr(errMsg(x));
    }
  }

  return (
    <li className={`claim claim-${claim.status}`}>
      <p><Pill status={claim.status} /> {claim.text}</p>
      {claim.aRisque && <p className="muted">⚠️ Sujet sensible : demande aussi à ton professeur.</p>}
      {claim.sources.length > 0 && (
        <>
          <button className="link" aria-expanded={open} onClick={() => setOpen(!open)}>
            {open ? 'Cacher' : 'Voir'} les sources ({claim.sources.length})
          </button>
          {open && (
            <ul className="sources">
              {claim.sources.map((s) => {
                const href = safeUrl(s.url);
                return (
                  <li key={s.passageId}>
                    {href ? <a href={href} target="_blank" rel="noopener noreferrer">{s.titre} <span className="muted">({s.site})</span></a> : <span>{s.titre} ({s.site})</span>}
                    <blockquote>{s.extrait}</blockquote>
                  </li>
                );
              })}
            </ul>
          )}
        </>
      )}
      {msg && <p role="status" className="ok">{msg}</p>}
      {report ? (
        <form onSubmit={send} className="stack">
          <label>Qu'est-ce qui est faux ?
            <textarea rows={2} value={comment} maxLength={500} required onChange={(e) => setComment(e.target.value)} />
          </label>
          <ErrorBox message={err} />
          <button className="btn btn-small">Envoyer</button>
        </form>
      ) : (
        <button className="link" onClick={() => setReport(true)}>Signaler une erreur</button>
      )}
    </li>
  );
}
