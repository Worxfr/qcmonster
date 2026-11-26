import { api } from '../api';
import { Mascot } from '../components/Mascot';
import { ScoreBadge, TestList } from '../components/TestList';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { toneOf, fmtWhen, KIND_LABEL, lineLabel, modeLabel, verdict } from '../history';
import { useLoad } from '../hooks';
import { plural, stageLabel, subjectClass, subjectLabel } from '../labels';
import type { ScanStage } from '../types';

const back = <p><a className="link" href="#/">‹ Tableau de bord</a></p>;
const weekNo = (w: string) => w.split('-W')[1] ?? w;

/** Vue parent, lecture seule: avancement d'un élève. Jamais de texte de question ni de réponse de l'élève. */
export function Suivi({ sid }: { sid: string }) {
  const d = useLoad(() => api.studentProgress(sid), [sid]);
  if (d.loading) return <Loading />;
  if (!d.data) return (<>{back}<ErrorBox message={d.error} /></>);
  const { student: s, progress: p, docs, scans, weeks, subjects } = d.data;
  const maxTests = Math.max(1, ...weeks.map((w) => w.tests));
  return (
    <>
      {back}
      <Card>
        <div className="hero-row">
          <Mascot stage={p.stage} size={96} label={false} />
          <div className="grow">
            <h1>Suivi de {s.displayName}</h1>
            <p className="muted">Niveau {p.level} · {p.xp} XP · série de {p.streakDays} jour{p.streakDays > 1 ? 's' : ''} · {s.schoolLevel}</p>
            <p className="muted">Lecture seule : tu vois les résultats, pas le texte des questions ni les réponses de {s.displayName}.</p>
          </div>
        </div>
      </Card>

      <Card title="Les 12 dernières semaines">
        {weeks.length === 0 ? <p className="empty-tests">Pas encore de test sur cette période.</p> : (
          <ol className="weeks" aria-label="Score moyen par semaine">
            {weeks.map((w) => (
              <li key={w.week}>
                <span className="week-bar" aria-hidden="true"><span className={`week-fill tone-${toneOf(w.avgScorePct)}`} style={{ height: `${Math.max(6, w.avgScorePct)}%`, opacity: 0.55 + 0.45 * (w.tests / maxTests) }} /></span>
                <span className="week-pct" aria-hidden="true">{w.avgScorePct}%</span>
                <span className="week-no" aria-hidden="true">S{weekNo(w.week)}</span>
                <span className="sr-only">Semaine {weekNo(w.week)} : {w.tests} {plural(w.tests, 'test', 'tests')}, moyenne {w.avgScorePct} %, {w.activeDays} {plural(w.activeDays, 'jour actif', 'jours actifs')}</span>
              </li>
            ))}
          </ol>
        )}
      </Card>

      {subjects.length > 0 && (
        <Card title="Par matière">
          <ul className="list">
            {[...subjects].sort((a, b) => a.avgScorePct - b.avgScorePct).map((m) => (
              <li key={m.matiere} className="subj-row">
                <span className={subjectClass(m.matiere)}>{subjectLabel(m.matiere) || 'Autre'}</span>
                <span className="grow"><Bar pct={m.avgScorePct} label={`Score moyen en ${subjectLabel(m.matiere)}`} /></span>
                <strong>{m.avgScorePct} %</strong>
                <span className="muted">{m.tests} {plural(m.tests, 'test', 'tests')}</span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {docs.length > 0 && (
        <Card title="Les fiches">
          <ul className="list">
            {docs.map((x) => (
              <li key={x.docId} className="fiche-card">
                <span className="grow">
                  <strong>{x.titre}</strong>
                  <span className="test-meta"><span className={subjectClass(x.matiere)}>{subjectLabel(x.matiere) || 'Autre'}</span><span>{x.pages} {plural(x.pages, 'page', 'pages')}</span></span>
                </span>
                <span className="fiche-score">
                  {x.tests > 0 ? <><strong>{x.lastScorePct ?? '–'} %</strong><span className="muted">meilleur {x.bestScorePct ?? '–'} % · {x.tests} {plural(x.tests, 'test', 'tests')}</span></> : <span className="muted">Pas encore testée</span>}
                </span>
              </li>
            ))}
          </ul>
        </Card>
      )}

      {scans.length > 0 && (
        <Card title="Scans en cours">
          <ul className="list">
            {scans.map((x) => <li key={x.scanId} className="soft">{x.pages} {plural(x.pages, 'page', 'pages')} · <strong>{stageLabel(x.stage as ScanStage)}</strong></li>)}
          </ul>
        </Card>
      )}

      <Card title="Tous les tests">
        <TestList
          load={(q) => api.studentTests(sid, q)}
          href={(t) => `#/suivi/${encodeURIComponent(sid)}/${encodeURIComponent(t.testId)}`}
          empty={`${s.displayName} n'a pas encore fait de test. Les résultats apparaîtront ici dès le premier.`}
        />
      </Card>
    </>
  );
}

/** Résultat d'un passage, question par question: juste ou faux seulement (décision P4). */
export function SuiviTest({ sid, testId }: { sid: string; testId: string }) {
  const d = useLoad(() => api.studentTest(sid, testId), [sid, testId]);
  const to = `#/suivi/${encodeURIComponent(sid)}`;
  if (d.loading) return <Loading />;
  if (!d.data) return (<><p><a className="link" href={to}>‹ Suivi</a></p><ErrorBox message={d.error} /></>);
  const t = d.data;
  return (
    <>
      <p><a className="link" href={to}>‹ Suivi</a></p>
      <Card>
        <div className="hero-row">
          <ScoreBadge pct={t.scorePct} size="l" />
          <div className="grow">
            <h1 className="test-h1">{t.titre}</h1>
            <p className="test-meta"><span className={subjectClass(t.matiere)}>{subjectLabel(t.matiere) || 'Autre'}</span><span>{modeLabel(t.mode)}</span></p>
            <p className="muted">{fmtWhen(t.startedAt)}</p>
          </div>
        </div>
        <p>
          <span className="chip">✅ {t.correct} juste{t.correct > 1 ? 's' : ''} sur {t.total}</span>
          <span className="chip">⚡ {t.firstTry} du premier coup</span>
          <span className="chip">⭐ {t.xpGained} XP</span>
        </p>
        {t.status === 'incomplet' && <p className="notice">Test pas fini : {t.answered} question{t.answered > 1 ? 's' : ''} sur {t.total}.</p>}
      </Card>
      <Card title="Résultat par question">
        <ol className="q-list">
          {t.questions.map((q) => {
            const v = verdict(q);
            return (
              <li key={q.questionId} className={`q-card q-row ${q.correct ? 'q-ok' : 'q-ko'}`}>
                <span className="q-num">{lineLabel(q)}</span>
                <span className="muted">{KIND_LABEL[q.kind] ?? ''}</span>
                <span className={`pill ${v.cls}`}><span aria-hidden="true">{v.icon}</span> {v.text}</span>
                <span className="muted">{q.xpGained} XP</span>
              </li>
            );
          })}
        </ol>
        <p className="muted">Le texte des questions et les réponses de l'élève restent privés : seul l'élève les voit dans son application.</p>
      </Card>
    </>
  );
}
