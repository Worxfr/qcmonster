import { useState } from 'react';
import { ApiError, api } from '../api';
import { Card, ErrorBox } from '../components/ui';
import { errMsg } from '../hooks';
import { plural } from '../labels';
import { go } from '../router';
import type { PracticeSession } from '../types';
import { QuizRun } from './Quiz';

export const SIZES = [5, 10, 15, 20] as const;
export type Size = (typeof SIZES)[number];

/** Choix « Combien de questions ? » (une valeur par defaut: 10). */
export function SizePicker({ value, onChange }: { value: number; onChange: (n: Size) => void }) {
  return (
    <fieldset className="size-picker">
      <legend>Combien de questions ?</legend>
      <div className="btn-row">
        {SIZES.map((n) => (
          <button key={n} type="button" className={`btn btn-small${value === n ? '' : ' btn-ghost'}`} aria-pressed={value === n} onClick={() => onChange(n)}>{n}</button>
        ))}
      </div>
    </fieldset>
  );
}

/** S'entrainer sur plusieurs fiches ou un dossier (#72). L'adresse ne porte que des identifiants: jamais une question. */
export function Practice({ docIds, folderId }: { docIds?: string[]; folderId?: string }) {
  const [size, setSize] = useState<Size>(10);
  const [session, setSession] = useState<PracticeSession | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const body = () => (folderId ? { folderId, size } : { docIds: docIds ?? [], size });

  async function start() {
    setBusy(true);
    setError(null);
    try {
      setSession(await api.practice(body()));
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'aucune_question' ? 'Ces fiches n\'ont pas encore de questions.' : errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  if (session) {
    const skipped = session.skipped.filter((s) => s.reason === 'sans_question').length;
    return (
      <QuizRun
        key={session.docIds.join(',')}
        initial={session}
        reopen={() => api.practice(body())}
        multi
        back={folderId ? { label: 'Retour aux dossiers', path: '/folders' } : { label: 'Retour à mes cours', path: '/docs' }}
        notice={skipped > 0 ? `${skipped} ${plural(skipped, 'fiche n\'a pas encore de questions', 'fiches n\'ont pas encore de questions')}.` : undefined}
      />
    );
  }
  const n = docIds?.length ?? 0;
  return (
    <Card title="S'entraîner">
      <p>{folderId ? 'On pose des questions sur les fiches de ce dossier, à parts égales.' : `On pose des questions sur tes ${n} ${plural(n, 'fiche', 'fiches')}, à parts égales.`}</p>
      <SizePicker value={size} onChange={setSize} />
      <ErrorBox message={error} />
      <button className="btn btn-big" disabled={busy || (!folderId && n === 0)} onClick={() => void start()}>🎮 Commencer</button>
      <p><button type="button" className="link" onClick={() => go(folderId ? '/folders' : '/docs')}>‹ Retour</button></p>
    </Card>
  );
}
