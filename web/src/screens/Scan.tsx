import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { Loading } from '../components/ui';
import { ApiError, api, uploadScan } from '../api';
import { useApp } from '../app-context';
import { FolderSelect, useFolders } from '../components/FolderSelect';
import { Bar, Card, ErrorBox } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import { plural, subjectLabel } from '../labels';
import { go } from '../router';
import { MyScans } from './MyScans';

export const MAX_PAGES = 10;
/** Un cours tient 30 pages et 20 sections au plus (contrat 1.6). */
export const MAX_COURS_PAGES = 30;
export const MAX_COURS_SECTIONS = 20;
export const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png'];

interface Page { key: number; file: File; url: string }
let seq = 0;

/** Envoi de 3 fichiers en parallele au plus; chaque fichier a un deuxieme essai. */
async function uploadAll(uploads: { url: string; fields: Record<string, string> }[], files: File[], onDone: (n: number) => void) {
  let next = 0;
  let done = 0;
  const worker = async () => {
    while (next < files.length) {
      const i = next++;
      try {
        await uploadScan(uploads[i], files[i]);
      } catch {
        await uploadScan(uploads[i], files[i]);
      }
      onDone(++done);
    }
  };
  await Promise.all([worker(), worker(), worker()].slice(0, Math.min(3, files.length)));
}

export function Scan({ coursId }: { coursId?: string } = {}) {
  const target = useLoad(() => (coursId ? api.cours(coursId) : Promise.resolve(null)), [coursId]);
  if (coursId && target.loading && !target.data) return <Loading />;
  if (coursId && !target.data) return <><ErrorBox message={target.error} /><button className="btn btn-ghost" onClick={() => go('/docs')}>Retour à mes cours</button></>;
  return <ScanForm coursId={coursId} cours={target.data ?? undefined} />;
}

