import { memo, useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { ApiError, api } from '../../api';
import { FolderSelect, useFolders } from '../../components/FolderSelect';
import { Card, ErrorBox, Loading } from '../../components/ui';
import { errMsg, useLoad } from '../../hooks';
import { SUBJECTS, SUBJECT_IDS, plural, subjectLabel } from '../../labels';
import { go } from '../../router';
import type { Job, Sentence, Subject } from '../../types';
import { AutoGrow } from './AutoGrow';
import { PhotoViewer } from './PhotoViewer';
import { MIN_WORDS, TITLE_MAX, TOPIC_MAX, addCut, confirmBody, initSections, maxSections, plan, removeCut, sanitize, sectionIndex, type Sec } from './sections';
import { clearEdits, loadEdits, loadSections, saveEdits, saveSections } from './storage';
import './confirm.css';

/** Memorise: l'interrogation du statut ne re-rend pas la relecture pendant la frappe. */
export const ConfirmView = memo(function ConfirmView({ id, onDone }: { id: string; onDone: (j: Job, fiches?: number) => void }) {
  const t = useLoad(() => api.transcription(id), [id]);
  // Pendant un rechargement (photo expirée), même raté, on garde l'écran et les saisies.
  const last = useRef<Tr | null>(null);
  if (t.data) last.current = t.data;
  const tr = t.data ?? last.current;
  if (!tr) {
    return t.loading ? <Loading /> : (
      <>
        <ErrorBox message={t.error} />
        <button type="button" className="btn btn-ghost" onClick={t.reload}>Réessayer</button>
      </>
    );
  }
  return <ConfirmBody id={id} tr={tr} onDone={onDone} reloadPhotos={t.reload} reloading={t.loading} reloadError={t.data ? null : t.error} />;
});

type Tr = NonNullable<ReturnType<typeof useLoad<Awaited<ReturnType<typeof api.transcription>>>>['data']>;
type Pg = Tr['pages'][number];

/** Libelle d'une phrase sur plusieurs pages: « Suite page 3 » ou « Pages 2 à 4 ». */
const spanLabel = (s: Sentence) => {
  const p = s.pages;
  if (!p || p.length < 2) return null;
  return p.length === 2 ? `Suite page ${p[1]}` : `Pages ${p[0]} à ${p[p.length - 1]}`;
};
const isSplit = (s: Sentence) => (s.pages?.length ?? 0) > 1;

function ConfirmBody({ id, tr, onDone, reloadPhotos, reloading, reloadError }: { id: string; tr: Tr; onDone: (j: Job, fiches?: number) => void; reloadPhotos: () => void; reloading: boolean; reloadError: string | null }) {
  const pages = tr.pages;
  const all = useMemo(() => pages.flatMap((p) => p.sentences), [pages]);
  const original = useMemo(() => new Map(all.map((s) => [s.id, s.text])), [all]);
  const [edits, setEdits] = useState<Record<string, string>>(() => loadEdits(id, original));
  const proposed = useRef(false);
  const [secs, setSecs] = useState<Sec[]>(() => {
    const saved = sanitize(loadSections(id), all, pages.length);
    if (saved) return saved;
    const init = initSections(all, tr.suggestedSections, tr.suggestedSubject, tr.suggestedTopic, pages.length);
    proposed.current = init.length > 1;
    return init;
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [flash, setFlash] = useState<string | null>(null);
  const [focusId, setFocusId] = useState<string | null>(null);
  const { folders, add: addFolder } = useFolders(); // un seul chargement pour toutes les fiches
  // Sur petit écran la photo est repliée: on voit les phrases sans défiler.
  const [photoOpen, setPhotoOpen] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 900px)').matches);
  const rootEl = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const first = useRef(true);

  // Hauteur réelle de la barre d'onglets (fixe): la barre d'action se pose juste au-dessus.
  useEffect(() => {
    const tabs = document.querySelector<HTMLElement>('.tabs');
    const el = rootEl.current;
    if (!tabs || !el) return;
    const set = () => el.style.setProperty('--tabs-h', `${tabs.offsetHeight}px`);
    set();
    if (typeof ResizeObserver === 'undefined') return;
    const ro = new ResizeObserver(set);
    ro.observe(tabs);
    return () => ro.disconnect();
  }, []);

  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    saveEdits(id, edits);
    saveSections(id, secs);
  }, [id, edits, secs]);

  // Apres une coupe ou son retrait, le bouton clique disparait: on rend le focus a un endroit logique.
  useEffect(() => {
    if (!focusId) return;
    document.getElementById(focusId)?.focus();
    setFocusId(null);
  }, [focusId, secs]);

  useEffect(() => {
    if (!flash) return;
    document.getElementById(`cf-item-${flash}`)?.scrollIntoView?.({ block: 'center' });
    const t = setTimeout(() => setFlash(null), 2200);
    return () => clearTimeout(t);
  }, [flash]);

  const textOf = (s: Sentence) => edits[s.id] ?? s.text;
  const isChanged = (s: Sentence) => textOf(s) !== s.text;
  const isEmpty = (s: Sentence) => textOf(s).trim() === '';
  const changed = all.filter(isChanged).length;
  const empty = all.filter(isEmpty).length;
  const page = pages[Math.min(pageIdx, pages.length - 1)];
  const idx = pages.indexOf(page);
  const pageChanged = (p: Pg) => p.sentences.filter(isChanged).length;
  const secOf = useMemo(() => sectionIndex(secs, all), [secs, all]);
  const gIndex = useMemo(() => new Map(all.map((s, i) => [s.id, i])), [all]);
  const max = maxSections(pages.length);
  const pl = plan(secs, all, textOf);
  const startOf = new Set(secs.map((s) => s.from));

  function edit(s: Sentence, text: string) {
    setEdits((e) => {
      const next = { ...e };
      if (text === s.text) delete next[s.id];
      else next[s.id] = text;
      return next;
    });
  }
  const patch = (from: string, p: Partial<Sec>) => setSecs((l) => l.map((s) => (s.from === from ? { ...s, ...p } : s)));
  const showPageOf = (sentenceId: string) => {
    const i = pages.findIndex((p) => p.sentences.some((s) => s.id === sentenceId));
    if (i >= 0) setPageIdx(i);
  };
  function cut(before: string) {
    setSecs((l) => addCut(l, all, before));
    showPageOf(before);
    setFocusId(`cf-sec-subject-${before}`);
  }
  function uncut(from: string) {
    setSecs((l) => removeCut(l, from));
    showPageOf(from);
    setFocusId(`cf-cut-${from}`);
  }
  const goPage = (n: number) => {
    const i = pages.findIndex((p) => p.page === n);
    if (i >= 0) setPageIdx(i);
  };

  const blocker =
    !all.length ? "Il n'y a aucun texte à vérifier. Refais la photo pour continuer."
    : empty ? `Il reste ${empty} ${plural(empty, 'phrase vide', 'phrases vides')}.`
    : pl.kept === 0 ? 'Garde au moins une fiche.'
    : pl.missingSubject ? 'Choisis la matière de chaque fiche.'
    : pl.words < MIN_WORDS ? `Il faut au moins ${MIN_WORDS} mots dans les parties gardées.`
    : null;

  async function send() {
    if (blocker) return setError(blocker);
    setBusy(true);
    setError(null);
    const corrections: Sentence[] = all.filter(isChanged).map((s) => ({ id: s.id, text: textOf(s) }));
    try {
      const job = await api.confirm(id, corrections, confirmBody(secs));
      clearEdits(id);
      onDone(job, pl.kept);
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
      setError(e instanceof ApiError && e.status === 404 ? `${errMsg(e)} Choisis un autre dossier.` : errMsg(e));
      setBusy(false);
    }
  }

  const summary = `${all.length} ${plural(all.length, 'phrase', 'phrases')}, ${changed} ${plural(changed, 'corrigée', 'corrigées')}${secs.length > 1 ? `, ${pl.kept} ${plural(pl.kept, 'fiche', 'fiches')}` : ''}`;
  const photo = tr.photoUrls[idx];
  function tabKey(e: KeyboardEvent, i: number) {
    const to = e.key === 'ArrowRight' ? (i + 1) % pages.length : e.key === 'ArrowLeft' ? (i - 1 + pages.length) % pages.length : e.key === 'Home' ? 0 : e.key === 'End' ? pages.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setPageIdx(to);
    document.getElementById(`cf-tab-${to}`)?.focus();
  }
  let n = 0;
  for (let i = 0; i < idx; i++) n += pages[i].sentences.length;

  // Phrases venues d'une page precedente qui se poursuivent sur celle-ci.
  const carried = all.filter((s) => isSplit(s) && s.pages!.slice(1).includes(page.page));
  const nextFirst = pages[idx + 1]?.sentences[0];
  const atLimit = secs.length >= max;
  const limitText = `${max} fiches au maximum pour ${pages.length} ${plural(pages.length, 'page', 'pages')}`;

  const cutBar = (before: Sentence, boundary = false) => {
    if (startOf.has(before.id) || gIndex.get(before.id) === 0) return null;
    return (
      <li className="cf-cutrow" key={`cut-${before.id}${boundary ? '-b' : ''}`}>
        <button type="button" id={`cf-cut-${before.id}`} className="cf-cut" disabled={atLimit} onClick={() => cut(before.id)} aria-label={`Couper ici${boundary ? ', entre deux pages' : ''}, avant la phrase ${(gIndex.get(before.id) ?? 0) + 1}`}>
          <span aria-hidden="true">✂</span> {boundary ? 'Couper ici, entre les pages' : 'Couper ici'}
        </button>
        {atLimit && <span className="cf-cutlimit">{limitText}</span>}
      </li>
    );
  };

  const band = (s: Sec, i: number) => (
    <li className={`cf-band sec-${i % 6}`} key={`band-${s.from}`} aria-label={`Fiche ${i + 1}`}>
      <div className="cf-bandhead">
        <span className="cf-secnum">Fiche {i + 1}</span>
        {s.subject && <span className="cf-bandsub">{subjectLabel(s.subject)}</span>}
        {i > 0 && <button type="button" className="cf-uncut" onClick={() => uncut(s.from)}>Retirer cette coupe<span className="sr-only"> avant la fiche {i + 1}</span></button>}
      </div>
      <div className="cf-fields">
        <label>Matière
          <select id={`cf-sec-subject-${s.from}`} value={s.subject} onChange={(e) => patch(s.from, { subject: e.target.value as Subject })} aria-invalid={!s.subject && !s.ignore ? true : undefined}>
            <option value="">Choisis…</option>
            {SUBJECT_IDS.map((k) => <option key={k} value={k}>{SUBJECTS[k]}</option>)}
          </select>
        </label>
        <label>Sujet
          <input value={s.topic} maxLength={TOPIC_MAX} placeholder="Ex. La Révolution française" onChange={(e) => patch(s.from, { topic: e.target.value })} />
        </label>
        <details className="cf-more">
          <summary>Plus d'options</summary>
          <div className="cf-fields">
            <label>Titre (facultatif)
              <input value={s.title} maxLength={TITLE_MAX} placeholder="Je propose un titre si tu n'en mets pas" onChange={(e) => patch(s.from, { title: e.target.value })} />
            </label>
            <FolderSelect label="Dossier (facultatif)" value={s.folderId} onChange={(f) => patch(s.from, { folderId: f })} folders={folders} onCreated={addFolder} />
          </div>
        </details>
      </div>
      <label className="check cf-ignore">
        <input type="checkbox" checked={s.ignore} onChange={(e) => patch(s.from, { ignore: e.target.checked })} />
        Ne pas faire de fiche pour cette partie
      </label>
      {s.ignore && <p className="cf-ignnote">Ignorée = gardée dans ton cours complet, sans fiche.</p>}
    </li>
  );

  return (
    <Card title="Vérifie ce que j'ai lu">
      <div className="confirm" ref={rootEl}>
        <header className="cf-head">
          <p className="cf-summary" role="status" aria-live="polite">{summary}</p>
          <p className="cf-words">{pl.words} {plural(pl.words, 'mot gardé', 'mots gardés')}</p>
          <details className="cf-helpbox">
            <summary>Comment ça marche ?</summary>
            <p className="cf-help">J'ai lu ta page, mais je peux me tromper. Regarde la photo et corrige les mots qui ne vont pas. Si une phrase est juste, ne touche à rien.</p>
            <p className="cf-help">Ton cours parle de plusieurs sujets ? Touche « Couper ici » entre deux phrases : tu auras une fiche par sujet, et ton cours complet reste gardé.</p>
          </details>
          {proposed.current && secs.length > 1 && <p className="notice">J'ai proposé {secs.length} fiches, change-les si besoin.</p>}
        </header>

        {pages.length > 1 && (
          <div className="cf-pages">
            <div role="tablist" aria-label="Pages du cours" className="cf-tablist">
              {pages.map((p, i) => (
                <button key={p.page} type="button" role="tab" id={`cf-tab-${i}`} aria-selected={i === idx} aria-controls="cf-panel" tabIndex={i === idx ? 0 : -1} className="cf-tab" onClick={() => setPageIdx(i)} onKeyDown={(e) => tabKey(e, i)}>
                  Page {p.page}
                  {pageChanged(p) > 0 && <><span className="cf-dot" aria-hidden="true">{pageChanged(p)}</span><span className="sr-only">, {pageChanged(p)} {plural(pageChanged(p), 'correction', 'corrections')}</span></>}
                </button>
              ))}
            </div>
            <p className="cf-counter">Page {idx + 1} sur {pages.length}</p>
          </div>
        )}

        <div className="cf-layout">
          <aside className="cf-photo" aria-label="Photo de la page">
            <button type="button" className="cf-fold" aria-expanded={photoOpen} aria-controls="cf-photo-body" onClick={() => setPhotoOpen((o) => !o)}>
              {photoOpen ? 'Cacher la photo' : 'Voir la photo'}
            </button>
            <div id="cf-photo-body" hidden={!photoOpen}>
              <PhotoViewer src={photo} label={`Photo de ta page ${page.page}`} onReload={reloadPhotos} reloading={reloading} reloadError={reloadError} />
            </div>
          </aside>

          <div className="cf-texts" id="cf-panel" role={pages.length > 1 ? 'tabpanel' : undefined} aria-labelledby={pages.length > 1 ? `cf-tab-${idx}` : undefined}>
            {carried.map((s) => (
              <p key={`carry-${s.id}`} className="cf-carry">
                <span>La première phrase continue la page {s.pages![0]}</span>
                <button type="button" className="cf-link" onClick={() => { goPage(s.pages![0]); setFlash(s.id); }}>Voir la phrase</button>
              </p>
            ))}
            {page.sentences.length === 0 ? (
              carried.length > 0 ? (
                <div className="cf-empty"><p>Cette page prolonge la phrase de la page {carried[0].pages![0]}.</p></div>
              ) : (
                <div className="cf-empty">
                  <p>Je n'ai rien lu sur {pages.length > 1 ? 'cette page' : 'ta photo'}. Essaie avec une photo plus nette, bien à plat et bien éclairée.</p>
                  <button type="button" className="btn btn-ghost" onClick={() => go('/scan')}>Refaire la photo</button>
                </div>
              )
            ) : (
              <ol className="cf-list">
                {page.sentences.map((s, i) => {
                  const mod = isChanged(s);
                  const blank = isEmpty(s);
                  const si = secOf.get(s.id) ?? 0;
                  const sec = secs[si];
                  const label = spanLabel(s);
                  return [
                    // coupe possible juste avant la phrase (sur la frontiere, elle est aussi proposee en bas de la page precedente)
                    startOf.has(s.id) ? band(secs[si], si) : cutBar(s),
                    <li key={s.id} id={`cf-item-${s.id}`} className={`cf-item sec-${si % 6}${mod ? ' mod' : ''}${blank ? ' bad' : ''}${sec.ignore ? ' ign' : ''}${flash === s.id ? ' flash' : ''}`}>
                      <div className="cf-itemhead">
                        <span className="cf-num" aria-hidden="true">{n + i + 1}</span>
                        <label htmlFor={`cf-s-${s.id}`} className="cf-label">Phrase {n + i + 1}</label>
                        {secs.length > 1 && <span className="cf-secpill">{sec.ignore ? `Fiche ${si + 1} · ignorée` : `Fiche ${si + 1}`}</span>}
                        {label && <span className="cf-span">{label}</span>}
                        <span id={`cf-st-${s.id}`} className={`cf-state ${mod ? 'is-mod' : 'is-same'}`}>{mod ? 'Modifiée' : 'Inchangée'}</span>
                      </div>
                      <AutoGrow
                        id={`cf-s-${s.id}`}
                        className="cf-text"
                        value={textOf(s)}
                        maxLength={2000}
                        aria-invalid={blank || undefined}
                        aria-describedby={`cf-st-${s.id}${blank ? ` cf-err-${s.id}` : ''}`}
                        onChange={(e) => edit(s, e.target.value)}
                      />
                      {blank && <p id={`cf-err-${s.id}`} className="cf-fielderr">Une phrase ne peut pas être vide.</p>}
                      {isSplit(s) && (
                        <p className="cf-splitnote">
                          Cette phrase est sur plusieurs pages, on ne la coupe pas.{' '}
                          <button type="button" className="cf-link" onClick={() => goPage(s.pages![1])}>Voir la page {s.pages![1]}</button>
                        </p>
                      )}
                      {mod && (
                        <button type="button" className="cf-undo" onClick={() => edit(s, s.text)}>
                          Remettre la version lue<span className="sr-only"> pour la phrase {n + i + 1}</span>
                        </button>
                      )}
                    </li>,
                  ];
                })}
                {nextFirst && !startOf.has(nextFirst.id) && cutBar(nextFirst, true)}
                {nextFirst && startOf.has(nextFirst.id) && <li className="cf-cutrow cf-nextsec">La fiche {(secOf.get(nextFirst.id) ?? 0) + 1} commence page {pages[idx + 1].page}.</li>}
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

        <p className="cf-privacy">Ton cours complet est gardé dans ton espace jusqu'à ce que tu le supprimes ou que ton compte soit supprimé. La photo est effacée maintenant. Tes corrections ne sont gardées qu'une fois envoyées.</p>
        <div className="cf-actions">
          <ErrorBox message={error} />
          {blocker && <p className="cf-fielderr">{blocker}</p>}
          {!blocker && (
            <p className="cf-plan">
              {pl.kept} {plural(pl.kept, 'fiche', 'fiches')}{pl.subjects.length > 0 && pl.subjects.length <= 3 && ` (${pl.subjects.map(subjectLabel).join(', ')})`}
              {pl.ignored > 0 && `, ${pl.ignored} ${plural(pl.ignored, 'partie ignorée', 'parties ignorées')}`}
            </p>
          )}
          <button type="button" className="btn btn-big cf-send" onClick={send} disabled={busy || !!blocker} aria-busy={busy}>
            {busy ? <><span className="cf-spin" aria-hidden="true" /> Vérification en cours…</> : pl.kept > 1 ? `C'est bon, fais ${pl.kept} fiches` : "C'est bon, vérifie !"}
          </button>
        </div>
      </div>
    </Card>
  );
}
