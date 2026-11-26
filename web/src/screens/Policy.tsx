import { Fragment, type ReactNode } from 'react';
import policy from '../../../docs/legal/politique-confidentialite.md?raw';
import { Card } from '../components/ui';

/** Texte légal unique: le fichier docs/legal est la source, cette page l'affiche (rendu minimal, sans HTML brut ni dépendance). */
const inline = (t: string): ReactNode[] =>
  t.split(/(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`)/).map((p, i) =>
    p.startsWith('**') ? <strong key={i}>{p.slice(2, -2)}</strong> : p.startsWith('`') ? <code key={i}>{p.slice(1, -1)}</code> : p.startsWith('*') && p.length > 2 ? <em key={i}>{p.slice(1, -1)}</em> : <Fragment key={i}>{p}</Fragment>,
  );

export function renderPolicy(md: string): ReactNode[] {
  const out: ReactNode[] = [];
  const lines = md.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i];
    if (!l.trim()) continue;
    if (l.startsWith('## ')) out.push(<h2 key={i}>{l.slice(3)}</h2>);
    else if (l.startsWith('# ')) continue; // le titre est dans la carte
    else if (l.startsWith('- ')) {
      const items: string[] = [];
      while (i < lines.length && lines[i].startsWith('- ')) items.push(lines[i++].slice(2));
      i--;
      out.push(<ul key={i}>{items.map((x, k) => <li key={k}>{inline(x)}</li>)}</ul>);
    } else if (l.startsWith('|')) {
      const rows: string[][] = [];
      while (i < lines.length && lines[i].startsWith('|')) rows.push(lines[i++].split('|').slice(1, -1).map((c) => c.trim()));
      i--;
      const [head, , ...body] = rows;
      out.push(
        <table key={i}>
          <thead><tr>{head.map((c, k) => <th key={k} scope="col">{inline(c)}</th>)}</tr></thead>
          <tbody>{body.map((r, k) => <tr key={k}>{r.map((c, j) => <td key={j}>{inline(c)}</td>)}</tr>)}</tbody>
        </table>,
      );
    } else out.push(<p key={i}>{inline(l)}</p>);
  }
  return out;
}

/** Page publique (#/politique): lisible sans être connecté, par le parent comme par l'élève. */
export function Policy() {
  return (
    <main className="page" id="contenu">
      <Card title="Politique de confidentialité">
        {renderPolicy(policy)}
        <p><a className="btn btn-small" href="#/">Retour</a></p>
      </Card>
    </main>
  );
}

/** Lien vers la politique, ouvert dans un nouvel onglet (`target=_blank`): on la lit sans perdre le formulaire en cours. */
export const PolicyLink = () => <a href="#/politique" target="_blank" rel="noopener">politique de confidentialité</a>;