function ScanForm({ coursId, cours }: { coursId?: string; cours?: { pages: number; sections: { subject: Parameters<typeof subjectLabel>[0]; topic?: string }[] } }) {
  const { progress, refreshProgress } = useApp();
  // Ajout: au plus 10 pages par envoi, et ce qui reste dans les 30 pages du cours.
  const room = cours ? MAX_COURS_PAGES - cours.pages : MAX_PAGES;
  const maxPages = Math.min(MAX_PAGES, Math.max(0, room));
  const full = !!cours && (room <= 0 || cours.sections.length >= MAX_COURS_SECTIONS);
  const [pages, setPages] = useState<Page[]>([]);
  const [messages, setMessages] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [folderId, setFolderId] = useState('');
  const [sent, setSent] = useState<number | null>(null);
  const { folders, add } = useFolders();
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);

  const left = progress?.pagesRemaining;
  const busy = sent !== null;
  const tooMany = left !== undefined && pages.length > left;

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const msgs: string[] = [];
    const ok: Page[] = [];
    for (const f of files) {
      if (!TYPES.includes(f.type)) msgs.push(`« ${f.name} » n'est pas une photo JPEG ou PNG.`);
      else if (f.size > MAX_BYTES) msgs.push(`« ${f.name} » est trop lourde (5 Mo au maximum).`);
      else if (pages.length + ok.length >= maxPages) {
        if (!msgs.some((m) => m.includes('au maximum'))) msgs.push(`${maxPages} ${plural(maxPages, 'page', 'pages')} au maximum${cours ? ' pour cet ajout' : ''} : les photos en trop n'ont pas été ajoutées.`);
      } else {
        const url = URL.createObjectURL(f);
        urls.current.push(url);
        ok.push({ key: ++seq, file: f, url });
      }
    }
    setMessages(msgs);
    setError(null);
    if (ok.length) setPages((p) => [...p, ...ok]);
  }

  const move = (i: number, d: number) => setPages((p) => {
    const n = [...p];
    [n[i], n[i + d]] = [n[i + d], n[i]];
    return n;
  });
  const remove = (i: number) => setPages((p) => p.filter((_, j) => j !== i));

  async function send() {
    setError(null);
    setSent(0);
    let jobId: string | undefined;
    try {
      const scan = await api.createScan(pages.map((p) => p.file.type), folderId || undefined, coursId);
      jobId = scan.jobId;
      const uploads = scan.uploads ?? [{ page: 1, ...scan.upload }];
      if (uploads.length < pages.length) {
        await api.cancel(jobId).catch(() => undefined);
        void refreshProgress();
        throw new Error('Le serveur ne prend encore qu\'une page à la fois. Garde une seule photo.');
      }
      await uploadAll(uploads, pages.map((p) => p.file), setSent).catch(async () => {
        await api.cancel(jobId!).catch(() => undefined);
        void refreshProgress();
        throw new Error("L'envoi a échoué, tes pages sont rendues. Réessaie.");
      });
      void refreshProgress();
      go(`/job/${encodeURIComponent(jobId)}`);
    } catch (err) {
      if (err instanceof ApiError && err.code === 'cours_plein') setError('Ce cours est complet : 30 pages et 20 parties au plus. Tu peux scanner ces pages comme un nouveau cours.');
      else if (err instanceof ApiError && err.status === 404 && coursId) setError("Ce cours n'existe plus.");
      else if (err instanceof ApiError && (err.code === 'quota_epuise' || err.code === 'budget_epuise')) {
        setError(err.resetDate ? `${err.message}. Retour des pages le ${new Date(err.resetDate).toLocaleDateString('fr-FR')}.` : err.message);
      } else setError(errMsg(err));
      setSent(null);
    }
  }

  return (
    <>
    <Card title={cours ? 'Ajouter des pages à ton cours' : 'Scanner un cours'}>
      {cours && (
        <div className="append-banner" aria-label="Cours auquel tu ajoutes des pages">
          <span className="append-ico" aria-hidden="true">➕</span>
          <div>
            <strong>{subjectLabel(cours.sections[0]?.subject ?? 'autre')}{cours.sections[0]?.topic ? ` · ${cours.sections[0].topic}` : ''}</strong>
            <span className="muted"> {cours.pages} {plural(cours.pages, 'page', 'pages')} aujourd'hui · {Math.max(0, room)} {plural(Math.max(0, room), 'page possible', 'pages possibles')} en plus</span>
            <p className="append-note">Tes nouvelles pages seront ajoutées à la <strong>fin</strong> du cours. Ce que tu as déjà ne change pas.</p>
          </div>
        </div>
      )}
      {full && (
        <p className="notice" role="status">Ce cours est complet ({MAX_COURS_PAGES} pages et {MAX_COURS_SECTIONS} parties au plus). Tu peux scanner tes nouvelles pages comme un nouveau cours.</p>
      )}
      {!full && <p className="lead">Prends tes pages en photo, bien à plat et avec de la lumière. Tu peux en envoyer {maxPages} d'un coup, dans l'ordre du cours.</p>}
      {left !== undefined && (
        <p className="muted" role="status">
          {pages.length > 0 ? `${pages.length} ${plural(pages.length, 'page', 'pages')}, il` : 'Il'} te reste {left} {plural(left, 'page', 'pages')} ce mois-ci
        </p>
      )}
      {!full && <label className="btn btn-big file-btn">
        {pages.length ? '➕ Ajouter une page' : '📷 Prendre ou choisir des photos'}
        <input type="file" multiple accept="image/jpeg,image/png" onChange={pick} disabled={busy || pages.length >= maxPages} aria-label={pages.length ? 'Ajouter une page' : 'Prendre ou choisir des photos'} />
      </label>}
      {messages.map((m) => <p key={m} role="alert" className="error">{m}</p>)}

      {pages.length > 0 && (
        <>
          <ol className="thumbs" aria-label="Pages à envoyer, dans l'ordre">
            {pages.map((p, i) => (
              <li key={p.key} className="thumb">
                <span className="thumb-num" aria-hidden="true">{i + 1}</span>
                <img src={p.url} alt={`Page ${i + 1}`} />
                <div className="thumb-actions">
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy || i === 0} onClick={() => move(i, -1)}>Monter<span className="sr-only"> la page {i + 1}</span></button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy || i === pages.length - 1} onClick={() => move(i, 1)}>Descendre<span className="sr-only"> la page {i + 1}</span></button>
                  <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => remove(i)}>Retirer<span className="sr-only"> la page {i + 1}</span></button>
                </div>
              </li>
            ))}
          </ol>
          <FolderSelect value={folderId} onChange={setFolderId} label="Ranger dans un dossier (facultatif)" folders={folders} onCreated={add} />
          {tooMany && <p role="alert" className="error">Tu as choisi {pages.length} pages mais il ne t'en reste que {left}. Retire-en {pages.length - (left ?? 0)} pour envoyer.</p>}
          {busy && (
            <div role="status">
              <p><strong>{sent} sur {pages.length}</strong> envoyées…</p>
              <Bar pct={Math.round(((sent ?? 0) / pages.length) * 100)} label="Envoi des pages" />
            </div>
          )}
          <button type="button" className="btn btn-big" onClick={send} disabled={busy || tooMany} aria-busy={busy}>
            {busy ? 'Envoi en cours…' : cours ? `Ajouter ${pages.length} ${plural(pages.length, 'page', 'pages')} au cours` : `Envoyer ${pages.length} ${plural(pages.length, 'page', 'pages')}`}
          </button>
        </>
      )}
      <ErrorBox message={error} />
    </Card>
    <MyScans />
    </>
  );
}
