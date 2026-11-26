import { memo, useEffect, useMemo, useRef, useState, type FocusEvent, type KeyboardEvent } from 'react';
import { ApiError, api } from '../../api';
import { FolderSelect, useFolders } from '../../components/FolderSelect';
import { Card, ErrorBox, Loading } from '../../components/ui';
import { errMsg, useLoad } from '../../hooks';
import { SUBJECTS, SUBJECT_IDS, plural, subjectLabel } from '../../labels';
import { go } from '../../router';
import { Rich } from '../../components/Math';
import { correctionProblem } from '../../correction';
import type { Block, ConfirmFigure, Job, Sentence, Subject } from '../../types';
import { AutoGrow } from './AutoGrow';
import { buildModel } from './blocks';
import { DocView } from './DocView';
import { FigureCard } from './FigureCard';
import { PhotoViewer } from './PhotoViewer';
import { MIN_WORDS, TITLE_MAX, TOPIC_MAX, addCut, confirmBody, effectiveSections, initSections, maxSections, plan, removeCut, sanitize, sectionIndex, type Sec } from './sections';
import { clearEdits, loadEdits, loadFigs, loadIds, loadSections, saveEdits, saveFigs, saveIds, saveSections, type FigChoice } from './storage';
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

/** Libelle d'une phrase sur plusieurs pages: « Suite page 3 » ou « Pages 2 à 4 ». */
const spanLabel = (s: Sentence) => {
  const p = s.pages;
  if (!p || p.length < 2) return null;
  return p.length === 2 ? `Suite page ${p[1]}` : `Pages ${p[0]} à ${p[p.length - 1]}`;
};
const isSplit = (s: Sentence) => (s.pages?.length ?? 0) > 1;


