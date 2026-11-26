import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { Rich } from '../components/Math';
import { Card, ErrorBox, Loading } from '../components/ui';
import { AI_NOTICE, bilanOf, copieEndMessage, exoError, finaleStatus, stepStatus, triesText } from '../exo';
import { go } from '../router';
import type { Copie as CopieT, Exercice } from '../types';
import { usePoll } from '../usePoll';
import './exo.css';

/** Retour d'une copie: attente (interrogation toutes les 2 s, 3 minutes au plus), puis bilan, etapes, XP. */
export function Copie({ id }: { id: string }) {
  const { refreshProgress } = useApp();
  const [copie, setCopie] = useState<CopieT | null>(null);
  const [exo, setExo] = useState<Exercice | null>(null);
  const [error, setError] = useState<string | null>(null);
  const credited = useRef(false);

  const load = useCallback(async () => {
    try {
      const c = await api.copie(id);
      setCopie(c);
      setError(null);
      return c;
    } catch (e) {
      setError(exoError(e));
      return null;
    }
  }, [id]);
  useEffect(() => { setCopie(null); credited.current = false; void load(); }, [load]);

  const waiting = copie?.etat === 'en_correction';
  const { timedOut } = usePoll(async () => {
    const c = await load();
    return !!c && c.etat !== 'en_correction';
  }, waiting, id);

  const exoId = copie?.exoId;
  const done = copie?.etat === 'corrigee';
  useEffect(() => {
    if (!exoId || !done) return;
    api.exercice(exoId).then(setExo, () => undefined);
    if (!credited.current) { credited.current = true; void refreshProgress(); } // les points sont crédités à la première lecture
  }, [exoId, done, refreshProgress]);

  if (!copie) return error ? <><ErrorBox message={error} /><button className="btn" onClick={() => void load()}>Réessayer</button><a className="btn btn-ghost" href="#/docs">Mes cours</a></> : <Loading />;
  const back = `#/exercice/${encodeURIComponent(copie.exoId)}`;

  if (copie.etat === 'a_envoyer') {
    return <Card title="Ta copie"><p>Cette copie n'a pas encore été envoyée. Reprends-la en photo pour la rendre.</p><a className="btn" href={back}>Retour à l'exercice</a></Card>;
  }
  if (waiting) {
    return (
      <Card title="Je corrige ta copie">
        {timedOut ? (
          <>
            <p role="alert" className="error">La correction prend plus de temps que prévu. Reviens dans quelques minutes : ton retour sera là.</p>
            <button className="btn" onClick={() => void load()}>Vérifier maintenant</button>
          </>
        ) : (
          <div className="exo-wait-card" role="status">
            <p className="exo-wait-ico" aria-hidden="true">🧐</p>
            <p className="lead">Je lis ta copie, ça prend entre 10 et 40 secondes…</p>
            <div className="exo-dots" aria-hidden="true"><span /><span /><span /></div>
          </div>
        )}
        <a className="btn btn-ghost" href={back}>Retour à l'exercice</a>
      </Card>
    );
  }
  const end = copieEndMessage(copie);
  if (end) {
    return (
      <Card title={copie.etat === 'illisible' ? 'Je n\'arrive pas à lire' : 'Pas de correction cette fois'}>
        <p className={copie.etat === 'illisible' ? 'exo-illisible' : 'notice'} role="status">{end}</p>
        <a className="btn btn-big" href={back}>{copie.etat === 'illisible' ? '📷 Reprendre en photo' : 'Retour à l\'exercice'}</a>
      </Card>
    );
  }
  return <Retour copie={copie} exo={exo} back={back} />;
}

