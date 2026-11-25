import { useEffect, useLayoutEffect, useRef, useState, type KeyboardEvent as RKeyboardEvent, type PointerEvent as RPointerEvent } from 'react';
import { createPortal } from 'react-dom';

const MIN = 1;
const MAX = 5;
const clamp = (z: number) => Math.min(MAX, Math.max(MIN, z));

interface View { z: number; x: number; y: number }
const RESET: View = { z: 1, x: 0, y: 0 };

const FOCUSABLE = 'button:not([disabled]), [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

// Photo avec zoom (boutons, Ctrl + molette, pincement), déplacement borné et plein écran (dialogue modal).
export function PhotoViewer({ src, label, onReload, reloadError, reloading }: { src: string | undefined; label: string; onReload?: () => void; reloadError?: string | null; reloading?: boolean }) {
  const [view, setView] = useState<View>(RESET);
  const [full, setFull] = useState(false);
  const [failed, setFailed] = useState(false);
  const pts = useRef(new Map<number, { x: number; y: number }>());
  const pinch = useRef<{ d: number; z: number } | null>(null);
  const box = useRef<HTMLDivElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fullBtn = useRef<HTMLButtonElement>(null);
  const wasFull = useRef(false);

  // Déplacement borné: l'image ne sort jamais entièrement du cadre.
  const bound = (v: View): View => {
    const w = box.current?.clientWidth ?? 0;
    const h = box.current?.clientHeight ?? 0;
    const mx = ((v.z - 1) * w) / 2;
    const my = ((v.z - 1) * h) / 2;
    return { z: v.z, x: Math.max(-mx, Math.min(mx, v.x)), y: Math.max(-my, Math.min(my, v.y)) };
  };
  const zoomTo = (v: View, z: number): View => {
    const nz = clamp(z);
    return nz === 1 ? RESET : bound({ ...v, z: nz });
  };

  useEffect(() => {
    setView(RESET);
    setFailed(false);
  }, [src]);
  // Rechargement réussi (même avec le même lien): on réessaie d'afficher la photo.
  useEffect(() => {
    if (!reloading && !reloadError) setFailed(false);
  }, [reloading, reloadError]);

  // Plein écran: le reste de la page devient inerte, le focus entre dans le dialogue et revient au bouton à la fermeture.
  useLayoutEffect(() => {
    if (!full) {
      if (wasFull.current) fullBtn.current?.focus();
      wasFull.current = false;
      return;
    }
    wasFull.current = true;
    const others = [...document.body.children].filter((el) => el !== root.current?.parentElement && !el.contains(root.current) && !(el as HTMLElement).inert);
    others.forEach((el) => ((el as HTMLElement).inert = true));
    root.current?.querySelector<HTMLElement>('[data-close]')?.focus();
    return () => others.forEach((el) => ((el as HTMLElement).inert = false));
  }, [full]);

  useEffect(() => {
    if (!full) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') return setFull(false);
      if (e.key !== 'Tab' || !root.current) return;
      const items = [...root.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
      if (!items.length) return;
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!root.current.contains(active)) { e.preventDefault(); first.focus(); }
      else if (e.shiftKey && active === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && active === last) { e.preventDefault(); first.focus(); }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [full]);

  // Ctrl + molette (ou pincement du pavé tactile) zoome; la molette seule fait défiler la page.
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.ctrlKey) return;
      e.preventDefault();
      setView((v) => zoomTo(v, v.z * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
    };
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => el.removeEventListener('wheel', onWheel);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [failed, src, full]);

  const zoom = (f: number) => setView((v) => zoomTo(v, v.z * f));
  const pan = (dx: number, dy: number) => setView((v) => (v.z > 1 ? bound({ ...v, x: v.x + dx, y: v.y + dy }) : v));

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
    } else if (pts.current.size === 1) pan(e.clientX - prev.x, e.clientY - prev.y);
  }
  function up(e: RPointerEvent) {
    pts.current.delete(e.pointerId);
    if (pts.current.size < 2) pinch.current = null;
  }
  function key(e: RKeyboardEvent) {
    const step = 40;
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

  const content = (
    <div ref={root} className={`cf-viewer${full ? ' full' : ''}`} role={full ? 'dialog' : undefined} aria-modal={full || undefined} aria-label={full ? `${label} en plein écran` : undefined}>
      <div className="cf-tools" role="toolbar" aria-label="Zoom de la photo">
        <button type="button" className="cf-tool" onClick={() => zoom(1 / 1.25)} disabled={view.z <= MIN || failed} aria-label="Dézoomer">−</button>
        <span className="cf-zoomval">{Math.round(view.z * 100)} %</span>
        <button type="button" className="cf-tool" onClick={() => zoom(1.25)} disabled={view.z >= MAX || failed} aria-label="Zoomer">+</button>
        <button type="button" className="cf-tool cf-wide" onClick={() => setView(RESET)} disabled={view.z === 1}>Ajuster</button>
        <button type="button" ref={full ? undefined : fullBtn} data-close={full || undefined} className="cf-tool cf-wide" onClick={() => setFull((f) => !f)} aria-pressed={full}>{full ? 'Fermer' : 'Plein écran'}</button>
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
        <div className="cf-stage cf-missing">
          <p role="alert">{reloadError ? `Impossible de recharger la photo : ${reloadError}` : src ? "La photo ne s'affiche pas. Le lien a peut-être expiré." : 'Pas de photo pour cette page.'}</p>
          {onReload && <button type="button" className="btn btn-ghost" onClick={onReload} disabled={reloading}>{reloading ? 'Rechargement…' : reloadError ? 'Réessayer' : 'Recharger la photo'}</button>}
        </div>
      )}
    </div>
  );
  // Portail: hors du bloc sticky, le plein écran passe réellement au-dessus de la barre d'action et des onglets.
  return full ? createPortal(content, document.body) : content;
}
