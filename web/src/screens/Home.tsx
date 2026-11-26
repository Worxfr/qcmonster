import { useEffect, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { Mascot } from '../components/Mascot';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { levelProgress, stageName } from '../game';
import { useLoad } from '../hooks';
import { fmtDay, plural, subjectClass, subjectLabel, timeLeft } from '../labels';
import type { ScanSummary } from '../types';
import { go } from '../router';


export function Home() {
  const { me, progress } = useApp();
  const docs = useLoad(() => api.listScans({ status: 'termine', limit: 5 }), []);
  const review = useReview();
  const lp = progress ? levelProgress(progress.xp, progress.level) : null;
  return (
    <>
      {review.length > 0 && (
        <section className="card review-card" aria-label="À relire">
          <h2>✍️ À relire</h2>
          <ul className="list">
            {review.map((s) => {
              const left = timeLeft(s.status.expiresAt);
              const soon = s.status.expiresSoon;
              return (
                <li key={s.scanId} className={`run-row${soon ? ' soon' : ''}`} role={soon ? 'status' : undefined}>
                  <span className="grow">
                    <strong>{s.subject ? subjectLabel(s.subject) : 'Cours à relire'}{s.topic ? ` · ${s.topic}` : ''}</strong><br />
                    <span className="muted">
                      {s.pages} {plural(s.pages, 'page', 'pages')}
                      {left && <> · {soon ? <><span aria-hidden="true">⏳ </span>{left.replace('Il reste ', 'Plus que ')}, relis-le vite</> : left}</>}
                    </span>
                  </span>
                  <button type="button" className="btn btn-small" onClick={() => go(`/job/${encodeURIComponent(s.scanId)}`)}>Relire<span className="sr-only"> ce scan</span></button>
                </li>
              );
            })}
          </ul>
        </section>
      )}
      <Card>
        <div className="hero-row">
          <Mascot stage={progress?.stage ?? 2} size={120} />
          <div className="grow">
            <h1>Salut {me.pseudo ?? 'toi'} !</h1>
            {progress && lp ? (
              <>
                <p><strong>Niveau {progress.level}</strong> · {progress.xp} XP</p>
                <Bar pct={lp.pct} label="Progression vers le niveau suivant" />
                <p className="muted">Encore {lp.remaining} XP pour devenir {progress.level + 1}. {stageName(progress.stage)}.</p>
                <p><span className="chip">🔥 {progress.streakDays} jour{progress.streakDays > 1 ? 's' : ''} de suite</span> <span className="chip">📄 {progress.pagesRemaining} page{progress.pagesRemaining > 1 ? 's' : ''} restante{progress.pagesRemaining > 1 ? 's' : ''} sur {progress.pagesLimit}</span></p>
              </>
            ) : (
              <Loading />
            )}
          </div>
        </div>
        <button className="btn btn-big" onClick={() => go('/scan')}>📷 Scanner un cours</button>
      </Card>
      <Card title="Mes cours">
        {docs.loading && <Loading />}
        <ErrorBox message={docs.error} />
        {docs.data && docs.data.items.length === 0 && <p>Pas encore de cours. Scanne ta première page !</p>}
        <ul className="list">
          {docs.data?.items.map((d) => (
            <li key={`${d.scanId}-${d.docId ?? ''}`}>
              <a className="row-link" href={d.docId ? `#/doc/${encodeURIComponent(d.docId)}` : `#/job/${encodeURIComponent(d.scanId)}`}>
                <span className="grow"><strong>{d.title ?? (d.status.stage === 'echec' ? 'Cours sans titre' : 'Cours en lecture…')}</strong><br /><span className="muted">{d.status.stage === 'echec' ? <span className="pill pill-warn">Pas réussi</span> : d.subject && <span className={subjectClass(d.subject)}>{subjectLabel(d.subject)}</span>} {fmtDay(d.createdAt)}</span></span>
                <span aria-hidden="true">›</span>
              </a>
            </li>
          ))}
        </ul>
        <div className="btn-row" style={{ marginTop: '.6rem' }}>
          <a className="btn btn-small" href="#/docs">Tous mes cours</a>
          <a className="btn btn-small btn-ghost" href="#/folders">📁 Mes dossiers</a>
        </div>
      </Card>
    </>
  );
}

/** Scans a relire (GET /scans?status=a_confirmer): au chargement puis toutes les 60 s tant que l'onglet est visible. */
function useReview(): ScanSummary[] {
  const [items, setItems] = useState<ScanSummary[]>([]);
  useEffect(() => {
    let live = true;
    const load = () => {
      if (document.hidden) return;
      api.listScans({ status: 'a_confirmer', sort: 'date', order: 'asc', limit: 5 }).then((r) => live && setItems(r.toReview > 0 ? r.items : []), () => undefined);
    };
    load();
    const t = setInterval(load, 60000);
    document.addEventListener('visibilitychange', load);
    return () => { live = false; clearInterval(t); document.removeEventListener('visibilitychange', load); };
  }, []);
  return items;
}
