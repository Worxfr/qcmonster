import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { Rich } from '../components/Math';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import { plural } from '../labels';
import { LIMITS, dayLabel, shareUrl } from '../share';
import type { MyShare, ShareCreated, ShareableQuestion } from '../types';
import './share.css';

const WHY: Record<NonNullable<ShareableQuestion['reason']>, string> = {
  a_jouer: 'Réussis-la d’abord en t’entraînant',
  donnee_personnelle: 'Elle contient une donnée personnelle',
  retiree: 'Elle a été retirée après une correction du cours',
};

/** Message d'un refus du partage: `403` = le parent n'a pas active le partage (ou le compte est suspendu). */
export function shareError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 403) return 'Le partage est fermé pour ton compte. Demande à ton parent de l’activer.';
    if (e.code === 'titre_refuse') return 'Ce titre n’est pas accepté. Évite les noms, adresses, téléphones et mots interdits, et essaie un autre titre.';
    if (e.code === 'plafond_partages') return `Tu as déjà ${LIMITS.perStudent} liens actifs (ou tu as atteint la limite du jour). Supprime un lien ou reviens demain.`;
    if (e.code === 'questions_non_partageables') return 'Certaines questions ne sont plus partageables. Recharge la page et choisis-en d’autres.';
  }
  return errMsg(e);
}

const friendly = (e: unknown): never => {
  throw new Error(shareError(e));
};

/** Creer un lien depuis une fiche: 5 a 20 questions deja reussies, un titre, une duree. Le lien n'est montre qu'une fois. */
export function ShareCreate({ docId }: { docId: string }) {
  const list = useLoad(() => api.shareable(docId).catch(friendly), [docId]);
  const [picked, setPicked] = useState<string[]>([]);
  const [title, setTitle] = useState('');
  const [ttl, setTtl] = useState<number>(LIMITS.defaultTtl);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [made, setMade] = useState<(ShareCreated & { title: string }) | null>(null);
  const [copied, setCopied] = useState(false);

  if (list.loading) return <Loading />;
  if (!list.data) return <Card title="Partager des questions"><p role="alert" className="error">{list.error}</p><a className="link" href={`#/doc/${encodeURIComponent(docId)}`}>‹ Retour à la fiche</a></Card>;

  const qs = list.data.questions;
  const ok = qs.filter((q) => q.shareable);
  const toggle = (id: string) => setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length < LIMITS.max ? [...p, id] : p));
  const titleOk = title.trim().length >= LIMITS.titleMin && title.trim().length <= LIMITS.titleMax;
  const countOk = picked.length >= LIMITS.min && picked.length <= LIMITS.max;

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (busy || !titleOk || !countOk) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createShare({ docId, questionIds: picked, title: title.trim(), ttlDays: ttl as 1 | 7 | 30 });
      setMade({ ...r, title: title.trim() });
    } catch (x) {
      setError(shareError(x));
    } finally {
      setBusy(false);
    }
  }

  if (made) {
    const url = shareUrl(made.token);
    return (
      <>
        <Card title="Ton lien est prêt 🎉">
          <p>« {made.title} » est partagé jusqu’au <strong>{dayLabel(made.expiresAt)}</strong>.</p>
          <p><input readOnly aria-label="Lien à partager" value={url} onFocus={(e) => e.target.select()} /></p>
          <button className="btn" onClick={() => { void navigator.clipboard?.writeText(url); setCopied(true); }}>{copied ? '✓ Copié' : 'Copier le lien'}</button>
          <p className="notice">Copie-le maintenant : on ne peut pas te le montrer une deuxième fois. Pour partager à nouveau, crée un nouveau lien.</p>
          <p className="muted">Celui qui a le lien joue sans compte et ne gagne aucun point. Tu peux supprimer le lien quand tu veux.</p>
        </Card>
        <p className="btn-row"><a className="btn btn-ghost" href="#/partages">Mes liens</a><a className="btn btn-ghost" href={`#/doc/${encodeURIComponent(docId)}`}>Retour à la fiche</a></p>
      </>
    );
  }

  return (
    <>
      <p><a className="link" href={`#/doc/${encodeURIComponent(docId)}`}>‹ Retour à la fiche</a></p>
      <Card title="Partager des questions">
        <p>Choisis de {LIMITS.min} à {LIMITS.max} questions que tu as déjà réussies. Tu obtiens un lien : la personne qui l’ouvre s’entraîne sans compte, sans point.</p>
        {ok.length < LIMITS.min ? (
          <p className="notice">Il te faut au moins {LIMITS.min} questions réussies sur cette fiche pour la partager. Tu en as {ok.length}. Entraîne-toi encore un peu !</p>
        ) : (
          <form className="stack" onSubmit={submit}>
            <ul className="list share-pick" aria-label="Questions à partager">
              {qs.map((q) => (
                <li key={q.questionId} className={q.shareable ? '' : 'off'}>
                  <label className="check">
                    <input type="checkbox" disabled={!q.shareable || (!picked.includes(q.questionId) && picked.length >= LIMITS.max)} checked={picked.includes(q.questionId)} onChange={() => toggle(q.questionId)} />
                    <span className="grow">
                      {q.shareable ? <Rich text={q.prompt ?? ''} /> : <span className="muted">Question non partageable</span>}
                      {!q.shareable && q.reason && <small className="why">{WHY[q.reason]}</small>}
                    </span>
                  </label>
                </li>
              ))}
            </ul>
            <p className={countOk ? 'ok' : 'muted'} role="status">{picked.length} {plural(picked.length, 'question choisie', 'questions choisies')} (de {LIMITS.min} à {LIMITS.max})</p>
            <label>Titre du QCM (visible par ceux qui ont le lien)
              <input value={title} maxLength={LIMITS.titleMax} autoComplete="off" onChange={(e) => { setTitle(e.target.value); setError(null); }} aria-describedby="share-title-help" />
            </label>
            <p id="share-title-help" className="muted">De {LIMITS.titleMin} à {LIMITS.titleMax} caractères. Ni ton nom, ni adresse, ni numéro de téléphone.</p>
            <fieldset className="ttl">
              <legend>Le lien dure</legend>
              {LIMITS.ttl.map((d) => (
                <label key={d} className="check"><input type="radio" name="ttl" checked={ttl === d} onChange={() => setTtl(d)} /> {d} {plural(d, 'jour', 'jours')}{d === LIMITS.defaultTtl ? ' (conseillé)' : ''}</label>
              ))}
            </fieldset>
            <ErrorBox message={error} />
            <button className="btn btn-big" disabled={busy || !titleOk || !countOk}>{busy ? 'Un instant…' : '🔗 Créer le lien'}</button>
          </form>
        )}
      </Card>
    </>
  );
}

