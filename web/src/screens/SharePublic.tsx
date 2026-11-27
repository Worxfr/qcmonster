import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { Rich } from '../components/Math';
import { subjectClass, subjectLabel, plural } from '../labels';
import { REASONS, ShareError, dayLabel, isCorrect, openShare, reportShare, takeShareToken, toPlay, type PlayQuestion } from '../share';
import type { ShareReportReason, SharedQuiz } from '../types';
import './share.css';

/**
 * Page publique d'un QCM partage (/p#t=<jeton>). Sans compte: ni Cognito, ni /me, ni stockage, ni cookie.
 * Le jeton vient du fragment, retire de l'URL des la lecture, et reste en memoire. Le texte est rendu par React (echappe), les formules par KaTeX
 * (`Rich`, memes filtres que le serveur). Aucun point: la correction se fait ici et rien n'est envoye.
 */
export function SharePublic() {
  const [token] = useState(takeShareToken);
  const [quiz, setQuiz] = useState<SharedQuiz | null>(null);
  const [state, setState] = useState<'loading' | 'ok' | 'gone' | 'error'>(token ? 'loading' : 'gone');
  useEffect(() => {
    document.title = 'QCM partagé · QCMonster';
    const m = document.createElement('meta');
    m.name = 'robots';
    m.content = 'noindex';
    document.head.append(m);
    return () => m.remove();
  }, []);
  useEffect(() => {
    if (!token) return;
    let live = true;
    openShare(token).then(
      (q) => live && (setQuiz(q), setState('ok')),
      (e) => live && setState(e instanceof ShareError && e.status === 404 ? 'gone' : 'error'),
    );
    return () => {
      live = false;
    };
  }, [token]);

  return (
    <>
      <header className="top"><span className="logo">QCMonster</span></header>
      <main className="page share-page" id="contenu">
        {state === 'loading' && <p role="status" className="muted">Ouverture du QCM…</p>}
        {state === 'gone' && (
          <section className="card share-gone">
            <h1>Ce QCM n'est pas disponible</h1>
            <p>Le lien a expiré, a été supprimé ou n'est pas complet. Demande à la personne qui te l'a envoyé de t'en donner un nouveau.</p>
            <p className="muted">Si tu as rechargé la page, rouvre le lien depuis le message où tu l'as reçu.</p>
          </section>
        )}
        {state === 'error' && (
          <section className="card share-gone" role="alert">
            <h1>Oups, ça n'a pas marché</h1>
            <p>Le QCM n'a pas pu s'ouvrir. Réessaie dans un moment, en rouvrant le lien.</p>
          </section>
        )}
        {state === 'ok' && quiz && token && <Run quiz={quiz} token={token} />}
      </main>
    </>
  );
}

