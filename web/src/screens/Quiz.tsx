import { useEffect, useRef, useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../app-context';
import { Card, ErrorBox, Loading } from '../components/ui';
import { badgeLabel } from '../game';
import { errMsg, useLoad } from '../hooks';
import { plural } from '../labels';
import { go } from '../router';
import type { AnswerResult, Question } from '../types';

/** Un tirage de questions (une fiche: `Session`; plusieurs fiches ou un dossier: `PracticeSession`). */
export interface Draw {
  questions: Question[];
  short?: boolean;
  available?: number;
}

export function Quiz({ docId, size }: { docId: string; size?: number }) {
  const s = useLoad(() => api.session(docId, size), [docId, size]);
  if (s.loading) return <Loading />;
  if (!s.data) return <ErrorBox message={s.error} />;
  return <QuizRun initial={s.data} reopen={() => api.session(docId, size)} multi={false} back={{ label: 'Retour à la fiche', path: `/doc/${encodeURIComponent(docId)}` }} />;
}

/**
 * Le test lui-meme. `reopen` rappelle le serveur pour un nouveau tirage: sur un 409 (le test a ete rouvert ailleurs ou a expire),
 * jamais en boucle. Une question dont la fiche a ete supprimee (404) est sautee.
 */
export function QuizRun({ initial, reopen, multi, back, notice }: { initial: Draw; reopen: () => Promise<Draw>; multi: boolean; back: { label: string; path: string }; notice?: string }) {
  const { setProgress, addBadges } = useApp();
  const [qs, setQs] = useState<Question[]>(initial.questions);
  const [short, setShort] = useState(initial.short === true);
  const [available, setAvailable] = useState(initial.available ?? initial.questions.length);
  const [i, setI] = useState(0);
  const [gap, setGap] = useState('');
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [xp, setXp] = useState(0);
  const [good, setGood] = useState(0);
  const [done, setDone] = useState(0);
  const [docs, setDocs] = useState<Set<string>>(new Set());
  const [capped, setCapped] = useState(false);
  const [info, setInfo] = useState<string | null>(notice ?? null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  // B6: sur mobile, le retour (et son bouton « Suivant ») doit rester au-dessus de la barre du bas.
  useEffect(() => {
    if (result) feedbackRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [result]);

  const q = qs[i];

  if (!q) {
    const seen = docs.size;
    return (
      <Card title="Bravo !">
        <p role="status">{good} bonne{good > 1 ? 's' : ''} réponse{good > 1 ? 's' : ''} sur {done}, +{xp} XP.</p>
        {multi && seen > 0 && <p>Tu as vu {seen} {plural(seen, 'fiche', 'fiches')}.</p>}
        {short && <p className="notice">Cette banque n'a que {available} {plural(available, 'question différente', 'questions différentes')}. Reviens quand tu auras scanné plus de pages.</p>}
        {capped && <p className="notice">Tu as gagné tous les points de cette fiche (50 sur 50). Tu peux continuer pour t'entraîner.</p>}
        <div className="btn-row">
          <button className="btn" onClick={() => go('/jeu')}>Voir ma progression</button>
          <button className="btn btn-ghost" onClick={() => go(back.path)}>{back.label}</button>
        </div>
      </Card>
    );
  }

  async function answer(choice: string) {
    if (busy || result || !choice.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.answer(q.questionId, choice);
      setResult(r);
      setProgress(r.progress);
      setXp((x) => x + r.xpGained);
      if (r.correct) setGood((g) => g + 1);
      if (r.capped) setCapped(true);
      if (r.badges.length) addBadges(r.badges);
    } catch (e) {
      if (e instanceof ApiError && e.status === 409) {
        // Le test a ete rouvert ailleurs (autre onglet) ou a expire: on reprend ici avec un nouveau tirage.
        try {
          const d = await reopen();
          setQs(d.questions);
          setShort(d.short === true);
          setAvailable(d.available ?? d.questions.length);
          setI(0);
          setGap('');
          setInfo('Ton test a été rouvert ailleurs, on reprend ici.');
        } catch (e2) {
          setError(errMsg(e2));
        }
      } else if (e instanceof ApiError && e.status === 404) {
        setInfo('Cette fiche n\'existe plus, on passe à la question suivante.');
        setGap('');
        setI((n) => n + 1);
      } else setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const next = () => {
    if (q.docId) setDocs((d) => new Set(d).add(q.docId as string));
    setDone((n) => n + 1);
    setResult(null);
    setGap('');
    setInfo(null);
    setI(i + 1);
  };

  return (
    <Card title={`Question ${i + 1} sur ${qs.length}`}>
      {info && <p className="notice" role="status">{info}</p>}
      {multi && q.docTitle && <p className="muted from-doc">📚 {q.docTitle}</p>}
      <p className="prompt">{q.prompt}</p>
      {q.kind === 'qcm' ? (
        <ul className="choices">
          {(q.choices ?? []).map((c) => (
            <li key={c}>
              <button className="btn btn-choice" disabled={busy || !!result} onClick={() => answer(c)}>{c}</button>
            </li>
          ))}
        </ul>
      ) : (
        <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); void answer(gap); }}>
          <label>Ta réponse
            <input value={gap} maxLength={300} autoComplete="off" disabled={!!result} onChange={(e) => setGap(e.target.value)} />
          </label>
          <button className="btn" disabled={busy || !!result}>Valider</button>
        </form>
      )}
      <ErrorBox message={error} />
      {result && (
        <div ref={feedbackRef} role="status" className={result.correct ? 'feedback ok' : 'feedback ko'}>
          <p><strong>{result.correct ? '✓ Bravo !' : '✗ Pas tout à fait.'}</strong> {result.xpGained > 0 && `+${result.xpGained} XP`}</p>
          {!result.correct && result.correctAnswer && <p>La bonne réponse : <strong>{result.correctAnswer}</strong></p>}
          {result.capped && <p>Tu as gagné tous les points de cette fiche (50 sur 50). Tu peux continuer pour t'entraîner.</p>}
          {result.badges.map((b) => <p key={b}>🏅 Nouveau badge : {badgeLabel(b)}</p>)}
          <button className="btn" onClick={next}>{i + 1 < qs.length ? 'Suivant' : 'Terminer'}</button>
        </div>
      )}
    </Card>
  );
}
