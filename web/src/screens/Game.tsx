import { api } from '../api';
import { useApp } from '../app-context';
import { Mascot } from '../components/Mascot';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { BADGES, STAGES, badgeLabel, levelProgress } from '../game';
import { useLoad } from '../hooks';

export function Game() {
  const { progress, earnedBadges, me } = useApp();
  const lb = useLoad(() => api.leaderboard(), []);
  if (!progress) return <Loading />;
  const lp = levelProgress(progress.xp, progress.level);
  const owned = Array.from(new Set([...(progress.badges ?? []), ...earnedBadges]));
  return (
    <>
      <Card>
        <div className="hero-row">
          <Mascot stage={progress.stage} size={140} />
          <div className="grow">
            <h1>Niveau {progress.level}</h1>
            <p>{progress.xp} XP</p>
            <Bar pct={lp.pct} label="Progression vers le niveau suivant" />
            <p className="muted">Encore {lp.remaining} XP pour le niveau {progress.level + 1}.</p>
            <p><span className="chip">🔥 Série : {progress.streakDays} j</span> <span className="chip">🧊 Gels : {progress.freezes}</span></p>
            <p className="muted" id="streak-rule">Un jour compte dans ta série dès que tu gagnes 30 XP dans la journée. Un gel 🧊 sauve ta série si tu rates un jour (tu en reçois 2 par mois, et tu peux en garder 2 au maximum).</p>
          </div>
        </div>
      </Card>
      <Card title="Les stades du monstre">
        <ol className="stages">
          {STAGES.map((s) => (
            <li key={s.stage} aria-current={s.stage === progress.stage ? 'true' : undefined} className={s.stage === progress.stage ? 'on' : s.stage > progress.stage ? 'locked' : ''}>
              <Mascot stage={s.stage} size={64} label={false} />
              <span>{s.name}<br /><span className="muted">{s.levels}</span></span>
            </li>
          ))}
        </ol>
      </Card>
      <Card title={`Mes badges (${owned.length})`}>
        <ul className="badges">
          {owned.map((id) => <li key={id} className="got"><span aria-hidden="true">{BADGES.find((b) => b.id === id)?.icon ?? '🏅'}</span> {badgeLabel(id)}</li>)}
          {BADGES.filter((b) => !owned.includes(b.id)).map((b) => (
            <li key={b.id} className="todo"><span aria-hidden="true">🔒</span> {b.label}<span className="sr-only"> : à gagner</span> <span className="muted">· {b.hint}</span></li>
          ))}
        </ul>
      </Card>
      <Card title={`Classement de la famille${lb.data ? ` · ${lb.data.week}` : ''}`}>
        {lb.loading && <Loading />}
        <ErrorBox message={lb.error} />
        {lb.data && (
          <ol className="board">
            {[...lb.data.entries].sort((a, b) => b.xp - a.xp).map((e, i) => (
              <li key={e.studentId} className={e.studentId === me.studentId ? 'me' : ''}>
                <span className="rank">{i + 1}</span>
                <span className="grow">{e.pseudo}<br /><span className="muted">{e.activeDays} jour{e.activeDays > 1 ? 's' : ''} actif{e.activeDays > 1 ? 's' : ''}</span></span>
                <strong>{e.xp} XP</strong>
              </li>
            ))}
          </ol>
        )}
      </Card>
    </>
  );
}
