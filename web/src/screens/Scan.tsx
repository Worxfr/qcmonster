import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ApiError, api, uploadScan } from '../api';
import { useApp } from '../app-context';
import { Card, ErrorBox, Loading } from '../components/ui';
import { JOB_FINAL, JOB_STEPS, countPdfPages } from '../game';
import { errMsg, useLoad } from '../hooks';
import { go } from '../router';
import type { Job, Sentence } from '../types';

const TYPES = ['image/jpeg', 'image/png', 'application/pdf'];
const MAX_BYTES = 10 * 1024 * 1024;

export function Scan() {
  const { progress, refreshProgress } = useApp();
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function pick(e: ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    setError(null);
    if (!TYPES.includes(file.type)) return setError('Choisis une photo (JPEG ou PNG) ou un PDF.');
    if (file.size > MAX_BYTES) return setError('Fichier trop lourd (10 Mo au maximum).');
    setBusy(true);
    try {
      const pages = file.type === 'application/pdf' ? countPdfPages(new Uint8Array(await file.arrayBuffer())) : 1;
      if (pages < 1) throw new Error('Ce PDF ne contient aucune page lisible.');
      if (pages > 10) throw new Error('Un PDF ne peut pas dépasser 10 pages.');
      const scan = await api.createScan(pages, file.type);
      await uploadScan(scan.upload, file);
      void refreshProgress();
      go(`/job/${encodeURIComponent(scan.jobId)}`);
    } catch (err) {
      if (err instanceof ApiError && (err.code === 'quota_epuise' || err.code === 'budget_epuise')) {
        setError(err.resetDate ? `${err.message}. Retour des pages le ${new Date(err.resetDate).toLocaleDateString('fr-FR')}.` : err.message);
      } else setError(errMsg(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Scanner un cours">
      <p>Prends ta page en photo bien à plat, avec de la lumière, ou choisis un PDF (10 pages max).</p>
      {progress && <p className="muted">Il te reste {progress.pagesRemaining} page{progress.pagesRemaining > 1 ? 's' : ''} ce mois-ci.</p>}
      <label className="btn btn-big file-btn">
        {busy ? 'Envoi en cours…' : '📷 Photo ou PDF'}
        <input type="file" accept="image/jpeg,image/png,application/pdf" capture="environment" onChange={pick} disabled={busy} aria-label="Choisir une photo ou un PDF" />
      </label>
      <ErrorBox message={error} />
    </Card>
  );
}

const fmtDuration = (s: number) => (s < 90 ? `${s} s` : `${Math.round(s / 60)} min`);

const fmtEuros = (cents: number) => `${(cents / 100).toLocaleString('fr-FR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`;

export function JobView({ id }: { id: string }) {
  const [job, setJob] = useState<Job | null>(null);
  const [error, setError] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const j = await api.job(id);
        if (!live) return;
        setJob(j);
        setError(null);
        if (!JOB_FINAL.includes(j.state)) timer.current = setTimeout(tick, 2500);
      } catch (e) {
        if (!live) return;
        setError(errMsg(e));
        timer.current = setTimeout(tick, 5000);
      }
    };
    void tick();
    return () => {
      live = false;
      clearTimeout(timer.current);
    };
  }, [id]);

  if (!job) return error ? <ErrorBox message={error} /> : <Loading />;
  if (job.state === 'a_confirmer') return <Confirm id={id} onDone={(j) => setJob(j)} />;
  const idx = JOB_STEPS.findIndex((s) => s.state === job.state);
  const failed = ['rejete', 'echec', 'expire'].includes(job.state);
  return (
    <Card title="Ton cours est en route">
      <ol className="steps" aria-label="Étapes du traitement">
        {JOB_STEPS.map((s, i) => (
          <li key={s.state} aria-current={i === idx ? 'step' : undefined} className={i < idx ? 'done' : i === idx ? 'now' : ''}>
            <span aria-hidden="true">{i < idx ? '✓' : i === idx ? '⏳' : '○'}</span> {s.label}
          </li>
        ))}
      </ol>
      <div role="status">
        {failed && <p className="error">{job.message ?? (job.state === 'expire' ? 'Le délai est dépassé.' : 'Ce cours n\'a pas pu être traité.')}</p>}
        {job.state === 'termine' && job.docId && <p>🎉 Ta fiche est prête !{job.durationSeconds !== undefined && <span className="muted"> Traitée en {fmtDuration(job.durationSeconds)}.</span>}</p>}
        {job.state === 'termine' && job.costCents !== undefined && <p className="muted">Coût du traitement : {fmtEuros(job.costCents)}</p>}
        {!failed && job.state !== 'termine' && <p className="muted">Tu peux quitter cette page, on garde ta place.</p>}
      </div>
      <ErrorBox message={error} />
      {job.state === 'termine' && job.docId && <button className="btn" onClick={() => go(`/doc/${encodeURIComponent(job.docId!)}`)}>Lire la fiche</button>}
      {failed && <button className="btn" onClick={() => go('/scan')}>Réessayer</button>}
      {!failed && job.state !== 'termine' && (
        <button className="btn btn-ghost" onClick={() => api.cancel(id).then(setJob, (e) => setError(errMsg(e)))}>Annuler et récupérer mes pages</button>
      )}
    </Card>
  );
}

function Confirm({ id, onDone }: { id: string; onDone: (j: Job) => void }) {
  const t = useLoad(() => api.transcription(id), [id]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  if (t.loading) return <Loading />;
  if (!t.data) return <ErrorBox message={t.error} />;
  const tr = t.data;
  const original = new Map<string, string>();
  tr.pages.forEach((p) => p.sentences.forEach((s) => original.set(s.id, s.text)));

  async function send() {
    setBusy(true);
    setError(null);
    const corrections: Sentence[] = Object.entries(edits)
      .filter(([sid, text]) => text !== original.get(sid))
      .map(([sid, text]) => ({ id: sid, text }));
    try {
      onDone(await api.confirm(id, corrections));
    } catch (e) {
      setError(errMsg(e));
      setBusy(false);
    }
  }

  return (
    <Card title="Vérifie ce que j'ai lu">
      <p>Compare la photo et le texte, corrige les erreurs, puis valide. C'est ce texte qui sera vérifié.</p>
      <div className="side-by-side">
        <div className="photos">
          {tr.photoUrls.map((u, i) => (
            <img key={u} src={u} alt={`Photo de ta page ${i + 1}`} loading="lazy" />
          ))}
        </div>
        <div className="texts">
          {tr.pages.map((p) => (
            <fieldset key={p.page}>
              <legend>Page {p.page}</legend>
              {p.sentences.map((s, i) => (
                <label key={s.id} className="sentence">
                  <span className="sr-only">Phrase {i + 1}</span>
                  <textarea rows={2} value={edits[s.id] ?? s.text} maxLength={2000} onChange={(e) => setEdits({ ...edits, [s.id]: e.target.value })} />
                </label>
              ))}
            </fieldset>
          ))}
        </div>
      </div>
      <ErrorBox message={error} />
      <button className="btn btn-big" onClick={send} disabled={busy}>C'est bon, vérifie !</button>
    </Card>
  );
}
