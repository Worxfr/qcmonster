import { useEffect, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import type { ExportArchive } from '../types';
import { Card, ErrorBox } from './ui';

const POLL_MS = 3000;
const POLL_MAX = 200; // environ 10 minutes
const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`);

/** « Télécharger mes données » (élève): l'archive est préparée par le serveur, le lien arrive quand elle est prête. */
export function ExportMine({ pollMs = POLL_MS }: { pollMs?: number }) {
  const [phase, setPhase] = useState<'idle' | 'wait' | 'ready'>('idle');
  const [archive, setArchive] = useState<ExportArchive | null>(null);
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []); // StrictMode monte deux fois en dev

  async function start() {
    setError(null);
    setPhase('wait');
    try {
      const { exportId } = await api.startMyExport();
      for (let i = 0; i < POLL_MAX && live.current; i++) {
        await new Promise((r) => setTimeout(r, i === 0 ? Math.min(pollMs, 500) : pollMs));
        if (!live.current) return;
        const st = await api.myExport(exportId);
        if (st.status === 'pret' && st.archive) {
          setArchive(st.archive);
          setPhase('ready');
          return;
        }
        if (st.status === 'echec') throw new Error('echec');
      }
      throw new Error('delai');
    } catch (e) {
      if (!live.current) return;
      setPhase('idle');
      setError(
        e instanceof ApiError && e.status === 429 ? 'Tu as déjà demandé 3 archives cette heure. Réessaie plus tard.'
        : e instanceof ApiError ? e.message
        : "L'archive n'a pas pu être préparée. Réessaie dans un moment.",
      );
    }
  }

  return (
    <Card title="Télécharger mes données">
      <div className="export-card">
        <p>Un fichier zip avec tout ce que tu as dans QCMonster : tes cours, tes fiches, tes images gardées et tes tests. Il est préparé pour toi, ça peut prendre un moment.</p>
        <button type="button" className="btn btn-ghost" disabled={phase === 'wait'} onClick={() => void start()} aria-busy={phase === 'wait'}>
          {phase === 'wait' ? 'Je prépare ton archive…' : 'Télécharger mes données'}
        </button>
        {phase === 'wait' && <p role="status" className="muted">Tu peux rester sur cette page. Le lien apparaît ici dès que c'est prêt.</p>}
        <ErrorBox message={error} />
        {phase === 'ready' && archive && (
          <div className="soft archive-ready" role="status">
            <p><strong>Ton archive est prête</strong> ({size(archive.sizeBytes)}{archive.courses !== undefined ? `, ${archive.courses} cours` : ''}{archive.figures ? `, ${archive.figures} images` : ''}).</p>
            <p><a className="btn" href={archive.url} rel="noopener noreferrer" download>⬇ Télécharger l'archive</a></p>
            <p className="muted">Le lien est valable 10 minutes. Passé ce délai, demande-la de nouveau.</p>
            {archive.truncated && <p className="notice">Pour rester sous la taille maximale, les images des cours les plus anciens ne sont pas dans l'archive. Leur texte y est en entier.</p>}
          </div>
        )}
      </div>
    </Card>
  );
}