const state = (s: MyShare, now = Date.now()) => (s.state === 'suspendu' ? 'suspendu' : new Date(s.expiresAt).getTime() <= now ? 'expire' : 'actif');
export const stateLabel = (s: Pick<MyShare, 'state' | 'expiresAt'>) => {
  const k = state(s as MyShare);
  return k === 'suspendu' ? 'Suspendu (3 signalements)' : k === 'expire' ? 'Expiré' : 'Actif';
};
export const stateClass = (s: Pick<MyShare, 'state' | 'expiresAt'>) => (state(s as MyShare) === 'actif' ? 'pill pill-ok' : 'pill pill-warn');

/** Les liens de l'eleve: titre, dates, lectures, signalements; revocation immediate. Jamais le lien ni les questions. */
export function MyShares() {
  const l = useLoad(() => api.myShares().catch(friendly), []);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  if (l.loading) return <Loading />;
  if (!l.data) return <Card title="Mes liens"><p role="alert" className="error">{l.error}</p></Card>;

  async function revoke(s: MyShare) {
    if (!window.confirm(`Supprimer le lien « ${s.title} » ? Plus personne ne pourra l’ouvrir.`)) return;
    setBusy(s.shareId);
    setError(null);
    try {
      await api.deleteMyShare(s.shareId);
      l.reload();
    } catch (e) {
      setError(shareError(e));
    } finally {
      setBusy(null);
    }
  }

  return (
    <Card title="Mes liens de partage">
      <ErrorBox message={error} />
      {l.data.shares.length === 0 ? (
        <p className="muted">Tu n’as aucun lien. Ouvre une fiche et choisis « Partager des questions » pour en créer un.</p>
      ) : (
        <ul className="list">
          {l.data.shares.map((s) => (
            <li key={s.shareId} className="share-row">
              <div className="grow">
                <h3>{s.title}</h3>
                <p><span className={stateClass(s)}>{stateLabel(s)}</span> <span className="chip">{s.count} questions</span></p>
                <p className="muted">Créé le {dayLabel(s.createdAt)} · jusqu’au {dayLabel(s.expiresAt)} · {s.reads} {plural(s.reads, 'lecture', 'lectures')} · {s.reports} {plural(s.reports, 'signalement', 'signalements')}</p>
                {s.outdated && <p className="notice">La fiche a été corrigée depuis : refais un lien.</p>}
              </div>
              <button className="btn btn-small btn-ghost" disabled={busy === s.shareId} onClick={() => void revoke(s)}>Supprimer le lien</button>
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
