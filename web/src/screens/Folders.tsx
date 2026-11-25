import { useState, type FormEvent } from 'react';
import { ApiError, api } from '../api';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import { plural } from '../labels';
import { go } from '../router';

const MAX_FOLDERS = 50;

/** Le front lit le CODE d'erreur, pas le texte. */
function folderError(e: unknown): string {
  if (e instanceof ApiError && e.code === 'dossier_nom_pris') return 'Tu as déjà un dossier avec ce nom.';
  if (e instanceof ApiError && e.code === 'dossiers_limite') return `Tu as déjà ${MAX_FOLDERS} dossiers. Supprime-en un pour en créer un autre.`;
  return errMsg(e);
}

export function Folders() {
  const f = useLoad(() => api.folders(), []);
  const [name, setName] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [deleting, setDeleting] = useState<string | null>(null);
  const items = f.data?.items ?? [];

  async function act(fn: () => Promise<unknown>) {
    setError(null);
    try {
      await fn();
      f.reload();
    } catch (e) {
      setError(folderError(e));
    }
  }
  const create = (e: FormEvent) => {
    e.preventDefault();
    void act(async () => { await api.createFolder(name.trim()); setName(''); });
  };

  return (
    <>
      <Card title="Mes dossiers">
        <p><a className="link" href="#/docs">‹ Mes cours</a></p>
        <form onSubmit={create} className="folder-new">
          <label>Nouveau dossier
            <input value={name} maxLength={60} placeholder="Ex. Contrôle de juin" onChange={(e) => setName(e.target.value)} />
          </label>
          <button className="btn" disabled={!name.trim() || items.length >= MAX_FOLDERS}>Créer</button>
        </form>
        <p className="muted">{items.length} sur {MAX_FOLDERS} dossiers.</p>
        <ErrorBox message={error ?? f.error} />
      </Card>
      {f.loading && !f.data && <Loading />}
      {f.data && items.length === 0 && <Card><p className="empty">📁 Pas encore de dossier. Crée le premier pour ranger tes cours.</p></Card>}
      <ul className="list folder-list">
        {items.map((d) => (
          <li key={d.folderId} className="card folder-card">
            {editing === d.folderId ? (
              <form className="btn-row" onSubmit={(e) => { e.preventDefault(); void act(async () => { await api.renameFolder(d.folderId, draft.trim()); setEditing(null); }); }}>
                <input aria-label="Nouveau nom" value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
                <button className="btn btn-small" disabled={!draft.trim()}>Enregistrer</button>
                <button type="button" className="btn btn-small btn-ghost" onClick={() => setEditing(null)}>Annuler</button>
              </form>
            ) : (
              <>
                <button type="button" className="folder-open" onClick={() => go(`/docs?folderId=${encodeURIComponent(d.folderId)}`)}>
                  <span className="folder-ico" aria-hidden="true">📁</span>
                  <span className="grow"><strong>{d.name}</strong><br /><span className="muted">{d.scanCount} {plural(d.scanCount, 'cours', 'cours')}</span></span>
                  <span aria-hidden="true">›</span>
                </button>
                {deleting === d.folderId ? (
                  <div className="selpanel">
                    <p><strong>Supprimer « {d.name} » ?</strong> Les cours restent, ils sortent du dossier.</p>
                    <div className="btn-row">
                      <button type="button" className="btn btn-small btn-danger" onClick={() => void act(async () => { await api.deleteFolder(d.folderId); setDeleting(null); })}>Oui, supprimer le dossier</button>
                      <button type="button" className="btn btn-small btn-ghost" onClick={() => setDeleting(null)}>Annuler</button>
                    </div>
                  </div>
                ) : (
                  <div className="btn-row">
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => { setEditing(d.folderId); setDraft(d.name); }}>Renommer<span className="sr-only"> {d.name}</span></button>
                    <button type="button" className="btn btn-small btn-ghost" onClick={() => setDeleting(d.folderId)}>Supprimer<span className="sr-only"> {d.name}</span></button>
                  </div>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </>
  );
}
