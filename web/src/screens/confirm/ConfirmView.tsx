import { useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../../api';
import { Card, ErrorBox, Loading } from '../../components/ui';
import { errMsg, useLoad } from '../../hooks';
import type { Job, Sentence } from '../../types';
import { AutoGrow } from './AutoGrow';
import { PhotoViewer } from './PhotoViewer';
import { clearEdits, loadEdits, saveEdits } from './storage';
import './confirm.css';

const plural = (n: number, one: string, many: string) => (n > 1 ? many : one);

export function ConfirmView({ id, onDone }: { id: string; onDone: (j: Job) => void }) {
  const t = useLoad(() => api.transcription(id), [id]);
  // Pendant un rechargement (photo expirée) on garde l'écran et les saisies.
  if (!t.data) return t.loading ? <Loading /> : <ErrorBox message={t.error} />;
  return <ConfirmBody id={id} tr={t.data} onDone={onDone} reloadPhotos={t.reload} />;
}

type Tr = NonNullable<ReturnType<typeof useLoad<Awaited<ReturnType<typeof api.transcription>>>>['data']>;

function ConfirmBody({ id, tr, onDone, reloadPhotos }: { id: string; tr: Tr; onDone: (j: Job) => void; reloadPhotos: () => void }) {
  const original = useMemo(() => {
    const m = new Map<string, string>();
    tr.pages.forEach((p) => p.sentences.forEach((s) => m.set(s.id, s.text)));
    return m;
  }, [tr]);
  const [edits, setEdits] = useState<Record<string, string>>(() => loadEdits(id, original));
  const [pageIdx, setPageIdx] = useState(0);
  const [photoOpen, setPhotoOpen] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef(true);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    saveEdits(id, edits);
  }, [id, edits]);

  const textOf = (s: Sentence) => edits[s.id] ?? s.text;
  const isChanged = (s: Sentence) => textOf(s) !== s.text;
  const isEmpty = (s: Sentence) => textOf(s).trim() === '';
  const all = tr.pages.flatMap((p) => p.sentences);
  const changed = all.filter(isChanged).length;
  const empty = all.filter(isEmpty).length;
  const pages = tr.pages;
  const page = pages[Math.min(pageIdx, pages.length - 1)];
  const idx = pages.indexOf(page);
  const pageChanged = (p: (typeof pages)[number]) => p.sentences.filter(isChanged).length;

  function edit(s: Sentence, text: string) {
    setEdits((e) => {
      const next = { ...e };
      if (text === s.text) delete next[s.id];
      else next[s.id] = text;
      return next;
    });
  }

  async function send() {
    if (empty) return setError('Une phrase est vide. Écris-la ou remets la version lue.');
    setBusy(true);
    setError(null);
    const corrections: Sentence[] = all.filter(isChanged).map((s) => ({ id: s.id, text: textOf(s) }));
    try {
      const job = await api.confirm(id, corrections);
      clearEdits(id);
      onDone(job);
    } catch (e) {
      // Le traitement a pu changer d'état entre-temps (annulé, expiré, déjà validé dans un autre onglet).
      if (e instanceof ApiError && (e.status === 409 || e.code === 'etat_invalide')) {
        try {
          const j = await api.job(id);
          if (j.state !== 'a_confirmer') {
            clearEdits(id);
            return onDone(j);
          }
        } catch {
          /* on affiche l'erreur d'origine */
        }
      }
      setError(errMsg(e));
      setBusy(false);
    }
  }

  const summary = `${all.length} ${plural(all.length, 'phrase', 'phrases')}, ${changed} ${plural(changed, 'corrigée', 'corrigées')}`;
  const photo = tr.photoUrls[idx];
  let n = 0;
  for (let i = 0; i < idx; i++) n += pages[i].sentences.length;

  return (
    <Card title="Vérifie ce que j'ai lu">
      <div className="confirm">
        <header className="cf-head">
          <p className="cf-summary" role="status" aria-live="polite">{summary}</p>
          <p className="cf-help">J'ai lu ta page, mais je peux me tromper. Regarde la photo et corrige les mots qui ne vont pas. Si une phrase est juste, ne touche à rien.</p>
        </header>

        {pages.length > 1 && (
          <div className="cf-pages">
            <div role="tablist" aria-label="Pages du cours" className="cf-tablist">
              {pages.map((p, i) => (
                <button key={p.page} type="button" role="tab" id={`cf-tab-${i}`} aria-selected={i === idx} aria-controls="cf-panel" className="cf-tab" onClick={() => setPageIdx(i)}>
                  Page {p.page}
                  {pageChanged(p) > 0 && <span className="cf-dot" aria-label={`${pageChanged(p)} ${plural(pageChanged(p), 'correction', 'corrections')}`}>{pageChanged(p)}</span>}
                </button>
              ))}
            </div>
            <p className="cf-counter" aria-live="polite">Page {idx + 1} sur {pages.length}</p>
          </div>
        )}

        <div className="cf-layout">
          <aside className="cf-photo" aria-label="Photo de la page">
            <button type="button" className="cf-fold" aria-expanded={photoOpen} aria-controls="cf-photo-body" onClick={() => setPhotoOpen((o) => !o)}>
              {photoOpen ? 'Cacher la photo' : 'Voir la photo'}
            </button>
            <div id="cf-photo-body" hidden={!photoOpen}>
              <PhotoViewer src={photo} label={`Photo de ta page ${page.page}`} onReload={reloadPhotos} />
            </div>
          </aside>

          <div className="cf-texts" id="cf-panel" role={pages.length > 1 ? 'tabpanel' : undefined} aria-labelledby={pages.length > 1 ? `cf-tab-${idx}` : undefined}>
            {page.sentences.length === 0 ? (
              <p className="cf-empty">Je n'ai rien lu sur cette page. Vérifie la photo ou recommence avec une photo plus nette.</p>
            ) : (
              <ol className="cf-list">
                {page.sentences.map((s, i) => {
                  const mod = isChanged(s);
                  const blank = isEmpty(s);
                  return (
                    <li key={s.id} className={`cf-item${mod ? ' mod' : ''}${blank ? ' bad' : ''}`}>
                      <div className="cf-itemhead">
                        <span className="cf-num" aria-hidden="true">{n + i + 1}</span>
                        <label htmlFor={`cf-s-${s.id}`} className="cf-label">Phrase {n + i + 1}</label>
                        <span className={`cf-state ${mod ? 'is-mod' : 'is-same'}`}>{mod ? 'Modifiée' : 'Inchangée'}</span>
                      </div>
                      <AutoGrow
                        id={`cf-s-${s.id}`}
                        className="cf-text"
                        value={textOf(s)}
                        maxLength={2000}
                        aria-invalid={blank || undefined}
                        aria-describedby={blank ? `cf-err-${s.id}` : undefined}
                        onChange={(e) => edit(s, e.target.value)}
                      />
                      {blank && <p id={`cf-err-${s.id}`} className="cf-fielderr">Une phrase ne peut pas être vide.</p>}
                      {mod && (
                        <button type="button" className="cf-undo" onClick={() => edit(s, s.text)}>
                          Remettre la version lue<span className="sr-only"> pour la phrase {n + i + 1}</span>
                        </button>
                      )}
                    </li>
                  );
                })}
              </ol>
            )}
            {pages.length > 1 && (
              <div className="cf-nav">
                <button type="button" className="btn btn-ghost" disabled={idx === 0} onClick={() => setPageIdx(idx - 1)}>Page précédente</button>
                <button type="button" className="btn btn-ghost" disabled={idx === pages.length - 1} onClick={() => setPageIdx(idx + 1)}>Page suivante</button>
              </div>
            )}
          </div>
        </div>

        <div className="cf-actions">
          <ErrorBox message={error} />
          {empty > 0 && <p className="cf-fielderr">Il reste {empty} {plural(empty, 'phrase vide', 'phrases vides')}.</p>}
          <button type="button" className="btn btn-big cf-send" onClick={send} disabled={busy || empty > 0} aria-busy={busy}>
            {busy ? <><span className="cf-spin" aria-hidden="true" /> Vérification en cours…</> : "C'est bon, vérifie !"}
          </button>
        </div>
      </div>
    </Card>
  );
}
