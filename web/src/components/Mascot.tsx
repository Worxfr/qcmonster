import { stageName } from '../game';

interface Props { stage: number; size?: number; sleeping?: boolean; label?: boolean }

/**
 * Mascotte en SVG, 5 stades. shortcut: illustration provisoire a valider par le proprietaire
 * (design-v2 10.3): elle peut etre remplacee par des visuels commandes sans toucher aux ecrans.
 */
export function Mascot({ stage, size = 160, sleeping = false, label = true }: Props) {
  const s = Math.min(5, Math.max(1, stage));
  const body = ['#fde68a', '#86efac', '#5eead4', '#a78bfa', '#f472b6'][s - 1];
  const dark = ['#b45309', '#15803d', '#0f766e', '#6d28d9', '#be185d'][s - 1];
  const r = [0, 62, 70, 78, 84][s - 1];
  const eyes = sleeping ? (
    <g stroke="#2b2150" strokeWidth="5" strokeLinecap="round" fill="none">
      <path d="M72 100 q10 8 20 0" />
      <path d="M108 100 q10 8 20 0" />
    </g>
  ) : (
    <g>
      <circle cx="82" cy="98" r="11" fill="#fff" />
      <circle cx="118" cy="98" r="11" fill="#fff" />
      <circle cx="84" cy="100" r="5.5" fill="#2b2150" />
      <circle cx="120" cy="100" r="5.5" fill="#2b2150" />
    </g>
  );
  return (
    <figure className="mascot" style={{ width: size }}>
      <svg viewBox="0 0 200 200" width={size} height={size} role="img" aria-label={`Mascotte : ${stageName(s)}${sleeping ? ', endormie' : ''}`}>
        {s === 5 && (
          <g aria-hidden="true">
            <circle cx="100" cy="110" r="96" fill="#fde047" opacity="0.35" />
            <circle cx="100" cy="110" r="88" fill="none" stroke="#f59e0b" strokeWidth="3" strokeDasharray="6 8" />
          </g>
        )}
        {s === 4 && <path d="M40 130 q-18 50 10 62 l50-24 50 24 q28-12 10-62 z" fill="#ef4444" aria-hidden="true" />}
        {s === 1 ? (
          <g>
            <ellipse cx="100" cy="115" rx="52" ry="68" fill={body} stroke={dark} strokeWidth="5" />
            <path d="M52 105 l16 -16 l16 16 l16 -16 l16 16 l16 -16 l16 16 l14 -14" fill="none" stroke={dark} strokeWidth="5" strokeLinejoin="round" />
            <g fill={dark} opacity="0.5"><circle cx="80" cy="150" r="7" /><circle cx="120" cy="140" r="5" /><circle cx="105" cy="165" r="4" /></g>
            {sleeping ? null : <g><circle cx="88" cy="128" r="6" fill="#2b2150" /><circle cx="112" cy="128" r="6" fill="#2b2150" /></g>}
          </g>
        ) : (
          <g>
            <ellipse cx="100" cy="190" rx={r * 0.7} ry="7" fill="#2b2150" opacity="0.12" />
            <path d={`M${100 - r} 130 a${r} ${r} 0 0 1 ${2 * r} 0 v14 a${r} 22 0 0 1 -${2 * r} 0 z`} fill={body} stroke={dark} strokeWidth="5" />
            <path d="M62 62 l-8 -22 l22 12 z M138 62 l8 -22 l-22 12 z" fill={dark} />
            {eyes}
            <ellipse cx="68" cy="122" rx="9" ry="5" fill="#fb7185" opacity="0.6" />
            <ellipse cx="132" cy="122" rx="9" ry="5" fill="#fb7185" opacity="0.6" />
            <path d="M84 126 q16 18 32 0 z" fill="#2b2150" stroke="#2b2150" strokeWidth="3" strokeLinejoin="round" />
            <path d="M92 127 l4 7 l4 -7 M102 127 l4 7 l4 -7" fill="#fff" stroke="#fff" strokeWidth="1" />
            {s >= 3 && (
              <g aria-hidden="true">
                <circle cx="82" cy="98" r="17" fill="none" stroke="#2b2150" strokeWidth="4" />
                <circle cx="118" cy="98" r="17" fill="none" stroke="#2b2150" strokeWidth="4" />
                <path d="M99 98 h2" stroke="#2b2150" strokeWidth="4" />
              </g>
            )}
            {s === 5 && <path d="M70 52 l10 -18 l10 12 l10 -18 l10 18 l10 -12 l10 18 z" fill="#facc15" stroke="#b45309" strokeWidth="3" strokeLinejoin="round" aria-hidden="true" />}
          </g>
        )}
        {sleeping && <text x="150" y="60" fontSize="26" fontWeight="700" fill="#6d28d9" aria-hidden="true">z z</text>}
      </svg>
      {label && <figcaption>{stageName(s)}</figcaption>}
    </figure>
  );
}