function Retour({ copie, exo, back }: { copie: CopieT; exo: Exercice | null; back: string }) {
  const [askSolution, setAskSolution] = useState(false);
  const [solution, setSolution] = useState<string | null>(null);
  const [askDelete, setAskDelete] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const left = exo?.copiesRestantes;
  const fin = copie.finale ? finaleStatus(copie.finale.statut) : null;

  async function showSolution() {
    setBusy(true);
    setMsg(null);
    try {
      setSolution((await api.exerciceSolution(copie.exoId)).solution);
      setAskSolution(false);
    } catch (e) {
      setMsg(exoError(e, 'solution'));
      setAskSolution(false);
    } finally {
      setBusy(false);
    }
  }
  async function remove() {
    setBusy(true);
    setMsg(null);
    try {
      await api.deleteCopie(copie.copieId);
      go(`/exercice/${encodeURIComponent(copie.exoId)}`);
    } catch (e) {
      setMsg(exoError(e, 'supprimer'));
      setAskDelete(false);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <p><a className="link" href={back}>‹ Retour à l'exercice</a></p>
      <Card>
        <h1 className="exo-title">Voilà ton retour !</h1>
        <p className="exo-bilan">{bilanOf(copie)}</p>
        {copie.xpGagne !== undefined && (
          <p><span className="chip">⭐ {copie.xpGagne > 0 ? `+${copie.xpGagne} points gagnés` : copie.solutionVue ? 'Pas de points : tu as vu la solution' : 'Pas de nouveaux points cette fois'}</span></p>
        )}
        {copie.badges && copie.badges.length > 0 && <p className="ok">🏅 Nouveau badge !</p>}
      </Card>

      <Card title="Étape par étape">
        <ol className="exo-steps" aria-label="Tes étapes">
          {(copie.etapes ?? []).map((s) => {
            const st = stepStatus(s.statut);
            return (
              <li key={s.id} className={`exo-step exo-s-${st.cls}`}>
                <p className="exo-step-head">
                  <span className="exo-step-label"><Rich text={s.libelle} /></span>
                  <span className={`exo-tag exo-tag-${st.cls}`}><span aria-hidden="true">{st.icon}</span> {st.label}</span>
                </p>
                {s.indice && <p className="exo-step-hint">💬 <Rich text={s.indice} /></p>}
              </li>
            );
          })}
          {copie.finale && fin && (
            <li className={`exo-step exo-final exo-s-${fin.cls}`}>
              <p className="exo-step-head">
                <span className="exo-step-label">Résultat final : <Rich text={copie.finale.libelle} /></span>
                <span className={`exo-tag exo-tag-${fin.cls}`}><span aria-hidden="true">{fin.icon}</span> {fin.label}</span>
              </p>
            </li>
          )}
        </ol>
        <p className="exo-ia" role="note">{AI_NOTICE}</p>
      </Card>

      <Card title="Et maintenant ?">
        {left !== undefined && <p className="muted">{triesText(left)}</p>}
        <div className="exo-actions">
          {left === undefined || left > 0
            ? <a className="btn btn-big" href={back}>🔁 Refaire et rendre à nouveau</a>
            : <p className="notice">Tu as utilisé tes 3 corrections. Regarde la solution pour comprendre.</p>}
          {solution === null && !askSolution && <button className="btn btn-ghost" onClick={() => (copie.solutionVue ? void showSolution() : setAskSolution(true))} disabled={busy}>Voir la solution</button>}
          {!askDelete && <button className="btn btn-ghost" onClick={() => setAskDelete(true)} disabled={busy}>Supprimer cette copie</button>}
        </div>
        {askSolution && (
          <div className="exo-warn" role="alertdialog" aria-label="Voir la solution ?">
            <p><strong>Attention :</strong> si tu regardes la solution, cet exercice ne te rapportera plus de points. Tu pourras quand même te faire corriger.</p>
            <button className="btn" onClick={showSolution} disabled={busy}>Oui, voir la solution</button>
            <button className="btn btn-ghost" onClick={() => setAskSolution(false)}>Non, pas encore</button>
          </div>
        )}
        {askDelete && (
          <div className="exo-warn" role="alertdialog" aria-label="Supprimer cette copie ?">
            <p>Ce retour sera effacé. Les points déjà gagnés restent à toi.</p>
            <button className="btn" onClick={remove} disabled={busy}>Oui, supprimer</button>
            <button className="btn btn-ghost" onClick={() => setAskDelete(false)}>Non, je la garde</button>
          </div>
        )}
        <ErrorBox message={msg} />
        {solution !== null && <div className="exo-solution" aria-label="Solution"><h3>La solution</h3><Rich text={solution} /></div>}
      </Card>
    </>
  );
}