function Run({ quiz, token }: { quiz: SharedQuiz; token: string }) {
  const qs = useMemo(() => toPlay(quiz.questions), [quiz]);
  const [i, setI] = useState(-1); // -1: accueil
  const [good, setGood] = useState(0);
  const [picked, setPicked] = useState<{ given: string | number; ok: boolean } | null>(null);
  const [gap, setGap] = useState('');
  const q = qs[i] as PlayQuestion | undefined;
  const finished = i >= qs.length;

  const answer = (given: string | number) => {
    if (!q || picked) return;
    const ok = isCorrect(q, given);
    if (ok) setGood((g) => g + 1);
    setPicked({ given, ok });
  };
  const next = () => {
    setPicked(null);
    setGap('');
    setI((n) => n + 1);
  };
  const restart = () => {
    setGood(0);
    setPicked(null);
    setGap('');
    setI(0);
  };

  return (
    <>
      <p className="share-banner" role="note">
        <span aria-hidden="true">👋</span> QCM partagé par un élève, <strong>non relu par un enseignant</strong>. Tu joues pour t'entraîner : aucun point, rien n'est enregistré.
      </p>
      {i === -1 && (
        <section className="card share-hero">
          <h1>{quiz.title}</h1>
          <p>
            {quiz.subject && <span className={subjectClass(quiz.subject)}>{subjectLabel(quiz.subject)}</span>}
            <span className="chip">{quiz.questions.length} questions</span>
            <span className="chip">Jusqu'au {dayLabel(quiz.expiresAt)}</span>
          </p>
          <button className="btn btn-big" onClick={() => setI(0)}>🎮 C'est parti !</button>
        </section>
      )}
      {q && (
        <section className="card" aria-labelledby="share-q">
          <div className="share-steps" role="progressbar" aria-label="Avancement" aria-valuemin={1} aria-valuemax={qs.length} aria-valuenow={i + 1}>
            {qs.map((_, k) => <span key={k} className={k < i ? 'done' : k === i ? 'now' : ''} />)}
          </div>
          <h2 id="share-q">Question {i + 1} sur {qs.length}</h2>
          <p className="prompt"><Rich text={q.prompt} /></p>
          {q.kind === 'qcm' ? (
            <ul className="choices">
              {q.choices.map((c, k) => {
                const mark = picked ? (k === q.answer ? 'right' : k === picked.given ? 'wrong' : '') : '';
                return (
                  <li key={k}>
                    <button className={`btn btn-choice ${mark}`} disabled={!!picked} onClick={() => answer(k)}><Rich text={c} /></button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <form className="stack" onSubmit={(e: FormEvent) => { e.preventDefault(); if (gap.trim()) answer(gap); }}>
              <label>Ta réponse
                <input value={gap} maxLength={300} autoComplete="off" disabled={!!picked} onChange={(e) => setGap(e.target.value)} />
              </label>
              <button className="btn" disabled={!!picked || !gap.trim()}>Valider</button>
            </form>
          )}
          {picked && (
            <div role="status" className={picked.ok ? 'feedback ok' : 'feedback ko'}>
              <p><strong>{picked.ok ? '✓ Bravo !' : '✗ Pas tout à fait.'}</strong></p>
              {!picked.ok && <p>La bonne réponse : <strong><Rich text={q.kind === 'qcm' ? q.choices[q.answer] : q.expected} /></strong></p>}
              <button className="btn" onClick={next}>{i + 1 < qs.length ? 'Suivant' : 'Terminer'}</button>
            </div>
          )}
        </section>
      )}
      {finished && (
        <section className="card share-hero">
          <h1>Bien joué !</h1>
          <p className="share-score" role="status"><strong>{good}</strong> bonne{good > 1 ? 's' : ''} {plural(good, 'réponse', 'réponses')} sur {qs.length}</p>
          <button className="btn" onClick={restart}>↻ Rejouer</button>
        </section>
      )}
      <Report token={token} />
    </>
  );
}

function Report({ token }: { token: string }) {
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState<ShareReportReason>('inapproprie');
  const [res, setRes] = useState<'idle' | 'busy' | 'sent' | 'gone' | 'error'>('idle');
  async function send(e: FormEvent) {
    e.preventDefault();
    setRes('busy');
    try {
      await reportShare(token, reason);
      setRes('sent');
    } catch (x) {
      setRes(x instanceof ShareError && x.status === 404 ? 'gone' : 'error');
    }
  }
  return (
    <section className="card share-report">
      {res === 'sent' ? (
        <p role="status" className="ok">✓ Merci, le signalement est envoyé. Tu peux continuer à jouer.</p>
      ) : res === 'gone' ? (
        <p role="status">Ce QCM n'est plus disponible : il a peut-être déjà été retiré.</p>
      ) : !open ? (
        <button className="link" onClick={() => setOpen(true)}>⚑ Signaler ce QCM</button>
      ) : (
        <form className="stack" onSubmit={send}>
          <fieldset>
            <legend>Pourquoi signaler ce QCM ?</legend>
            {REASONS.map((r) => (
              <label key={r.id} className="check">
                <input type="radio" name="reason" checked={reason === r.id} onChange={() => setReason(r.id)} /> {r.label}
              </label>
            ))}
          </fieldset>
          <p className="muted">Aucun message ni nom n'est envoyé, seulement le motif.</p>
          {res === 'error' && <p role="alert" className="error">Le signalement n'est pas parti. Réessaie.</p>}
          <span className="btn-row">
            <button className="btn btn-small" disabled={res === 'busy'}>Envoyer le signalement</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setOpen(false)}>Annuler</button>
          </span>
        </form>
      )}
    </section>
  );
}
