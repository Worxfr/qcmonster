import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { FolderSelect, useFolders } from '../components/FolderSelect';
import { Card, ErrorBox, Loading, Pill } from '../components/ui';
import { safeUrl } from '../game';
import { errMsg, useLoad } from '../hooks';
import { go } from '../router';
import { folderError } from './Folders';
import type { Claim } from '../types';
import { Rich } from '../components/Math';
import { FigureView } from './confirm/FigureCard';
import './confirm/confirm.css';

const RECALL = { date: 'Date', formule: 'Formule', definition: 'Définition', nombre: 'Nombre' } as const;

export function DocView({ id, claimId }: { id: string; claimId?: string }) {
  const d = useLoad(() => api.doc(id), [id]);
  const { setProgress, addBadges } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [read, setRead] = useState<{ xp: number } | null>(null);
  const [reading, setReading] = useState(false);
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

  async function markRead() {
    setReading(true);
    setError(null);
    try {
      const r = await api.markRead(id);
      setProgress(r.progress);
      if (r.badges.length) addBadges(r.badges);
      setRead({ xp: r.xpGained });
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setReading(false);
    }
  }

  return (
    <>
      <Card title={doc.title}>
        {doc.body?.length ? (
          <div className="fiche-body">
            {doc.body.map((p, i) => (
              <div key={i}>
                {p.heading && <h3><Rich text={p.heading} /></h3>}
                <p><Rich text={p.text} /></p>
              </div>
            ))}
          </div>
        ) : <p><Rich text={doc.summary} /></p>}
        {doc.figures?.map((f) => <FigureView key={f.figureId} figure={f} />)}
        {doc.recall?.length ? (
          <section className="recall" aria-labelledby="recall-h">
            <h3 id="recall-h">À retenir</h3>
            <ul>
              {doc.recall.map((r) => (
                <li key={`${r.claimId}-${r.kind}`}>
                  <span className="recall-kind">{RECALL[r.kind]}</span>
                  <span><Rich text={r.text} formula={false} /></span>
                  {!r.verified && <span className="recall-nv">non vérifié</span>}
                </li>
              ))}
            </ul>
          </section>
        ) : null}
        <button className="btn btn-big" onClick={() => go(`/quiz/${encodeURIComponent(id)}`)}>🎮 S'entraîner</button>
      </Card>
      <FolderCard docId={id} initial={doc.folderId ?? ''} />
      <Card title="Ce que dit ta fiche">
        <p className="muted">Chaque affirmation est contrôlée avec des sources. Clique pour les lire.</p>
        <ul className="list">
          {doc.claims.map((c) => <ClaimItem key={c.claimId} docId={id} claim={c} focus={c.claimId === claimId} />)}
        </ul>
      </Card>
      <Card title="Fini de lire ?">
        {read ? (
          <p role="status" className="ok">{read.xp > 0 ? `✓ Bien lu ! +${read.xp} XP.` : "✓ C'est noté. Les points de lecture de cette fiche sont déjà pris aujourd'hui."}</p>
        ) : (
          <>
            <p className="muted">Quand tu as tout lu, dis-le pour gagner des points.</p>
            <button className="btn" onClick={markRead} disabled={reading}>{reading ? 'Un instant…' : "✓ J'ai tout lu"}</button>
          </>
        )}
      </Card>
      <ErrorBox message={error} />
      <button className="btn btn-ghost" onClick={remove}>Supprimer cette fiche</button>
    </>
  );
}

/** Ranger la fiche dans un dossier, la changer de dossier ou la sortir du dossier (effet immediat). */
function FolderCard({ docId, initial }: { docId: string; initial: string }) {
  const { folders, add } = useFolders();
  const [current, setCurrent] = useState(initial);
  const created = useRef(new Map<string, string>()); // un dossier tout juste cree n'est pas encore dans `folders` quand on range la fiche
  const [msg, setMsg] = useState<string | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  async function move(to: string) {
    if (busy) return;
    setBusy(true);
    setErr(null);
    setMsg(null);
    try {
      if (to) await api.addToFolder(to, [docId]);
      else await api.removeFromFolder(current, docId);
      setCurrent(to);
      setMsg(to ? `✓ Rangée dans « ${created.current.get(to) ?? folders.find((f) => f.folderId === to)?.name ?? 'ce dossier'} ».` : '✓ Sortie du dossier.');
    } catch (e) {
      setErr(folderError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <Card title="Dossier">
      <FolderSelect disabled={busy} label="Cette fiche est dans" value={current} onChange={(f) => void move(f)} folders={folders} onCreated={(f) => { created.current.set(f.folderId, f.name); add(f); }} none="Aucun dossier" />
      {msg && <p role="status" className="ok">{msg}</p>}
      {err && <p role="alert" className="error">{err}</p>}
    </Card>
  );
}

function ClaimItem({ docId, claim, focus }: { docId: string; claim: Claim; focus?: boolean }) {
  const [open, setOpen] = useState(!!focus);
  const li = useRef<HTMLLIElement>(null);
  useEffect(() => { if (focus) li.current?.scrollIntoView?.({ block: 'center' }); }, [focus]);
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
    <li ref={li} className={`claim claim-${claim.status}${focus ? ' focus' : ''}`}>
      <p><Pill status={claim.status} /> <Rich text={claim.text} /></p>
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
