import { useLayoutEffect, useRef, type TextareaHTMLAttributes } from 'react';

// Zone de texte qui s'agrandit avec son contenu: jamais de défilement interne ni de texte coupé.
export function AutoGrow({ value, ...rest }: TextareaHTMLAttributes<HTMLTextAreaElement> & { value: string }) {
  const ref = useRef<HTMLTextAreaElement>(null);
  const fit = () => {
    const el = ref.current;
    if (!el) return;
    el.style.height = 'auto';
    // scrollHeight exclut les bordures (border-box): on les ajoute pour ne rien couper.
    el.style.height = `${el.scrollHeight + (el.offsetHeight - el.clientHeight)}px`;
  };
  useLayoutEffect(fit, [value]);
  useLayoutEffect(() => {
    // La largeur change (rotation, fenêtre, plein écran): la hauteur doit suivre.
    if (typeof ResizeObserver === 'undefined' || !ref.current) return;
    let w = ref.current.clientWidth;
    const ro = new ResizeObserver(() => {
      if (ref.current && ref.current.clientWidth !== w) {
        w = ref.current.clientWidth;
        fit();
      }
    });
    ro.observe(ref.current);
    return () => ro.disconnect();
  }, []);
  return <textarea ref={ref} rows={1} value={value} {...rest} />;
}
