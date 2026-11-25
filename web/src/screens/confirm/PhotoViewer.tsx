import { useEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';

const MIN = 1;
const MAX = 5;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

interface View { z: number; x: number; y: number }
const RESET: View = { z: 1, x: 0, y: 0 };

function zoomTo(v: View, z: number): View {
  const nz = clamp(z);
  return nz === 1 ? RESET : { ...v, z: nz };
}

// Photo avec zoom (boutons, molette, pincement), déplacement et plein écran.
export function PhotoViewer({ src, label, onReload }: { src: string | undefined; label: string; onReload?: () => void }) {
  const [view, setView] = useState<View>(RESET);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);

  useEffect(() => {
    setView(RESET);
    setFailed(false);
  }, [src]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setFull(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [full]);

  // La molette zoome seulement sur la photo (écouteur non passif pour pouvoir bloquer le défilement de la page).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setView((v) => zoomTo(v, v.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
  }, [failed, src]);

  const zoom = (f: number) => setView((v) => zoomTo(v, v.z * f));

  function down(e: RPointerEvent) {
    (e.currentTarget as HTMLElement).setPointerCapture?.(e.pointerId);
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 2) {
      const [a, b] = [...pts.current.values()];
      pinch.current = { d: Math.hypot(a.x - b.x, a.y - b.y), z: view.z };
    }
  }
  function move(e: RPointerEvent) {
    const prev = pts.current.get(e.pointerId);
    if (!prev) return;
    pts.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pts.current.size === 2 && pinch.current) {
      const [a, b] = [...pts.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      const base = pinch.current;
      setView((v) => zoomTo(v, base.z * (d / (base.d || 1))));
    } else if (pts.current.size === 1) {
      const dx = e.clientX - prev.x;
      const dy = e.clientY - prev.y;
      setView((v) => (v.z > 1 ? { ...v, x: v.x + dx, y: v.y + dy } : v));
    }
  }
  function up(e: RPointerEvent) {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
  }
  function key(e: RKeyboardEvent) {
    const step = 40;
    const pan = (dx: number, dy: number) => setView((v) => (v.z > 1 ? { ...v, x: v.x + dx, y: v.y + dy } : v));
    if (e.key === '+' || e.key === '=') zoom(1.25);
    else if (e.key === '-') zoom(1 / 1.25);
    else if (e.key === '0') setView(RESET);
    else if (e.key === 'ArrowLeft') pan(step, 0);
    else if (e.key === 'ArrowRight') pan(-step, 0);
    else if (e.key === 'ArrowUp') pan(0, step);
    else if (e.key === 'ArrowDown') pan(0, -step);
    else return;
    e.preventDefault();
  }

  return (
    <div className={`cf-viewer${full ? ' full' : ''}`} role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? `${label} en plein écran` : undefined}>
      <div className="cf-tools" role="toolbar" aria-label="Zoom de la photo">
        <button type="button" className="cf-tool" onClick={() => zoom(1 / 1.25)} disabled={view.z <= MIN || failed} aria-label="Dézoomer">−</button>
        <span className="cf-zoomval" aria-live="polite">{Math.round(view.z * 100)} %</span>
        <button type="button" className="cf-tool" onClick={() => zoom(1.25)} disabled={view.z >= MAX || failed} aria-label="Zoomer">+</button>
        <button type="button" className="cf-tool cf-wide" onClick={() => setView(RESET)} disabled={view.z === 1}>Ajuster</button>
        <button type="button" className="cf-tool cf-wide" onClick={() => setFull((f) => !f)} aria-pressed={full}>{full ? 'Fermer' : 'Plein écran'}</button>
      </div>
      {src && !failed ? (
        <div
          ref={box}
          className="cf-stage"
          tabIndex={0}
          role="group"
          aria-label={`${label}. Plus et moins pour zoomer, flèches pour déplacer.`}
          onPointerDown={down}
          onPointerMove={move}
          onPointerUp={up}
          onPointerCancel={up}
          onKeyDown={key}
          data-zoomed={view.z > 1}
        >
          <img src={src} alt={label} draggable={false} onError={() => setFailed(true)} style={{ transform: `translate(${view.x}px, ${view.y}px) scale(${view.z})` }} />
        </div>
      ) : (
        <div className="cf-stage cf-missing" role="alert">
          <p>{src ? "La photo ne s'affiche pas. Le lien a peut-être expiré." : 'Pas de photo pour cette page.'}</p>
          {onReload && <button type="button" className="btn btn-ghost" onClick={onReload}>Recharger la photo</button>}
        </div>
      )}
    </div>
  );
}
