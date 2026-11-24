import { api } from '../api';
import { useApp } from '../app-context';
import { Mascot } from '../components/Mascot';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { levelProgress, stageName } from '../game';
import { useLoad } from '../hooks';
import { go } from '../router';

const SUBJECTS: Record<string, string> = {
  maths: 'Maths', physique: 'Physique-chimie', svt: 'SVT', histoire_geo: 'Histoire-géo', francais: 'Français', autre: 'Autre',
};
const fmtDate = (iso: string) => new Date(iso).toLocaleDateString('fr-FR', { day: 'numeric', month: 'long' });

export function Home() {
  const { me, progress } = useApp();
  const docs = useLoad(() => api.docs(), []);
  const lp = progress ? levelProgress(progress.xp, progress.level) : null;
  return (
    <>
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
                <p><span className="chip">🔥 {progress.streakDays} jour{progress.streakDays > 1 ? 's' : ''} de suite</span> <span className="chip">📄 {progress.pagesRemaining}/{progress.pagesLimit} pages</span></p>
              </>
            ) : (
              <Loading />
            )}
          </div>
        </div>
        <button className="btn btn-big" onClick={() => go('/scan')}>📷 Scanner un cours</button>
      </Card>
      <Card title="Mes fiches">
        {docs.loading && <Loading />}
        <ErrorBox message={docs.error} />
        {docs.data && docs.data.items.length === 0 && <p>Pas encore de fiche. Scanne ta première page !</p>}
        <ul className="list">
          {docs.data?.items.map((d) => (
            <li key={d.docId}>
              <a className="row-link" href={`#/doc/${encodeURIComponent(d.docId)}`}>
                <span className="grow"><strong>{d.title}</strong><br /><span className="muted">{SUBJECTS[d.subject] ?? d.subject} · {fmtDate(d.createdAt)}</span></span>
                <span aria-hidden="true">›</span>
              </a>
            </li>
          ))}
        </ul>
      </Card>
    </>
  );
}