function ConfirmBody({ id, tr, onDone, reloadPhotos, reloading, reloadError }: { id: string; tr: Tr; onDone: (j: Job, fiches?: number) => void; reloadPhotos: () => void; reloading: boolean; reloadError: string | null }) {
  const pages = tr.pages;
  const model = useMemo(() => buildModel(pages, tr.blocks, tr.figures), [pages, tr.blocks, tr.figures]);
  const all = model.all;
  const original = useMemo(() => new Map(all.map((s) => [s.id, s.text])), [all]);
  const known = useMemo(() => new Set(all.map((s) => s.id)), [all]);
  const [edits, setEdits] = useState<Record<string, string>>(() => loadEdits(id, original));
  const [removed, setRemoved] = useState<Set<string>>(() => loadIds(id, 'removed', known));
  const [okDoubt, setOkDoubt] = useState<Set<string>>(() => loadIds(id, 'ok', known));
  const [figs, setFigs] = useState<Record<string, FigChoice>>(() => loadFigs(id, new Set(model.figures.keys())));
  const [active, setActive] = useState<string | null>(null);
  const proposed = useRef(false);
  const [secs, setSecs] = useState<Sec[]>(() => {
    const saved = sanitize(loadSections(id), all, pages.length);
    if (saved) return saved;
    const init = initSections(all, tr.suggestedSections, tr.suggestedSubject, tr.suggestedTopic, pages.length);
    proposed.current = init.length > 1;
    return init;
  });
  const [pageIdx, setPageIdx] = useState(0);
  const [focusId, setFocusId] = useState<string | null>(null);
  const [focusOrder, setFocusOrder] = useState<string[]>([]);
  const { folders, add: addFolder } = useFolders(); // un seul chargement pour toutes les fiches
  // Le dossier choisi en envoyant le scan: la liste des scans le donne (le serveur le garde, il ne peut pas etre retire ici).
  const [jobFolder, setJobFolder] = useState('');
  // shortcut: on ne cherche que parmi les 50 premiers scans a relire (le job n'expose pas son dossier); au-dela, rien n'est prérempli ni perdu (le serveur garde le dossier du scan), mais « Aucun dossier » s'affiche a tort. A lever quand `folderId` sera sur le job ou la transcription.
  useEffect(() => {
    let live = true;
    api.listScans({ status: 'a_confirmer', limit: 50 }).then((r) => {
      const f = r.items.find((i) => i.scanId === id)?.folderId;
      if (!live || !f) return;
      setJobFolder(f);
      setSecs((l) => l.map((x) => (x.folderId ? x : { ...x, folderId: f })));
    }, () => undefined);
    return () => { live = false; };
  }, [id]);
  // Sur petit écran la photo est repliée: on voit les phrases sans défiler.
  const [photoOpen, setPhotoOpen] = useState(() => typeof window.matchMedia !== 'function' || window.matchMedia('(min-width: 900px)').matches);
  const rootEl = useRef<HTMLDivElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [busyFigs, setBusyFigs] = useState(false); // la sauvegarde des images est momentanement impossible (503)
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
    saveIds(id, 'removed', removed);
    saveIds(id, 'ok', okDoubt);
    saveFigs(id, figs);
  }, [id, edits, secs, removed, okDoubt, figs]);

  // Apres une action dont le bouton disparait, on rend le focus a un endroit logique (le premier id present).
  useEffect(() => {
    if (!focusId && !focusOrder.length) return;
    for (const f of [focusId, ...focusOrder]) {
      const el = f ? document.getElementById(f) : null;
      if (el) { el.focus(); break; }
    }
    setFocusId(null);
    setFocusOrder([]);
  }, [focusId, focusOrder, secs, active]);

  const removedHas = (s: Sentence) => removed.has(s.id);
  const textOf = (s: Sentence) => edits[s.id] ?? s.text;
  const isChanged = (s: Sentence) => textOf(s) !== s.text && !removedHas(s);
  const isDoubt = (s: Sentence) => s.doubt === true && !removedHas(s) && !(s.id in edits) && !okDoubt.has(s.id);
  const changed = all.filter(isChanged).length;
  const doubts = all.filter(isDoubt).length;
  const kept = all.filter((s) => !removedHas(s));
  const secOf = useMemo(() => sectionIndex(secs, all), [secs, all]);
  const gIndex = useMemo(() => new Map(all.map((s, i) => [s.id, i])), [all]);
  const max = maxSections(pages.length);
  const pl = plan(secs, all, (s) => (removed.has(s.id) ? '' : textOf(s)));
  const startOf = new Set(secs.map((s) => s.from));

  const patch = (from: string, p: Partial<Sec>) => setSecs((l) => l.map((s) => (s.from === from ? { ...s, ...p } : s)));
  function setText(s: Sentence, text: string) {
    setEdits((e) => {
      const next = { ...e };
      if (text === s.text) delete next[s.id];
      else next[s.id] = text;
      return next;
    });
  }
  const toggle = (set: Set<string>, sid: string, on: boolean) => {
    const n = new Set(set);
    if (on) n.add(sid);
    else n.delete(sid);
    return n;
  };
  const remove = (s: Sentence) => { setRemoved((r) => toggle(r, s.id, true)); setActive(null); setFocusId(`cf-s-${s.id}`); };
  const restore = (s: Sentence) => { setRemoved((r) => toggle(r, s.id, false)); setActive(null); setFocusId(`cf-s-${s.id}`); };
  const showPage = (page: number) => {
    const i = pages.findIndex((p) => p.page === page);
    if (i >= 0) setPageIdx(i);
    document.getElementById(`cf-page-${page}`)?.scrollIntoView?.({ block: 'start' });
  };
  const showPageOf = (sentenceId: string) => {
    const p = model.pageOf.get(sentenceId);
    const i = pages.findIndex((x) => x.page === p);
    if (i >= 0) setPageIdx(i);
  };
  function cut(before: string) {
    setSecs((l) => addCut(l, all, before));
    setActive(null);
    showPageOf(before);
    setFocusId(`cf-sec-subject-${before}`);
  }
  function uncut(from: string) {
    setSecs((l) => removeCut(l, from));
    showPageOf(from);
    setFocusOrder([`cf-cut-${from}`, `cf-s-${from}`]);
  }

  const blocker =
    !kept.length ? (all.length ? 'Tu as retiré toutes les phrases. Remets-en au moins une.' : "Il n'y a aucun texte à vérifier. Refais la photo pour continuer.")
    : kept.some((s) => textOf(s).trim() === '') ? 'Il reste une phrase vide.'
    : pl.kept === 0 ? 'Garde au moins une fiche.'
    : pl.missingSubject ? 'Choisis la matière de chaque fiche.'
    : pl.words < MIN_WORDS ? `Il faut au moins ${MIN_WORDS} mots dans les parties gardées.`
    : null;

  async function send(noImages = false) {
    if (blocker) return setError(blocker);
    setBusy(true);
    setError(null);
    setBusyFigs(false);
    const corrections: Sentence[] = kept.filter(isChanged).map((s) => ({ id: s.id, text: textOf(s) }));
    const eff = effectiveSections(secs, all, removed);
    const figures: ConfirmFigure[] = [...model.figures.values()].map((f) => {
      const c = figs[f.figureId];
      const alt = c?.alt?.trim();
      if (noImages) return { figureId: f.figureId, keep: false };
      return { figureId: f.figureId, keep: c?.keep === true, ...(c?.keep && alt && alt !== f.alt ? { alt } : {}) };
    });
    try {
      const job = await api.confirm(id, corrections, {
        ...confirmBody(eff),
        ...(figures.length ? { figures } : {}),
        ...(removed.size ? { removed: all.filter((s) => removed.has(s.id)).map((s) => s.id) } : {}),
      });
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
      // 503 « indisponible » avec des images gardees: la copie des images a echoue, rien n'est perdu, l'etat du scan n'a pas change.
      if (e instanceof ApiError && (e.status === 503 || e.code === 'indisponible') && keptFigs > 0 && !noImages) {
        setBusyFigs(true);
        setError(null);
        setBusy(false);
        return;
      }
      setError(e instanceof ApiError && e.status === 404 ? `${errMsg(e)} Choisis un autre dossier.` : errMsg(e));
      setBusy(false);
    }
  }

  const gone = removed.size;
  const keptFigs = [...model.figures.keys()].filter((k) => figs[k]?.keep).length;
  const summary = `${all.length} ${plural(all.length, 'phrase', 'phrases')}, ${changed} ${plural(changed, 'corrigée', 'corrigées')}${gone ? `, ${gone} ${plural(gone, 'retirée', 'retirées')}` : ''}${secs.length > 1 ? `, ${pl.kept} ${plural(pl.kept, 'fiche', 'fiches')}` : ''}`;
  const idx = Math.min(pageIdx, pages.length - 1);
  const page = pages[idx];
  const photo = tr.photoUrls[idx];
  function tabKey(e: KeyboardEvent, i: number) {
    const to = e.key === 'ArrowRight' ? (i + 1) % pages.length : e.key === 'ArrowLeft' ? (i - 1 + pages.length) % pages.length : e.key === 'Home' ? 0 : e.key === 'End' ? pages.length - 1 : -1;
    if (to < 0) return;
    e.preventDefault();
    setPageIdx(to);
    document.getElementById(`cf-tab-${to}`)?.focus();
  }

  const atLimit = secs.length >= max;
  const limitText = `${max} fiches au maximum pour ${pages.length} ${plural(pages.length, 'page', 'pages')}`;
  const canCut = (s: Sentence) => !startOf.has(s.id) && (gIndex.get(s.id) ?? 0) > 0;

  const cutBar = (before: Sentence, boundary: boolean) => (
    <div className="cf-cutrow">
      <button type="button" id={`cf-cut-${before.id}`} className="cf-cut" disabled={atLimit} onClick={() => cut(before.id)} aria-label={`Couper ici${boundary ? ', entre deux pages' : ''}, avant la phrase ${(gIndex.get(before.id) ?? 0) + 1}`}>
        <span aria-hidden="true">✂</span> {boundary ? 'Couper ici, entre les pages' : 'Couper ici'}
      </button>
      {atLimit && <span className="cf-cutlimit">{limitText}</span>}
    </div>
  );

  const band = (s: Sec, i: number) => (
    <div className={`cf-band sec-${i % 6}`} role="group" aria-label={`Fiche ${i + 1}`}>
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
            <FolderSelect label="Dossier (facultatif)" allowNone={!jobFolder} value={s.folderId} onChange={(f) => patch(s.from, { folderId: f })} folders={folders} onCreated={addFolder} />
          </div>
        </details>
      </div>
      <label className="check cf-ignore">
        <input type="checkbox" checked={s.ignore} onChange={(e) => patch(s.from, { ignore: e.target.checked })} />
        Ne pas faire de fiche pour cette partie
      </label>
      {s.ignore && <p className="cf-ignnote">Ignorée = gardée dans ton cours complet, sans fiche.</p>}
    </div>
  );

  const renderSentence = (s: Sentence, { block }: { block: Block }) => {
    const n = (gIndex.get(s.id) ?? 0) + 1;
    const si = secOf.get(s.id) ?? 0;
    const isGone = removedHas(s);
    const mod = isChanged(s);
    const doubt = isDoubt(s);
    const formula = block.kind === 'formule';
    const span = spanLabel(s);
    if (active === s.id) {
      return (
        <SentenceEditor
          key={s.id}
          s={s}
          n={n}
          text={textOf(s)}
          formula={formula}
          removed={isGone}
          changed={mod}
          canCut={canCut(s) && !atLimit}
          onCommit={(t, refocus) => { if (t !== textOf(s)) setText(s, t); setActive(null); if (refocus) setFocusId(`cf-s-${s.id}`); }}
          onCancel={() => { setActive(null); setFocusId(`cf-s-${s.id}`); }}
          onRemove={() => remove(s)}
          onRestore={() => restore(s)}
          onReset={() => { setText(s, s.text); setActive(null); setFocusId(`cf-s-${s.id}`); }}
          onCut={() => cut(s.id)}
        />
      );
    }
    const cls = `cf-sent sec-${si % 6}${isGone ? ' is-gone' : mod ? ' is-mod' : doubt ? ' is-doubt' : ''}${secs[si]?.ignore ? ' ign' : ''}`;
    const state = isGone ? 'Retirée' : mod ? 'Corrigée' : doubt ? 'Lecture douteuse' : null;
    return (
      <span className="cf-sw">
        <button type="button" id={`cf-s-${s.id}`} className={cls} onClick={() => setActive(s.id)}>
          {state && <span className="cf-ico" aria-hidden="true">{isGone ? '✕' : mod ? '✎' : '?'}</span>}
          <Rich text={textOf(s)} formula={formula} />
          <span className="sr-only">{`. Phrase ${n}${state ? `, ${state.toLowerCase()}` : ''}${secs[si]?.ignore ? ', partie ignorée' : ''}.`}</span>
        </button>{' '}
        {span && <span className="cf-span">{span}</span>}{' '}
        {doubt && <button type="button" className="cf-ok" onClick={() => setOkDoubt((o) => toggle(o, s.id, true))}>C'est bon<span className="sr-only"> pour la phrase {n}</span></button>}{' '}
      </span>
    );
  };

  return (
    <Card title={tr.context?.length ? "Vérifie les nouvelles pages" : "Vérifie ce que j'ai lu"}>
      <div className="confirm" ref={rootEl}>
        <header className="cf-head">
          {tr.context?.length ? <p className="cf-append"><span aria-hidden="true">➕</span> Tu ajoutes ces pages à la <strong>fin</strong> de ton cours. Ce que tu as déjà ne change pas.</p> : null}
          <p className="cf-summary" role="status" aria-live="polite">{summary}</p>
          <p className="cf-words">{pl.words} {plural(pl.words, 'mot gardé', 'mots gardés')}</p>
          {doubts > 0 && <p className="cf-doubts"><span aria-hidden="true">?</span> {doubts} {plural(doubts, 'passage douteux', 'passages douteux')} à relire</p>}
          <ul className="cf-legend" aria-label="Couleurs de la relecture">
            <li className="lg-doubt"><span aria-hidden="true">?</span> Lecture douteuse</li>
            <li className="lg-mod"><span aria-hidden="true">✎</span> Corrigé</li>
            <li className="lg-gone"><span aria-hidden="true">✕</span> Retiré</li>
          </ul>
          <details className="cf-helpbox">
            <summary>Comment ça marche ?</summary>
            <p className="cf-help">J'ai lu ta page, mais je peux me tromper. Touche une phrase pour la corriger à sa place, ou pour la retirer. Les passages en jaune sont ceux dont je ne suis pas sûr. Si une phrase est juste, ne touche à rien.</p>
            <p className="cf-help">Ton cours parle de plusieurs sujets ? Touche « Couper ici » entre deux passages : tu auras une fiche par sujet, et ton cours complet reste gardé.</p>
          </details>
          {proposed.current && secs.length > 1 && <p className="notice">J'ai proposé {secs.length} fiches, change-les si besoin.</p>}
        </header>

        {pages.length > 1 && (
          <div className="cf-pages">
            <div role="tablist" aria-label="Pages du cours" className="cf-tablist">
              {pages.map((p, i) => (
                <button key={p.page} type="button" role="tab" id={`cf-tab-${i}`} aria-selected={i === idx} aria-controls="cf-panel" tabIndex={i === idx ? 0 : -1} className="cf-tab" onClick={() => showPage(p.page)} onKeyDown={(e) => tabKey(e, i)}>
                  Page {p.page}
                </button>
              ))}
            </div>
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
            {idx === 0 && tr.context && tr.context.length > 0 && (
              <section className="cf-context" aria-label="Fin de ton cours, déjà gardée">
                <p className="cf-context-title"><span aria-hidden="true">🔒</span> La fin de ton cours (déjà gardée, tu ne peux pas la changer)</p>
                {tr.context.map((s) => <p key={s.id} className="cf-context-s">{s.text}</p>)}
                {pages[0]?.sentences[0]?.continuesId && <p className="cf-context-link"><span aria-hidden="true">↳</span> La première phrase ci-dessous continue cette fin.</p>}
              </section>
            )}
            {all.length === 0 ? (
              <div className="cf-empty">
                <p>Je n'ai rien lu sur {pages.length > 1 ? 'tes photos' : 'ta photo'}. Essaie avec une photo plus nette, bien à plat et bien éclairée.</p>
                <button type="button" className="btn btn-ghost" onClick={() => go('/scan')}>Refaire la photo</button>
              </div>
            ) : (
              <DocView
                model={model}
                label="Ton cours"
                renderSentence={renderSentence}
                renderFigure={(f) => <FigureCard figure={f} choice={figs[f.figureId]} onChange={(c) => setFigs((l) => ({ ...l, [f.figureId]: c }))} onReload={reloadPhotos} />}
                beforeSentence={(s, { first, pageBreak }) => {
                  if (startOf.has(s.id)) return band(secs[secOf.get(s.id) ?? 0], secOf.get(s.id) ?? 0);
                  return first && canCut(s) ? cutBar(s, pageBreak) : null;
                }}
              />
            )}
          </div>
        </div>

        <p className="cf-privacy">Ton cours complet est gardé dans ton espace jusqu'à ce que tu le supprimes ou que ton compte soit supprimé. La photo est effacée maintenant. Tes corrections ne sont gardées qu'une fois envoyées.{model.figures.size > 0 ? ' Les images ne sont gardées que si tu le choisis.' : ''}</p>
        <div className="cf-actions">
          <ErrorBox message={error} />
          {busyFigs && (
            <div className="notice cf-retry" role="alert">
              <p>Je n'ai pas réussi à garder tes images pour le moment. Rien n'est perdu : ton texte et tes choix sont toujours là.</p>
              <div className="btn-row">
                <button type="button" className="btn btn-small" onClick={() => void send()}>Réessayer</button>
                <button type="button" className="btn btn-ghost btn-small" onClick={() => void send(true)}>Continuer sans garder les images</button>
              </div>
            </div>
          )}
          {blocker && <p className="cf-fielderr">{blocker}</p>}
          {!blocker && (
            <p className="cf-plan">
              {pl.kept} {plural(pl.kept, 'fiche', 'fiches')}{pl.subjects.length > 0 && pl.subjects.length <= 3 && ` (${pl.subjects.map(subjectLabel).join(', ')})`}
              {pl.ignored > 0 && `, ${pl.ignored} ${plural(pl.ignored, 'partie ignorée', 'parties ignorées')}`}
            </p>
          )}
          <button type="button" className="btn btn-big cf-send" onClick={() => void send()} disabled={busy || !!blocker} aria-busy={busy}>
            {busy ? <><span className="cf-spin" aria-hidden="true" /> Vérification en cours…</> : pl.kept > 1 ? `C'est bon, fais ${pl.kept} fiches` : "C'est bon, vérifie !"}
          </button>
        </div>
      </div>
    </Card>
  );
}

interface EditorProps {
  s: Sentence; n: number; text: string; formula: boolean; removed: boolean; changed: boolean; canCut: boolean;
  onCommit: (text: string, refocus: boolean) => void; onCancel: () => void; onRemove: () => void; onRestore: () => void; onReset: () => void; onCut: () => void;
}

/** Correction a la place de la phrase: champ de texte (fiable sur telephone), brouillon valide ou annule; rien n'est envoye au serveur ici. */
function SentenceEditor({ s, n, text, formula, removed, changed, canCut, onCommit, onCancel, onRemove, onRestore, onReset, onCut }: EditorProps) {
  const [draft, setDraft] = useState(text);
  const wrap = useRef<HTMLSpanElement>(null);
  const clean = draft.replace(/\s*\n\s*/g, ' ');
  const problem = clean.trim() === '' ? 'Une phrase ne peut pas être vide. Pour l’enlever, utilise « Retirer cette phrase ».' : correctionProblem(clean, formula);
  const hasMath = formula || /\$/.test(clean);
  useEffect(() => {
    const el = document.getElementById(`cf-in-${s.id}`) as HTMLTextAreaElement | null;
    el?.focus();
    if (el && 'setSelectionRange' in el) el.setSelectionRange(el.value.length, el.value.length);
  }, [s.id]);
  const done = (refocus: boolean) => { if (!problem) onCommit(clean, refocus); };
  function key(e: KeyboardEvent) {
    if (e.key === 'Escape') { e.preventDefault(); onCancel(); }
    else if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); done(true); }
  }
  function blur(e: FocusEvent) {
    if (wrap.current && e.relatedTarget instanceof Node && wrap.current.contains(e.relatedTarget)) return;
    if (clean.trim() === '') onCancel();
    else if (!problem) onCommit(clean, false);
  }
  if (removed) {
    return (
      <span className="cf-edit cf-edit-gone" ref={wrap}>
        <span className="cf-gone-text"><span aria-hidden="true">✕ </span><Rich text={text} formula={formula} /></span>
        <span className="cf-edit-actions">
          <button type="button" id={`cf-in-${s.id}`} className="btn btn-ghost btn-small" onClick={onRestore}>Remettre cette phrase<span className="sr-only"> ({n})</span></button>
          <button type="button" className="cf-link" onClick={onCancel}>Fermer</button>
        </span>
      </span>
    );
  }
  return (
    <span className="cf-edit" ref={wrap} onBlur={blur}>
      <label className="cf-editlabel" htmlFor={`cf-in-${s.id}`}>Phrase {n}{formula ? ' (formule en LaTeX)' : ''}</label>
      <AutoGrow id={`cf-in-${s.id}`} className="cf-text" value={draft} maxLength={2000} aria-invalid={problem ? true : undefined} aria-describedby={`cf-err-${s.id}${hasMath ? ` cf-prev-${s.id}` : ''}`} onChange={(e) => setDraft(e.target.value)} onKeyDown={key} />
      {hasMath && !problem && <span className="cf-preview" id={`cf-prev-${s.id}`}><span className="cf-preview-l">Aperçu</span> <Rich text={clean} formula={formula} /></span>}
      <span id={`cf-err-${s.id}`} className="cf-fielderr" role={problem ? 'alert' : undefined}>{problem ?? ''}</span>
      <span className="cf-edit-actions">
        <button type="button" className="btn btn-small" disabled={!!problem} onClick={() => done(true)}>Valider<span className="sr-only"> la phrase {n}</span></button>
        <button type="button" className="btn btn-ghost btn-small" onClick={onCancel}>Annuler</button>
        {changed && <button type="button" className="cf-undo" onClick={onReset}>Remettre la version lue<span className="sr-only"> pour la phrase {n}</span></button>}
        {canCut && <button type="button" className="cf-undo" onClick={onCut}><span aria-hidden="true">✂ </span>Couper avant cette phrase<span className="sr-only"> ({n})</span></button>}
        <button type="button" className="cf-undo cf-danger" onClick={onRemove}>Retirer cette phrase<span className="sr-only"> ({n})</span></button>
      </span>
    </span>
  );
}
