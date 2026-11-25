import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { ApiError, api, uploadScan } from '../api';
import { useApp } from '../app-context';
import { FolderSelect, useFolders } from '../components/FolderSelect';
import { Bar, Card, ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { plural } from '../labels';
import { go } from '../router';

export const MAX_PAGES = 10;
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

export function Scan() {
  const { progress, refreshProgress } = useApp();
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
      else if (pages.length + ok.length >= MAX_PAGES) {
        if (!msgs.some((m) => m.startsWith('10 pages'))) msgs.push(`10 pages au maximum : les photos en trop n'ont pas été ajoutées.`);
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
      const scan = await api.createScan(pages.map((p) => p.file.type), folderId || undefined);
      jobId = scan.jobId;
      const uploads = scan.uploads ?? [{ page: 1, ...scan.upload }];
      if (uploads.length < pages.length) {
        await api.cancel(jobId).catch(() => undefined);
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
      if (err instanceof ApiError && (err.code === 'quota_epuise' || err.code === 'budget_epuise')) {
        setError(err.resetDate ? `${err.message}. Retour des pages le ${new Date(err.resetDate).toLocaleDateString('fr-FR')}.` : err.message);
      } else setError(errMsg(err));
      setSent(null);
    }
  }

  return (
    <Card title="Scanner un cours">
      <p className="lead">Prends tes pages en photo, bien à plat et avec de la lumière. Tu peux en envoyer {MAX_PAGES} d'un coup, dans l'ordre du cours.</p>
      {left !== undefined && (
        <p className="muted" role="status">
          {pages.length > 0 ? `${pages.length} ${plural(pages.length, 'page', 'pages')}, il` : 'Il'} te reste {left} {plural(left, 'page', 'pages')} ce mois-ci
        </p>
      )}
      <label className="btn btn-big file-btn">
        {pages.length ? '➕ Ajouter une page' : '📷 Prendre ou choisir des photos'}
        <input type="file" multiple accept="image/jpeg,image/png" onChange={pick} disabled={busy || pages.length >= MAX_PAGES} aria-label={pages.length ? 'Ajouter une page' : 'Prendre ou choisir des photos'} />
      </label>
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
            {busy ? 'Envoi en cours…' : `Envoyer ${pages.length} ${plural(pages.length, 'page', 'pages')}`}
          </button>
        </>
      )}
      <ErrorBox message={error} />
    </Card>
  );
}
