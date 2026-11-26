import { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { errMsg } from '../hooks';
import type { Folder } from '../types';

const NEW = '__new__';

/** Charge les dossiers de l'eleve UNE fois; a appeler dans le composant parent et a passer en propriete. */
export function useFolders(): { folders: Folder[]; add: (f: Folder) => void } {
  const [folders, setFolders] = useState<Folder[]>([]);
  useEffect(() => {
    let live = true;
    api.folders().then((r) => live && setFolders(r.items), () => undefined);
    return () => { live = false; };
  }, []);
  const add = useCallback((f: Folder) => setFolders((l) => (l.some((x) => x.folderId === f.folderId) ? l : [...l, f])), []);
  return { folders, add };
}

/** Liste de dossiers avec « Nouveau dossier… » (cree le dossier tout de suite). La liste vient du parent. */
export function FolderSelect({ value, onChange, label, folders, onCreated, none = 'Aucun dossier', allowNone = true }: { value: string; onChange: (id: string) => void; label: string; folders: Folder[]; onCreated: (f: Folder) => void; none?: string; allowNone?: boolean }) {
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);

  async function create() {
    setErr(null);
    try {
      const f = await api.createFolder(name.trim());
      onCreated(f);
      setCreating(false);
      setName('');
      onChange(f.folderId);
    } catch (e) {
      setErr(errMsg(e));
    }
  }
  return (
    <div className="folder-select">
      <label>{label}
        <select value={creating ? NEW : value} onChange={(e) => (e.target.value === NEW ? setCreating(true) : (setCreating(false), onChange(e.target.value)))}>
          {(allowNone || value === '') && <option value="">{none}</option>}
          {folders.map((f) => <option key={f.folderId} value={f.folderId}>{f.name}</option>)}
          <option value={NEW}>＋ Nouveau dossier…</option>
        </select>
      </label>
      {creating && (
        <>
          <div className="btn-row" style={{ marginTop: '.4rem' }}>
            <input aria-label="Nom du nouveau dossier" value={name} maxLength={60} placeholder="Nom du dossier" onChange={(e) => setName(e.target.value)} onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); if (name.trim()) void create(); } }} style={{ flex: 1, minWidth: 0 }} />
            <button type="button" className="btn btn-small" disabled={!name.trim()} onClick={create}>Créer</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setCreating(false)}>Annuler</button>
          </div>
          <p className="muted" style={{ margin: '.3rem 0 0' }}>Le dossier n'existe qu'après « Créer ».</p>
        </>
      )}
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
}
