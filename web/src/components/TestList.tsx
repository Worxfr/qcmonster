import { useEffect, useRef, useState } from 'react';
import { ErrorBox, Loading } from './ui';
import { errMsg } from '../hooks';
import { fmtShort, groupByYear, modeLabel, toneOf, yearLabel } from '../history';
import { plural, subjectClass, subjectLabel } from '../labels';
import type { TestPage, TestQuery, TestSummary } from '../types';

const PAGE = 20;

export function ScoreBadge({ pct, size = 'm' }: { pct: number; size?: 'm' | 'l' }) {
  return (
    <span className={`score score-${toneOf(pct)} score-${size}`} style={{ ['--p' as string]: `${pct}%` }}>
      <span className="score-in"><strong>{pct}</strong><small aria-hidden="true">%</small><span className="sr-only"> pour cent</span></span>
    </span>
  );
}

/** Liste paginée des passages, regroupée par année scolaire, avec filtre par année. Commune à l'élève et au parent. */
export function TestList({ load, href, empty }: { load: (q: TestQuery) => Promise<TestPage>; href: (t: TestSummary) => string; empty: string }) {
  const [year, setYear] = useState('');
  const [years, setYears] = useState<string[]>([]);
  const [items, setItems] = useState<TestSummary[]>([]);
  const [next, setNext] = useState<string | undefined>();
  const [state, setState] = useState<'loading' | 'ready'>('loading');
  const [more, setMore] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    const n = ++seq.current;
    setState('loading');
    setError(null);
    loadRef.current({ limit: PAGE, ...(year ? { schoolYear: year } : {}) }).then(
      (p) => {
        if (n !== seq.current) return;
        setItems(p.items);
        setNext(p.nextCursor);
        if (!year && p.schoolYears) setYears(p.schoolYears);
        setState('ready');
      },
      (e) => {
        if (n !== seq.current) return;
        setError(errMsg(e));
        setState('ready');
      },
    );
  }, [year]);

  async function loadMore() {
    if (!next) return;
    const n = seq.current;
    setMore(true);
    setError(null);
    try {
      const p = await loadRef.current({ limit: PAGE, cursor: next, ...(year ? { schoolYear: year } : {}) });
      if (n !== seq.current) return;
      setItems((cur) => [...cur, ...p.items]);
      setNext(p.nextCursor);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setMore(false);
    }
  }

  return (
    <div className="stack">
      {years.length > 1 && (
        <div role="group" aria-label="Année scolaire" className="year-chips">
          {['', ...years].map((y) => (
            <button key={y || 'all'} type="button" className={`year-chip${year === y ? ' on' : ''}`} aria-pressed={year === y} onClick={() => setYear(y)}>
              {y ? y.replace('-', ' - ') : 'Toutes'}
            </button>
          ))}
        </div>
      )}
      <ErrorBox message={error} />
      {state === 'loading' && <Loading />}
      {state === 'ready' && !error && items.length === 0 && <p className="empty-tests">{empty}</p>}
      {groupByYear(items).map((g) => (
        <section key={g.year} aria-labelledby={`y-${g.year}`}>
          <h3 id={`y-${g.year}`} className="year-title">{yearLabel(g.year)} <span className="muted">· {g.items.length}{next && !year ? '+' : ''} {plural(g.items.length, 'test', 'tests')}</span></h3>
          <ul className="list">
            {g.items.map((t) => (
              <li key={t.testId}>
                <a className="test-row" href={href(t)}>
                  <ScoreBadge pct={t.scorePct} />
                  <span className="grow">
                    <strong className="test-title">{t.titre}</strong>
                    <span className="test-meta">
                      <span className={subjectClass(t.matiere)}>{subjectLabel(t.matiere) || 'Autre'}</span>
                      <span>{fmtShort(t.startedAt)}</span>
                      <span>{modeLabel(t.mode)}</span>
                    </span>
                    <span className="test-meta">
                      <span>{t.correct} juste{t.correct > 1 ? 's' : ''} sur {t.total}</span>
                      {t.status === 'incomplet' && <span className="pill pill-warn">Pas fini : {t.answered} sur {t.total}</span>}
                    </span>
                  </span>
                  <span className="chev" aria-hidden="true">›</span>
                </a>
              </li>
            ))}
          </ul>
        </section>
      ))}
      {next && (
        <button type="button" className="btn btn-ghost" disabled={more} onClick={() => void loadMore()}>{more ? 'Chargement…' : 'Voir les tests plus anciens'}</button>
      )}
    </div>
  );
}
