import { useCallback, useEffect, useState } from 'react';
import { ApiError, api } from '../api';
import { useApp } from '../app-context';
import { ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { fmtDay, plural, stageLabel, subjectLabel, timeLeft } from '../labels';
import { go } from '../router';
import type { ScanSummary } from '../types';

/**
 * Scans pas menes au bout: en cours, a relire, rates ou expires (les fiches terminees sont dans Mes cours).
 * L'eleve peut en supprimer un a tout moment (confirmation avant). Interroge GET /scans toutes les 3 s tant qu'un scan est en cours.
 */
export function MyScans() {
  const { refreshProgress } = useApp();
  const [items, setItems] = useState<ScanSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [asking, setAsking] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [delay, setDelay] = useState(3000);

  const load = useCallback(async () => {
    try {
      const [run, failed] = await Promise.all([api.listScans({ status: 'en_cours', sort: 'date', order: 'desc', limit: 50 }), api.listScans({ status: 'echec', sort: 'date', order: 'desc', limit: 50 })]);
      const review = (s: ScanSummary) => Number(s.status.stage === 'a_confirmer');
      setItems([...[...run.items].sort((a, b) => review(b) - review(a) || (a.status.expiresAt ?? 'z').localeCompare(b.status.expiresAt ?? 'z')), ...failed.items]);
      setError(null);
      setDelay(3000);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setDelay((d) => Math.min(12000, d * 2)); // limite de debit: on ralentit sans message
      else setError(errMsg(e));
    }
  }, []);

  const active = items === null || items.some((s) => s.status.stage !== 'echec');
  useEffect(() => {
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      if (stopped) return;
      if (!document.hidden) await load();
      if (!stopped && active) t = setTimeout(tick, delay);
    };
    void tick();
    const vis = () => { if (!stopped && !document.hidden) void load(); };
    document.addEventListener('visibilitychange', vis);
    return () => { stopped = true; clearTimeout(t); document.removeEventListener('visibilitychange', vis); };
  }, [load, active, delay]);

  async function remove(id: string) {
    setBusy(true);
    try {
      await api.deleteScan(id);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 404)) { setError(errMsg(e)); setBusy(false); return; } // 404: deja supprime ailleurs
    }
    setItems((l) => (l ?? []).filter((s) => s.scanId !== id));
    setAsking(null);
    setBusy(false);
    void refreshProgress(); // les pages rendues se voient tout de suite
    void load();
  }

  if (!items?.length && !error) return null;
  return (
    <section className="card running" aria-label="Mes scans en cours">
      <h2>⏳ Mes scans</h2>
      <p className="muted">Ces scans ne sont pas encore des cours. Tu peux en supprimer un quand tu veux : ta photo est effacée et tes pages te sont rendues.</p>
      <ErrorBox message={error} />
      <ul className="list">
        {(items ?? []).map((s) => {
          const review = s.status.stage === 'a_confirmer';
          const failed = s.status.stage === 'echec';
          const canDelete = failed || ['envoi', 'lecture', 'a_confirmer'].includes(s.status.stage); // confirme: la fiche se prepare, on ne l'arrete plus
          const left = timeLeft(s.status.expiresAt);
          const name = s.title ?? s.topic ?? (s.subject ? subjectLabel(s.subject) : `Scan du ${fmtDay(s.createdAt)}`);
          return (
            <li key={s.scanId} className={`run-row scan-run${review && s.status.expiresSoon ? ' soon' : ''}`}>
              <span className="grow">
                <strong>{name}</strong><br />
                <span className="muted">
                  {failed ? 'Pas réussi' : review ? `À relire${left ? ` · ${left}` : ''}` : stageLabel(s.status.stage)} · {s.status.pagesDone} sur {s.status.pagesTotal} {plural(s.status.pagesTotal, 'page', 'pages')}
                </span>
                {failed && s.status.message && <><br /><span className="scan-fail">{s.status.message}</span></>}
                {canDelete && asking === s.scanId && (
                  <span role="group" aria-label="Confirmer la suppression" className="calm cancel-ask" style={{ display: 'block', marginTop: '.5rem' }}>
                    <strong>Supprimer ce scan ?</strong> La photo et le texte lu sont effacés{failed ? '' : ', tes pages te sont rendues'}.
                    <span className="btn-row" style={{ display: 'flex', marginTop: '.4rem' }}>
                      <button type="button" className="btn btn-small btn-danger" onClick={() => remove(s.scanId)} disabled={busy} autoFocus>Oui, supprimer</button>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setAsking(null)} disabled={busy}>Non, garder</button>
                    </span>
                  </span>
                )}
              </span>
              {!(canDelete && asking === s.scanId) && (
                <span className="btn-row" style={{ display: 'flex', gap: '.4rem' }}>
                  {review && <button type="button" className="btn btn-small" onClick={() => go(`/job/${encodeURIComponent(s.scanId)}`)}>Vérifier<span className="sr-only"> le scan</span></button>}
                  {!review && !failed && <button type="button" className="btn btn-small btn-ghost" onClick={() => go(`/job/${encodeURIComponent(s.scanId)}`)}>Suivre<span className="sr-only"> le scan</span></button>}
                  {canDelete && <button type="button" className="btn btn-small btn-ghost" onClick={() => setAsking(s.scanId)}>🗑 Supprimer<span className="sr-only"> ce scan</span></button>}
                </span>
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}
