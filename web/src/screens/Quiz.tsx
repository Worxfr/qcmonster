import { useEffect, useRef, useState, type FormEvent } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { Card, ErrorBox, Loading } from '../components/ui';
import { badgeLabel } from '../game';
import { errMsg, useLoad } from '../hooks';
import { go } from '../router';
import type { AnswerResult } from '../types';

export function Quiz({ docId }: { docId: string }) {
  const { setProgress, addBadges } = useApp();
  const s = useLoad(() => api.session(docId), [docId]);
  const [i, setI] = useState(0);
  const [gap, setGap] = useState('');
  const [result, setResult] = useState<AnswerResult | null>(null);
  const [xp, setXp] = useState(0);
  const [good, setGood] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const feedbackRef = useRef<HTMLDivElement>(null);
  // B6: sur mobile, le retour (et son bouton « Suivant ») doit rester au-dessus de la barre du bas.
  useEffect(() => {
    if (result) feedbackRef.current?.scrollIntoView?.({ block: 'nearest', behavior: 'smooth' });
  }, [result]);

  if (s.loading) return <Loading />;
  if (!s.data) return <ErrorBox message={s.error} />;
  const qs = s.data.questions;
  const q = qs[i];

  if (!q) {
    return (
      <Card title="Bravo !">
        <p role="status">{good} bonne{good > 1 ? 's' : ''} réponse{good > 1 ? 's' : ''} sur {qs.length}, +{xp} XP.</p>
        <button className="btn" onClick={() => go('/jeu')}>Voir ma progression</button>
        <button className="btn btn-ghost" onClick={() => go(`/doc/${encodeURIComponent(docId)}`)}>Retour à la fiche</button>
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
      if (r.badges.length) addBadges(r.badges);
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const next = () => {
    setResult(null);
    setGap('');
    setI(i + 1);
  };

  return (
    <Card title={`Question ${i + 1} sur ${qs.length}`}>
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
          {result.badges.map((b) => <p key={b}>🏅 Nouveau badge : {badgeLabel(b)}</p>)}
          <button className="btn" onClick={next}>{i + 1 < qs.length ? 'Suivant' : 'Terminer'}</button>
        </div>
      )}
    </Card>
  );
}
