import { useState } from 'react';
import { api } from '../api';
import { Card, ErrorBox, Loading } from '../components/ui';
import { etatExercice, EXO_WAIT_MS, exoError, MAX_EXERCICES, XP_EXO_MAX } from '../exo';
import { useLoad } from '../hooks';
import { go } from '../router';
import { usePoll } from '../usePoll';
import './exo.css';

/** Liste des exercices d'une fiche (maths, physique-chimie). Creation: 202, puis on interroge GET /exercices/{id} toutes les 2 s. */
export function Exercices({ docId }: { docId: string }) {
  const doc = useLoad(() => api.doc(docId), [docId]);
  const list = useLoad(() => api.exercices(docId), [docId]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const items = list.data?.items ?? [];
  const waiting = items.filter((x) => x.etat === 'generation').map((x) => x.exoId);

  const { timedOut } = usePoll(async () => {
    const states = await Promise.all(waiting.map((id) => api.exercice(id).then((x) => x.etat)));
    if (states.some((s) => s !== 'generation')) list.reload();
    return states.every((s) => s !== 'generation');
  }, waiting.length > 0, waiting.join(','), EXO_WAIT_MS);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      await api.createExercice(docId);
      list.reload();
    } catch (e) {
      setError(exoError(e, 'creation'));
    } finally {
      setBusy(false);
    }
  }

  const full = items.length >= MAX_EXERCICES;
  return (
    <>
      <p><a className="link" href={`#/doc/${encodeURIComponent(docId)}`}>‹ Retour à la fiche</a></p>
      <Card title="Mes exercices">
        <p className="lead">{doc.data ? <>Des exercices pour t'entraîner sur « {doc.data.title} ».</> : 'Des exercices pour t\'entraîner à raisonner.'}</p>
        <p className="muted">Fais l'exercice sur ta feuille, prends ta copie en photo, et une IA te dit où tu en es. Chaque exercice rapporte jusqu'à {XP_EXO_MAX} points.</p>
        {list.loading && !list.data && <Loading />}
        {list.error && !list.data && <><ErrorBox message={list.error} /><button className="btn" onClick={list.reload}>Réessayer</button></>}
        {list.data && items.length === 0 && <p className="exo-empty">Tu n'as pas encore d'exercice pour cette fiche. Demande-en un !</p>}
        {items.length > 0 && (
          <ul className="exo-list" aria-label="Exercices de la fiche">
            {items.map((x, i) => {
              const st = etatExercice(x.etat);
              const ready = x.etat === 'prete';
              return (
                <li key={x.exoId} className={`exo-row exo-${x.etat}`}>
                  <span className="exo-ico" aria-hidden="true">{st.icon}</span>
                  <span className="grow">
                    <strong>{x.titre || `Exercice ${i + 1}`}</strong>
                    <span className="muted exo-sub">
                      {ready ? (x.solutionVue ? `${x.xpPaye} point${x.xpPaye > 1 ? 's' : ''} gagné${x.xpPaye > 1 ? 's' : ''} · solution vue` : `${x.xpPaye} point${x.xpPaye > 1 ? 's' : ''} sur ${x.points}`) : st.label}
                    </span>
                  </span>
                  {ready && <a className="btn btn-small" href={`#/exercice/${encodeURIComponent(x.exoId)}`}>Ouvrir<span className="sr-only"> {x.titre ?? `l'exercice ${i + 1}`}</span></a>}
                </li>
              );
            })}
          </ul>
        )}
        {waiting.length > 0 && !timedOut && <p role="status" className="exo-wait">⏳ Je prépare ton exercice, ça prend quelques secondes…</p>}
        {timedOut && <p role="alert" className="error">Ça prend plus de temps que prévu. Reviens dans un moment, ton exercice sera peut-être prêt.</p>}
        <ErrorBox message={error} />
        {full ? <p className="muted">Tu as déjà {MAX_EXERCICES} exercices sur cette fiche : c'est le maximum.</p> : (
          <button className="btn btn-big" onClick={create} disabled={busy || waiting.length > 0} aria-busy={busy}>
            {busy ? 'Un instant…' : '✨ Un nouvel exercice'}
          </button>
        )}
        <button className="btn btn-ghost" onClick={() => go(`/doc/${encodeURIComponent(docId)}`)}>Retour à la fiche</button>
      </Card>
    </>
  );
}
