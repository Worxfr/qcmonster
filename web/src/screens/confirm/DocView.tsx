import { Fragment, type ReactNode } from 'react';
import type { Block, Figure, Sentence } from '../../types';
import { blockPage, type DocModel } from './blocks';

export interface SentenceCtx { block: Block; index: number }

interface Props {
  model: DocModel;
  renderSentence: (s: Sentence, ctx: SentenceCtx) => ReactNode;
  renderFigure: (f: Figure, b: Block) => ReactNode;
  /** Ligne placee juste avant une phrase (coupe, bande de fiche). Rien = pas de ligne. `pageBreak`: la phrase ouvre une nouvelle page. */
  beforeSentence?: (s: Sentence, o: { first: boolean; pageBreak: boolean }) => ReactNode;
  /** Pastille « Page n » entre les pages. */
  pageMarks?: boolean;
  label: string;
}

/** Le document: titres, paragraphes, listes, formules et figures, chaque phrase etant rendue par `renderSentence`. */
export function DocView({ model, renderSentence, renderFigure, beforeSentence, pageMarks = true, label }: Props) {
  let lastPage: number | undefined;
  let prev: Sentence | undefined;
  const multi = model.pages.length > 1;
  return (
    <div className="doc" role="group" aria-label={label}>
      {model.blocks.map((b) => {
        const page = blockPage(model, b);
        const mark = pageMarks && multi && page !== undefined && page !== lastPage
          ? <p className="cf-pagemark" id={`cf-page-${page}`} key={`pg-${b.id}`}><span>Page {page}</span></p>
          : null;
        if (page !== undefined) lastPage = page;
        if (b.kind === 'figure') {
          const f = b.figureId ? model.figures.get(b.figureId) : undefined;
          return <Fragment key={b.id}>{mark}{f && renderFigure(f, b)}</Fragment>;
        }
        const sents = (b.sentenceIds ?? []).map((id) => model.byId.get(id)!).filter(Boolean);
        const parts: ReactNode[] = [];
        let run: { s: Sentence; i: number }[] = [];
        let firstOfRun = 0;
        const flush = () => {
          if (!run.length) return;
          const items = run.map(({ s, i }) => <Fragment key={s.id}>{renderSentence(s, { block: b, index: i })}</Fragment>);
          const key = `${b.id}-${firstOfRun}`;
          if (b.kind === 'titre') {
            const L = (b.level === 1 ? 'h3' : b.level === 2 ? 'h4' : 'h5') as 'h3' | 'h4' | 'h5';
            parts.push(<L key={key} className={`doc-h doc-h${b.level ?? 2}`}>{items}</L>);
          } else if (b.kind === 'liste') {
            const List = b.ordered ? 'ol' : 'ul';
            parts.push(
              <List key={key} className="doc-list" {...(b.ordered ? { start: firstOfRun + 1 } : {})}>
                {run.map(({ s }, k) => <li key={s.id}>{items[k]}</li>)}
              </List>,
            );
          } else if (b.kind === 'formule') {
            parts.push(<div key={key} className="doc-formula">{items}</div>);
          } else {
            parts.push(<p key={key} className="doc-p">{items}</p>);
          }
          run = [];
        };
        sents.forEach((s, i) => {
          const pageBreak = !!prev && model.pageOf.get(prev.id) !== model.pageOf.get(s.id);
          const line = beforeSentence?.(s, { first: i === 0, pageBreak });
          prev = s;
          if (line) {
            flush();
            parts.push(<Fragment key={`line-${s.id}`}>{line}</Fragment>);
          }
          if (!run.length) firstOfRun = i;
          run.push({ s, i });
        });
        flush();
        if (!parts.length) return null;
        // La pastille de page passe avant la premiere ligne de coupe du bloc.
        return <Fragment key={b.id}>{mark}{parts}</Fragment>;
      })}
    </div>
  );
}
