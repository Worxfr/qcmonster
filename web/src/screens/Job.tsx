import { useCallback, useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useApp } from '../app-context';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { JOB_FINAL } from '../game';
import { errMsg } from '../hooks';
import { STAGES, failKind, fmtElapsed, fmtTime, stageIndex, subjectClass, subjectLabel, timeLeft, plural } from '../labels';
import { go } from '../router';
import type { Doc, Job, ScanStage } from '../types';
import { ConfirmView } from './confirm/ConfirmView';
import { clearEdits } from './confirm/storage';

const STAGE_OF: Record<string, ScanStage> = {
  en_attente_envoi: 'envoi', verification_fichier: 'lecture', transcription: 'lecture', a_confirmer: 'a_confirmer',
  verification: 'fiche', generation: 'qcm', termine: 'termine', rejete: 'echec', echec: 'echec', expire: 'echec',
};
const POLL_MS = 2500;
const POLL_ERR_MS = 5000;

/** Interroge GET /jobs/{id} tant que le scan n'est pas fini; s'arrete quand l'onglet est cache. */
function useJob(id: string) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const tickRef = useRef<() => void>(() => undefined);

  useEffect(() => {
    let live = true;
    let inFlight = false; // propre a ce montage (le mode strict remonte l'effet)
    const tick = async () => {
      clearTimeout(timer.current);
      if (document.hidden || inFlight) return; // reprise au retour sur l'onglet; une seule requete a la fois
      inFlight = true;
      let delay = POLL_MS;
      try {
        const j = await api.job(id);
        inFlight = false;
        if (!live) return;
        setJob(j);
        setError(null);
        if (JOB_FINAL.includes(j.state)) return;
      } catch (e) {
        inFlight = false;
        if (!live) return;
        setError(errMsg(e));
        delay = POLL_ERR_MS;
      }
      timer.current = setTimeout(tick, delay);
    };
    tickRef.current = tick;
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    void tick();
    return () => {
      live = false;
      clearTimeout(timer.current);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [id]);
  const again = useCallback(() => tickRef.current(), []);
  return { job, setJob, error, setError, again };
}

/** Chaque composant porte sa propre horloge: l'ecran de relecture n'est pas re-rendu a chaque seconde. */
function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

function TimeLeft({ expiresAt, soon }: { expiresAt?: string; soon?: boolean }) {
  const now = useNow(30000);
  const left = timeLeft(expiresAt, now);
  if (!left) return null;
  return (
    <p className={`review-time${soon ? ' soon' : ''}`} role="status">
      <span aria-hidden="true">{soon ? '⏳' : '🕒'}</span> {left} pour relire
    </p>
  );
}

function Elapsed({ since }: { since: string }) {
  const now = useNow(1000);
  return <p className="muted">Commencé à {fmtTime(since)} · {fmtElapsed(Math.max(0, Math.round((now - Date.parse(since)) / 1000)))}</p>;
}

export function JobView({ id }: { id: string }) {
  const { job, setJob, error, setError, again } = useJob(id);
  const [fiches, setFiches] = useState<number | undefined>();
  const [cancelling, setCancelling] = useState(false);
  const [sure, setSure] = useState(false);
  const { refreshProgress } = useApp();
  const onConfirmed = useCallback((j: Job, n?: number) => { setFiches(n); setJob(j); again(); }, [setJob, again]);
  const state = job?.state;
  useEffect(() => {
    if (state && JOB_FINAL.includes(state)) clearEdits(id); // etat final (annule, expire, echec, termine): plus de texte garde
  }, [state, id]);

  if (!job) return error ? <ErrorBox message={error} /> : <Loading />;

  const stage = job.status?.stage ?? STAGE_OF[job.state] ?? 'lecture';
  const failed = ['rejete', 'echec', 'expire'].includes(job.state);
  const kind = failKind(job.state, job.status?.message ?? job.message);
  const cancel = async () => {
    setCancelling(true);
    try {
      const j = await api.cancel(id);
      clearEdits(id); // le texte non envoye ne reste pas dans l'onglet
      setJob(j);
      void refreshProgress(); // les pages rendues se voient tout de suite (compteur de l'accueil et du scan)
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCancelling(false);
    }
  };
  const cancelBtn = sure ? (
    <div role="group" aria-label="Confirmer l'annulation" className="calm cancel-ask">
      <p><strong>Annuler ce scan ?</strong> La lecture déjà faite sera perdue. Tes pages te sont rendues.</p>
      <div className="btn-row">
        <button type="button" className="btn" onClick={cancel} disabled={cancelling} autoFocus>Oui, annuler le scan</button>
        <button type="button" className="btn btn-ghost" onClick={() => setSure(false)} disabled={cancelling}>Non, continuer</button>
      </div>
    </div>
  ) : (
    <button type="button" className="btn btn-ghost" onClick={() => setSure(true)}>Annuler et récupérer mes pages</button>
  );

  if (job.state === 'a_confirmer') {
    return (
      <>
        <TimeLeft expiresAt={job.status?.expiresAt} soon={job.status?.expiresSoon} />
        <ConfirmView id={id} onDone={onConfirmed} />
        <ErrorBox message={error} />
        <Card>
          <p className="muted">Tes pages sont gardées pour toi pendant que tu relis. Si tu ne veux plus de ce scan :</p>
          {cancelBtn}
        </Card>
      </>
    );
  }

  if (failed) {
    const msg = job.status?.message ?? job.message ?? (job.state === 'expire' ? 'Le délai est dépassé.' : "Ce cours n'a pas pu être traité.");
    return (
      <Card title={kind.title}>
        <div role="status" className="calm job-fail">
          <p className="job-fail-label"><span aria-hidden="true">{kind.label === 'Annulé' ? '↩️' : '🛟'}</span> {kind.label}</p>
          <p>{msg}</p>
          <p className="muted">Tes pages ont été rendues.</p>
        </div>
        <ErrorBox message={error} />
        <button className="btn btn-big" onClick={() => go('/scan')}>Recommencer</button>
      </Card>
    );
  }

  const idx = stageIndex(stage);
  const st = job.status;
  const done = stage === 'termine';
  const started = st?.startedAt ?? job.createdAt;
  const showPages = st && (stage === 'envoi' || stage === 'lecture');
  return (
    <Card title={done ? 'Ta fiche est prête' : fiches && fiches > 1 ? `Ton cours est en route : ${fiches} fiches` : 'Ton cours est en route'}>
      <ol className="steps frise" aria-label="Étapes du traitement">
        {STAGES.map((s, i) => (
          <li key={s.stage} aria-current={i === idx && !done ? 'step' : undefined} className={i < idx || done ? 'done' : i === idx ? 'now' : ''}>
            <span className="step-dot" aria-hidden="true">{i < idx || done ? '✓' : i + 1}</span>
            <span className="step-label">{s.label}</span>
          </li>
        ))}
      </ol>
      <div role="status" className="job-info">
        {showPages && (
          <>
            <p className="job-pages"><strong>Pages {stage === 'envoi' ? 'reçues' : 'lues'} {st.pagesDone} sur {st.pagesTotal}</strong></p>
            <Bar pct={st.pagesTotal ? Math.round((st.pagesDone / st.pagesTotal) * 100) : 0} label="Pages traitées" />
          </>
        )}
        {!done && <Elapsed since={started} />}
        {!done && <p className="soft">Tu peux quitter cette page, on garde ta place.</p>}
      </div>
      <ErrorBox message={error} />
      {done && <Fiches job={job} />}
      {stage === 'envoi' && cancelBtn}
    </Card>
  );
}

function Fiches({ job }: { job: Job }) {
  const ids = job.docIds?.length ? job.docIds : job.docId ? [job.docId] : [];
  const [docs, setDocs] = useState<Doc[] | null>(null);
  useEffect(() => {
    let live = true;
    Promise.all(ids.map((d) => api.doc(d))).then((r) => live && setDocs(r), () => live && setDocs([]));
    return () => { live = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids.join(',')]);
  const coursId = docs?.find((d) => d.coursId)?.coursId;
  if (!ids.length) return <p>🎉 Rien à lire ici: toutes les parties ont été ignorées, ton cours est gardé.</p>;
  if (ids.length === 1 && docs?.length !== 1) {
    return <button className="btn btn-big" onClick={() => go(`/doc/${encodeURIComponent(ids[0])}`)}>Lire la fiche</button>;
  }
  return (
    <>
      <p>🎉 {ids.length} {plural(ids.length, 'fiche est prête', 'fiches sont prêtes')} !</p>
      <ul className="list">
        {(docs ?? []).map((d) => (
          <li key={d.docId} className="fiche-card">
            <span className="grow"><strong>{d.title}</strong><br /><span className={subjectClass(d.subject)}>{subjectLabel(d.subject)}</span></span>
            <button className="btn btn-small" onClick={() => go(`/doc/${encodeURIComponent(d.docId)}`)}>Lire la fiche<span className="sr-only"> {d.title}</span></button>
          </li>
        ))}
      </ul>
      {coursId && <button className="btn btn-ghost" onClick={() => go(`/cours/${encodeURIComponent(coursId)}`)}>Voir le cours complet</button>}
    </>
  );
}
