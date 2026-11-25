import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { JOB_FINAL } from '../game';
import { errMsg } from '../hooks';
import { STAGES, failKind, fmtElapsed, fmtTime, stageIndex, subjectClass, subjectLabel, timeLeft, plural } from '../labels';
import { go } from '../router';
import type { Doc, Job, ScanStage } from '../types';
import { ConfirmView } from './confirm/ConfirmView';

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
    const tick = async () => {
      clearTimeout(timer.current);
      if (document.hidden) return; // reprise au retour sur l'onglet
      let delay = POLL_MS;
      try {
        const j = await api.job(id);
        if (!live) return;
        setJob(j);
        setError(null);
        if (JOB_FINAL.includes(j.state)) return;
      } catch (e) {
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
  return { job, setJob, error, setError, again: () => tickRef.current() };
}

function useNow(ms: number) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
}

export function JobView({ id }: { id: string }) {
  const { job, setJob, error, setError, again } = useJob(id);
  const [fiches, setFiches] = useState<number | undefined>();
  const now = useNow(1000);
  const [cancelling, setCancelling] = useState(false);

  if (!job) return error ? <ErrorBox message={error} /> : <Loading />;

  const stage = job.status?.stage ?? STAGE_OF[job.state] ?? 'lecture';
  const failed = ['rejete', 'echec', 'expire'].includes(job.state);
  const kind = failKind(job.state, job.status?.message ?? job.message);
  const cancel = async () => {
    setCancelling(true);
    try {
      setJob(await api.cancel(id));
    } catch (e) {
      setError(errMsg(e));
    } finally {
      setCancelling(false);
    }
  };
  const cancelBtn = (
    <button type="button" className="btn btn-ghost" onClick={cancel} disabled={cancelling}>Annuler et récupérer mes pages</button>
  );

  if (job.state === 'a_confirmer') {
    const left = timeLeft(job.status?.expiresAt, now);
    return (
      <>
        {left && (
          <p className={`review-time${job.status?.expiresSoon ? ' soon' : ''}`} role="status">
            <span aria-hidden="true">{job.status?.expiresSoon ? '⏳' : '🕒'}</span> {left.replace('Il reste ', 'Il reste ')} pour relire
          </p>
        )}
        <ConfirmView id={id} onDone={(j, n) => { setFiches(n); setJob(j); again(); }} />
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
  const elapsed = Math.max(0, Math.round((now - Date.parse(started)) / 1000));
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
        {!done && <p className="muted">Commencé à {fmtTime(started)} · {fmtElapsed(elapsed)}</p>}
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
