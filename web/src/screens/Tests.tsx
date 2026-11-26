import { api } from '../api';
import { ScoreBadge, TestList } from '../components/TestList';
import { Card, ErrorBox, Loading } from '../components/ui';
import { encouragement, fmtWhen, KIND_LABEL, lineLabel, modeLabel, verdict } from '../history';
import { useLoad } from '../hooks';
import { subjectClass, subjectLabel } from '../labels';
import type { TestDetail } from '../types';

/** Écran « Mes tests » (élève): historique par année scolaire. */
export function Tests() {
  return (
    <>
      <Card>
        <h1>📝 Mes tests</h1>
        <p className="lead">Tous tes tests, du plus récent au plus ancien. Touche un test pour revoir tes réponses.</p>
      </Card>
      <Card>
        <TestList
          load={(q) => api.myTests(q)}
          href={(t) => `#/tests/${encodeURIComponent(t.testId)}`}
          empty="Tu n'as pas encore fait de test. Ouvre une de tes fiches et réponds aux questions : ton premier test apparaîtra ici !"
        />
      </Card>
    </>
  );
}

type Question = TestDetail['questions'][number];

/** Détail d'un passage: ses questions, ce qu'il a répondu et la bonne réponse. */
export function TestDetailView({ id }: { id: string }) {
  const d = useLoad(() => api.myTest(id), [id]);
  if (d.loading) return <Loading />;
  if (!d.data) return (<><p><a className="link" href="#/tests">‹ Mes tests</a></p><ErrorBox message={d.error} /></>);
  const t = d.data;
  return (
    <>
      <p><a className="link" href="#/tests">‹ Mes tests</a></p>
      <Card>
        <div className="hero-row">
          <ScoreBadge pct={t.scorePct} size="l" />
          <div className="grow">
            <h1 className="test-h1">{t.titre}</h1>
            <p className="test-meta"><span className={subjectClass(t.matiere)}>{subjectLabel(t.matiere) || 'Autre'}</span><span>{modeLabel(t.mode)}</span></p>
            <p className="muted">{fmtWhen(t.startedAt)}</p>
          </div>
        </div>
        <p className="lead">{encouragement(t.scorePct)}</p>
        <p>
          <span className="chip">✅ {t.correct} juste{t.correct > 1 ? 's' : ''} sur {t.total}</span>
          <span className="chip">⚡ {t.firstTry} du premier coup</span>
          <span className="chip">⭐ {t.xpGained} XP</span>
        </p>
        {t.status === 'incomplet' && <p className="notice">Test pas fini : {t.answered} question{t.answered > 1 ? 's' : ''} sur {t.total}. Tu peux le reprendre quand tu veux.</p>}
      </Card>
      <Card title="Tes réponses">
        {t.questions.length === 0 && <p>Aucune réponse enregistrée pour ce test.</p>}
        <ol className="q-list">
          {t.questions.map((q) => <QuestionCard key={q.questionId} q={q} />)}
        </ol>
      </Card>
    </>
  );
}

function QuestionCard({ q }: { q: Question }) {
  const v = verdict(q);
  const done = q.correctAnswer !== undefined;
  return (
    <li className={`q-card ${q.correct ? 'q-ok' : 'q-ko'}`}>
      <p className="q-head">
        <span className="q-num">{lineLabel(q)}</span>
        <span className="muted">{KIND_LABEL[q.kind] ?? ''}</span>
        <span className={`pill ${v.cls}`}><span aria-hidden="true">{v.icon}</span> {v.text}</span>
        {q.kind === 'exo' && <span className="muted">{q.xpGained} XP</span>}
      </p>
      {q.kind !== 'exo' && <p className="prompt">{q.prompt ?? "Cette question n'existe plus dans la fiche."}</p>}
      {q.choices && q.choices.length > 0 ? (
        <ul className="q-choices" aria-label="Les choix">
          {q.choices.map((c) => {
            const mine = c === q.choice;
            const right = done && c === q.correctAnswer;
            return (
              <li key={c} className={`${mine ? 'mine' : ''} ${right ? 'right' : ''}`}>
                <span>{c}</span>
                {mine && <span className="tag">Ta réponse</span>}
                {right && <span className="tag tag-ok">Bonne réponse</span>}
              </li>
            );
          })}
        </ul>
      ) : (
        <dl className="q-answers">
          {q.choice !== undefined && <><dt>Ta réponse</dt><dd className={q.correct ? 'ok' : 'warn-text'}>{q.choice || '(vide)'}</dd></>}
          {done && !q.correct && <><dt>Bonne réponse</dt><dd className="ok">{q.correctAnswer}</dd></>}
        </dl>
      )}
    </li>
  );
}
