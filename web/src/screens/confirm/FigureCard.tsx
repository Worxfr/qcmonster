import { useEffect, useId, useState } from 'react';
import type { Figure } from '../../types';
import type { FigChoice } from './storage';

export const KIND: Record<Figure['kind'], string> = { schema: 'Schéma', graphique: 'Graphique', tableau: 'Tableau', carte: 'Carte', photo: 'Photo', autre: 'Figure' };
export const ALT_MAX = 300;

/** Image d'une figure. Une figure est toujours une image: si elle ne charge pas, on le dit et on propose de recharger (jamais de texte a la place). */
function FigImage({ figure, alt, onReload }: { figure: Figure; alt: string; onReload?: () => void }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [figure.url]);
  if (failed) {
    return (
      <div className="fig-missing" role="group" aria-label={`Image indisponible : ${alt}`}>
        <p>L'image ne s'affiche pas. Le lien a peut-être expiré.</p>
        {onReload && <button type="button" className="btn btn-ghost btn-small" onClick={onReload}>Recharger l'image</button>}
      </div>
    );
  }
  return <img className="fig-img" src={figure.url} alt={alt} loading="lazy" onError={() => setFailed(true)} />;
}

/** Figure d'un cours ou d'une fiche (lecture seule). */
export function FigureView({ figure }: { figure: Figure }) {
  return (
    <figure className="fig">
      <FigImage figure={figure} alt={figure.alt} />
      <figcaption>
        <span className="fig-kind">{figure.box ? KIND[figure.kind] : 'Page entière'}</span>
        {figure.caption ? <span className="fig-caption"> {figure.caption}</span> : null}
      </figcaption>
    </figure>
  );
}

/** Figure proposee a la relecture: l'eleve choisit de la garder (rien n'est garde par defaut) et peut corriger sa description. */
export function FigureCard({ figure, choice, onChange, onReload }: { figure: Figure; choice: FigChoice | undefined; onChange: (c: FigChoice) => void; onReload: () => void }) {
  const id = useId();
  const keep = choice?.keep === true;
  const alt = choice?.alt ?? figure.alt;
  return (
    <figure className={`fig fig-review${keep ? ' kept' : ''}`} aria-label={`${KIND[figure.kind]} de la page ${figure.page}`}>
      <div className="fig-head">
        <span className="fig-kind">{figure.box ? KIND[figure.kind] : 'Page entière'}</span>
        <span className="muted">page {figure.page}</span>
      </div>
      <FigImage figure={figure} alt={alt} onReload={onReload} />
      {figure.caption && <figcaption className="fig-caption">{figure.caption}</figcaption>}
      {!figure.box && <p className="fig-note">Je n'ai pas trouvé le cadre exact : voici la page entière. Tu peux la garder ou non.</p>}
      <label className={`fig-keep${keep ? ' on' : ''}`}>
        <input type="checkbox" checked={keep} onChange={(e) => onChange({ ...choice, keep: e.target.checked })} />
        <span>Garder cette image dans mon cours</span>
      </label>
      <p className="fig-help" id={`${id}-h`}>{keep ? 'Elle restera dans ton cours jusqu’à ce que tu le supprimes.' : 'Si tu ne la gardes pas, elle est effacée avec la photo.'}</p>
      {keep && (
        <label className="fig-alt">
          Description de l'image (pour ceux qui ne la voient pas)
          <input value={alt} maxLength={ALT_MAX} onChange={(e) => onChange({ keep: true, alt: e.target.value })} aria-describedby={`${id}-h`} />
        </label>
      )}
    </figure>
  );
}
