import { useEffect, useState } from 'react';
import { api } from '../api';
import { errMsg } from '../hooks';
import type { Folder } from '../types';

const NEW = '__new__';

/** Liste de dossiers de l'eleve avec « Nouveau dossier… » (cree le dossier tout de suite). */
export function FolderSelect({ value, onChange, label, none = 'Aucun dossier' }: { value: string; onChange: (id: string) => void; label: string; none?: string }) {
  const [folders, setFolders] = useState<Folder[]>([]);
  const [creating, setCreating] = useState(false);
  const [name, setName] = useState('');
  const [err, setErr] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    api.folders().then((r) => live && setFolders(r.items), () => undefined);
    return () => { live = false; };
  }, []);

  async function create() {
    setErr(null);
    try {
      const f = await api.createFolder(name.trim());
      setFolders((l) => [...l, f]);
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
          <option value="">{none}</option>
          {folders.map((f) => <option key={f.folderId} value={f.folderId}>{f.name}</option>)}
          <option value={NEW}>＋ Nouveau dossier…</option>
        </select>
      </label>
      {creating && (
        <div className="btn-row" style={{ marginTop: '.4rem' }}>
          <input aria-label="Nom du nouveau dossier" value={name} maxLength={60} placeholder="Nom du dossier" onChange={(e) => setName(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button type="button" className="btn btn-small" disabled={!name.trim()} onClick={create}>Créer</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={() => setCreating(false)}>Annuler</button>
        </div>
      )}
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
}
