import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { FolderSelect } from '../components/FolderSelect';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg } from '../hooks';
import { fmtDay, plural, stageLabel, subjectClass, subjectLabel } from '../labels';
import { go, useRoute } from '../router';
import { folderError } from './Folders';
import type { Folder, ScanList, ScanQuery, ScanSummary } from '../types';

const SORTS = [
  { id: 'date-desc', label: 'Plus récents', q: { sort: 'date', order: 'desc' } },
  { id: 'date-asc', label: 'Plus anciens', q: { sort: 'date', order: 'asc' } },
  { id: 'subject', label: 'Par matière', q: { sort: 'subject' } },
  { id: 'topic', label: 'Par sujet', q: { sort: 'topic' } },
] as const;
const PAGE = 50;

interface Params { subject: string; topic: string; folderId: string; sort: string }
const EMPTY: Params = { subject: '', topic: '', folderId: '', sort: 'date-desc' };
const KEYS = Object.keys(EMPTY) as (keyof Params)[];

const rowKey = (s: ScanSummary) => `${s.scanId}/${s.docId ?? ''}`;

function toQuery(p: Params, studentId?: string): ScanQuery {
  const sort = SORTS.find((s) => s.id === p.sort) ?? SORTS[0];
  return {
    ...(studentId ? { studentId } : {}),
    ...(p.subject ? { subject: p.subject as ScanQuery['subject'] } : {}),
    ...(p.topic ? { topic: p.topic } : {}),
    ...(p.folderId ? { folderId: p.folderId } : {}),
    status: 'termine', // Mes cours = scans menes au bout; ceux en cours, a relire ou rates sont dans Scanner
    ...sort.q,
    limit: PAGE,
  };
}

/** Filtres et tri dans l'URL (retour arriere garde l'etat); en lecture parent (pas d'URL propre) ils restent locaux. */
function useParams(local: boolean): [Params, (p: Partial<Params>) => void] {
  const route = useRoute();
  const [mine, setMine] = useState<Params>(EMPTY);
  const fromUrl = useMemo(() => {
    const qs = new URLSearchParams(route.split('?')[1] ?? '');
    const p = { ...EMPTY };
    for (const k of KEYS) p[k] = qs.get(k) ?? p[k];
    return p;
  }, [route]);
  const params = local ? mine : fromUrl;
  const set = (patch: Partial<Params>) => {
    const next = { ...params, ...patch };
    if (local) return setMine(next);
    const qs = new URLSearchParams();
    for (const k of KEYS) if (next[k] && next[k] !== EMPTY[k]) qs.set(k, next[k]);
    go(`/docs${qs.size ? `?${qs}` : ''}`);
  };
  return [params, set];
}

export function Docs({ studentId, pseudo }: { studentId?: string; pseudo?: string }) {
  const readOnly = !!studentId;
  const [params, setParams] = useParams(readOnly);
  const [list, setList] = useState<ScanList | null>(null);
  const [more, setMore] = useState<ScanSummary[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [folders, setFolders] = useState<Folder[]>([]);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [gone, setGone] = useState(false);
  const key = JSON.stringify([params, studentId]);
  useEffect(() => { if (params.folderId) setGone(false); }, [params.folderId]);

  const load = useCallback(async (first: boolean) => {
    try {
      const r = await api.listScans(toQuery(params, studentId));
      setList(r);
      if (first) { setMore([]); setCursor(r.nextCursor); }
      setError(null);
    } catch (e) {
      if (e instanceof ApiError && e.status === 404 && params.folderId && params.folderId !== 'none') {
        // Lien ou retour arriere vers un dossier supprime: on montre tous les cours, sans erreur.
        setGone(true);
        setParams({ folderId: '' });
        return;
      }
      setError(errMsg(e));
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key]);

  // Changer un filtre repart de la premiere page (un curseur ne vaut que pour les memes filtres).
  useEffect(() => {
    setLoading(true);
    void load(true);
  }, [load]);
  useEffect(() => {
    api.folders(studentId).then((r) => setFolders(r.items), () => undefined);
  }, [studentId]);

  const reloadFolders = () => api.folders(studentId).then((r) => setFolders(r.items), () => undefined);

  async function loadMore() {
    if (!cursor) return;
    try {
      const r = await api.listScans({ ...toQuery(params, studentId), cursor });
      setMore((m) => [...m, ...r.items]);
      setCursor(r.nextCursor);
    } catch (e) {
      setError(errMsg(e));
    }
  }

  const filtered = !!(params.subject || params.topic || params.folderId);
  const seen = new Set((list?.items ?? []).map(rowKey));
  const items = [...(list?.items ?? []), ...more.filter((s) => !seen.has(rowKey(s)))];
  const folderName = (id?: string) => folders.find((f) => f.folderId === id)?.name;
  const toggle = (docId: string) => setPicked((p) => { const n = new Set(p); if (n.has(docId)) n.delete(docId); else n.add(docId); return n; });
  const byDoc = new Map(items.filter((s) => s.docId).map((s) => [s.docId!, s]));
  const chosen = [...picked].map((d) => byDoc.get(d)).filter((s): s is ScanSummary => !!s);

  return (
    <>
      <Card title={readOnly ? `Les cours de ${pseudo ?? 'l\'élève'}` : 'Mes cours'}>
        {readOnly && <p className="muted">Tu vois les cours en lecture seule: ni le texte, ni les photos.</p>}
        {gone && !params.folderId && <p className="notice" role="status">Ce dossier n'existe plus. Voici tous tes cours.</p>}
        {!readOnly && params.folderId && params.folderId !== 'none' && folders.some((f) => f.folderId === params.folderId) && (
          <FolderHead folder={folders.find((f) => f.folderId === params.folderId)!} onChanged={() => void reloadFolders()} onDeleted={() => { setParams({ folderId: '' }); void reloadFolders(); }} />
        )}
        <Toolbar params={params} setParams={setParams} list={list} folders={folders} filtered={filtered} />
        {!readOnly && items.some((s) => s.docId) && (
          <div className="btn-row" style={{ marginTop: '.6rem' }}>
            <button type="button" className={`btn btn-small${selecting ? '' : ' btn-ghost'}`} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>
              {selecting ? 'Terminer' : 'Choisir des cours'}
            </button>
            <a className="btn btn-small btn-ghost" href="#/folders">📁 Mes dossiers</a>
          </div>
        )}
      </Card>

      {readOnly && <ChildRunning studentId={studentId!} />}

      <ErrorBox message={error} />
      {loading && !list && <Loading />}
      {list && (
        <section aria-label="Liste des cours" className="docs-list">
          {items.length === 0 ? (
            <Empty filtered={filtered} folder={!!params.folderId} readOnly={readOnly} clear={() => setParams({ ...EMPTY })} />
          ) : (
            <Groups items={items} sort={params.sort} selecting={selecting} picked={picked} toggle={toggle} startSelect={(id) => { setSelecting(true); setPicked(new Set([id])); }} readOnly={readOnly} folderName={folderName} />
          )}
          {cursor && <button type="button" className="btn btn-ghost btn-big" onClick={loadMore}>Voir plus</button>}
        </section>
      )}

      {selecting && !readOnly && (
        <SelectionBar chosen={chosen} all={byDoc.size} pickAll={() => setPicked(new Set(byDoc.keys()))} folders={folders} onCreated={(f) => setFolders((l) => [...l, f])} onDone={() => { setPicked(new Set()); setSelecting(false); void load(true); void reloadFolders(); }} setError={setError} />
      )}
    </>
  );
}

/** Dossier ouvert: le renommer ou le supprimer sans quitter la liste. Supprimer garde les cours (ils sortent du dossier). */
function FolderHead({ folder, onChanged, onDeleted }: { folder: Folder; onChanged: () => void; onDeleted: () => void }) {
  const [mode, setMode] = useState<'rename' | 'delete' | null>(null);
  const [draft, setDraft] = useState(folder.name);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const renameBtn = useRef<HTMLButtonElement>(null);
  const confirmEl = useRef<HTMLDivElement>(null);
  const [back, setBack] = useState(false); // le bouton « Renommer » revient apres Enregistrer/Annuler: on lui rend le focus
  useEffect(() => {
    if (back && mode === null) { renameBtn.current?.focus(); setBack(false); }
  }, [back, mode]);
  useEffect(() => {
    if (mode === 'delete') confirmEl.current?.focus();
  }, [mode]);
  const close = () => { setMode(null); setBack(true); };
  async function run(fn: () => Promise<unknown>, after: () => void) {
    setBusy(true);
    setErr(null);
    try {
      await fn();
      close();
      after();
    } catch (e) {
      setErr(folderError(e));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="folder-head">
      <p className="folder-head-title"><a className="link" href="#/folders">‹ Mes dossiers</a></p>
      {mode === 'rename' ? (
        <form className="btn-row" onSubmit={(e) => { e.preventDefault(); void run(() => api.renameFolder(folder.folderId, draft.trim()), onChanged); }}>
          <input aria-label="Nouveau nom du dossier" autoFocus value={draft} maxLength={60} onChange={(e) => setDraft(e.target.value)} style={{ flex: 1, minWidth: 0 }} />
          <button className="btn btn-small" disabled={!draft.trim() || busy}>Enregistrer</button>
          <button type="button" className="btn btn-small btn-ghost" onClick={close}>Annuler</button>
        </form>
      ) : (
        <div className="folder-head-row">
          <h2 className="folder-head-name"><span aria-hidden="true">📁</span> {folder.name}</h2>
          <div className="btn-row">
            <button ref={renameBtn} type="button" className="btn btn-small btn-ghost" onClick={() => { setDraft(folder.name); setMode('rename'); }}>Renommer le dossier</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setMode('delete')}>Supprimer le dossier</button>
          </div>
        </div>
      )}
      {mode === 'delete' && (
        <div className="selpanel" ref={confirmEl} tabIndex={-1} role="group" aria-label="Confirmer la suppression du dossier">
          <p><strong>Supprimer « {folder.name} » ?</strong> Les cours restent, ils sortent du dossier.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={() => void run(() => api.deleteFolder(folder.folderId), onDeleted)}>Oui, supprimer le dossier</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={close}>Annuler</button>
          </div>
        </div>
      )}
      {err && <p role="alert" className="error">{err}</p>}
    </div>
  );
}

function Toolbar({ params, setParams, list, folders, filtered }: { params: Params; setParams: (p: Partial<Params>) => void; list: ScanList | null; folders: Folder[]; filtered: boolean }) {
  const [open, setOpen] = useState(!!(params.subject || params.topic)); // le dossier ouvert a son propre en-tête
  return (
    <div className="toolbar">
      <div className="toolbar-top">
        <label className="sort">Trier
          <select value={params.sort} onChange={(e) => setParams({ sort: e.target.value })}>
            {SORTS.map((s) => <option key={s.id} value={s.id}>{s.label}</option>)}
          </select>
        </label>
        <button type="button" className={`btn btn-small${filtered ? '' : ' btn-ghost'}`} aria-expanded={open} aria-controls="filters" onClick={() => setOpen(!open)}>
          Filtres{filtered ? ' •' : ''}
        </button>
      </div>
      {open && (
        <div id="filters" className="filters">
          <label>Matière
            <select value={params.subject} onChange={(e) => setParams({ subject: e.target.value })}>
              <option value="">Toutes</option>
              {list?.facets.subjects.map((f) => <option key={f.subject} value={f.subject}>{subjectLabel(f.subject)} ({f.count})</option>)}
            </select>
          </label>
          <label>Sujet
            <select value={params.topic} onChange={(e) => setParams({ topic: e.target.value })}>
              <option value="">Tous</option>
              {list?.facets.topics.map((f) => <option key={f.topic} value={f.topic}>{f.topic} ({f.count})</option>)}
            </select>
          </label>
          <label>Dossier
            <select value={params.folderId} onChange={(e) => setParams({ folderId: e.target.value })}>
              <option value="">Tous</option>
              <option value="none">Sans dossier</option>
              {folders.map((f) => <option key={f.folderId} value={f.folderId}>{f.name} ({f.scanCount})</option>)}
            </select>
          </label>
          {filtered && <button type="button" className="btn btn-small btn-ghost" onClick={() => setParams({ ...EMPTY, sort: params.sort })}>Effacer les filtres</button>}
        </div>
      )}
    </div>
  );
}

function Empty({ filtered, folder, readOnly, clear }: { filtered: boolean; folder: boolean; readOnly: boolean; clear: () => void }) {
  if (folder && !filtered) return <Card><p className="empty">📂 Ce dossier est vide.</p></Card>;
  if (filtered) {
    return (
      <Card>
        <p className="empty">🔍 Aucun cours ne correspond.</p>
        <button type="button" className="btn" onClick={clear}>Effacer les filtres</button>
      </Card>
    );
  }
  return (
    <Card>
      <p className="empty">📚 {readOnly ? 'Aucun cours pour le moment.' : 'Scanne ton premier cours !'}</p>
      {!readOnly && <button type="button" className="btn btn-big" onClick={() => go('/scan')}>📷 Scanner un cours</button>}
    </Card>
  );
}

/** Vue parent: l'etape et le nombre de pages des scans pas encore termines de l'eleve (jamais le texte). Lecture seule, actualisee toutes les 5 s tant qu'il y en a. */
function ChildRunning({ studentId }: { studentId: string }) {
  const [items, setItems] = useState<ScanSummary[]>([]);
  useEffect(() => {
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const tick = async () => {
      let again = false;
      try {
        const [run, failed] = await Promise.all([api.listScans({ studentId, status: 'en_cours', limit: 20 }), api.listScans({ studentId, status: 'echec', limit: 20 })]);
        if (stopped) return;
        setItems([...run.items, ...failed.items]);
        again = run.items.length > 0;
      } catch {
        again = false;
      }
      if (!stopped && again) t = setTimeout(tick, 5000);
    };
    void tick();
    return () => { stopped = true; clearTimeout(t); };
  }, [studentId]);
  if (!items.length) return null;
  return (
    <section className="card running" aria-label="Scans en cours de l'élève">
      <h2>⏳ Scans en cours</h2>
      <ul className="list">
        {items.map((s) => (
          <li key={s.scanId} className="run-row">
            <span className="grow">
              <strong>{s.title ?? s.topic ?? (s.subject ? subjectLabel(s.subject) : `Scan du ${fmtDay(s.createdAt)}`)}</strong><br />
              <span className="muted">{stageLabel(s.status.stage)} · {s.status.pagesDone} sur {s.status.pagesTotal} {plural(s.status.pagesTotal, 'page', 'pages')}</span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

type Row = { kind: 'head'; text: string; level: 2 | 3; key: string } | { kind: 'group'; scanId: string; coursId?: string; date: string; count: number; key: string } | { kind: 'card'; s: ScanSummary; key: string };

function rows(items: ScanSummary[], sort: string): Row[] {
  const out: Row[] = [];
  let subj: string | undefined;
  let top: string | undefined;
  let scan: string | undefined;
  for (const s of items) {
    if (sort === 'subject' && (out.length === 0 || s.subject !== subj)) {
      subj = s.subject;
      top = undefined;
      out.push({ kind: 'head', level: 2, text: s.subject ? subjectLabel(s.subject) : 'Sans matière', key: `h-${out.length}` });
    }
    if ((sort === 'subject' || sort === 'topic') && (top === undefined || (s.topic ?? '') !== top)) {
      top = s.topic ?? '';
      out.push({ kind: 'head', level: sort === 'subject' ? 3 : 2, text: s.topic || 'Sans sujet', key: `t-${out.length}` });
    }
    if ((s.sectionCount ?? 1) > 1 && s.scanId !== scan) {
      out.push({ kind: 'group', scanId: s.scanId, coursId: s.coursId, date: s.createdAt, count: s.sectionCount!, key: `g-${s.scanId}-${out.length}` });
    }
    scan = (s.sectionCount ?? 1) > 1 ? s.scanId : undefined;
    out.push({ kind: 'card', s, key: `${s.scanId}-${s.docId ?? 'x'}-${out.length}` });
  }
  return out;
}

function Groups({ items, sort, selecting, picked, toggle, startSelect, readOnly, folderName }: { items: ScanSummary[]; sort: string; selecting: boolean; picked: Set<string>; toggle: (d: string) => void; startSelect: (d: string) => void; readOnly: boolean; folderName: (id?: string) => string | undefined }) {
  return (
    <ul className="list scan-list">
      {rows(items, sort).map((r) => {
        if (r.kind === 'head') return <li key={r.key} className={`grp-head l${r.level}`} role="presentation"><h3>{r.text}</h3></li>;
        if (r.kind === 'group') {
          const inner = <><span aria-hidden="true">🗂️</span> Cours du {fmtDay(r.date)}, {r.count} fiches</>;
          return (
            <li key={r.key} className="scan-group" role="presentation">
              {r.coursId && !readOnly ? <a href={`#/cours/${encodeURIComponent(r.coursId)}`}>{inner} <span aria-hidden="true">›</span></a> : <span>{inner}</span>}
            </li>
          );
        }
        return <ScanCard key={r.key} s={r.s} selecting={selecting} picked={!!r.s.docId && picked.has(r.s.docId)} toggle={toggle} startSelect={startSelect} readOnly={readOnly} folder={folderName(r.s.folderId)} grouped={(r.s.sectionCount ?? 1) > 1} />;
      })}
    </ul>
  );
}

function ScanCard({ s, selecting, picked, toggle, startSelect, readOnly, folder, grouped }: { s: ScanSummary; selecting: boolean; picked: boolean; toggle: (d: string) => void; startSelect: (d: string) => void; readOnly: boolean; folder?: string; grouped: boolean }) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const longPressed = useRef(false);
  const canPick = !!s.docId && !readOnly;
  const target = s.docId && !readOnly ? `/doc/${encodeURIComponent(s.docId)}` : !readOnly ? `/job/${encodeURIComponent(s.scanId)}` : null;
  const title = s.title ?? 'Cours sans titre';
  const open = () => {
    if (longPressed.current) { longPressed.current = false; return; } // le relachement d'un appui long n'ouvre pas la fiche
    if (selecting && canPick) return toggle(s.docId!);
    if (target) go(target);
  };
  const body = (
    <>
      <span className="grow">
        <strong className="scan-title">{title}</strong>
        <span className="scan-meta">
          {s.subject ? <span className={subjectClass(s.subject)}>{subjectLabel(s.subject)}</span> : <span className="subj subj-none">Sans matière</span>}
          {s.topic && <span className="scan-topic">{s.topic}</span>}
        </span>
        <span className="muted scan-sub">
          {s.pages} {plural(s.pages, 'page', 'pages')} · {fmtDay(s.createdAt)}
          {folder && <> · <span aria-label="dossier">📁 {folder}</span></>}
          {grouped && s.sectionIndex !== undefined && <> · fiche {s.sectionIndex + 1} sur {s.sectionCount}</>}
        </span>
      </span>
      {!selecting && target && <span aria-hidden="true" className="chev">›</span>}
    </>
  );
  return (
    <li className={`scan-card${picked ? ' picked' : ''}${grouped ? ' in-group' : ''}`}>
      {selecting && !readOnly && (
        <label className="pick-hit">
          <input type="checkbox" className="pick" checked={picked} disabled={!canPick} onChange={() => canPick && toggle(s.docId!)} aria-label={`Choisir ${title}`} />
        </label>
      )}
      {target || selecting ? (
        <button
          type="button"
          className="scan-open"
          onClick={open}
          onPointerDown={() => { longPressed.current = false; if (canPick && !selecting) timer.current = setTimeout(() => { longPressed.current = true; startSelect(s.docId!); }, 600); }}
          onContextMenu={(e) => { if (canPick) e.preventDefault(); }}
          onPointerUp={() => clearTimeout(timer.current)}
          onPointerLeave={() => clearTimeout(timer.current)}
        >
          {body}
        </button>
      ) : <div className="scan-open static">{body}</div>}
    </li>
  );
}

function SelectionBar({ chosen, all, pickAll, folders, onCreated, onDone, setError }: { chosen: ScanSummary[]; all: number; pickAll: () => void; folders: Folder[]; onCreated: (f: Folder) => void; onDone: () => void; setError: (e: string | null) => void }) {
  const [panel, setPanel] = useState<'move' | 'delete' | null>(null);
  const [folderId, setFolderId] = useState('');
  const [busy, setBusy] = useState(false);
  const inFolders = chosen.filter((s) => s.folderId);
  const moved = chosen.filter((s) => s.folderId && s.folderId !== folderId).length;
  const n = chosen.length;

  async function run(fn: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await fn();
      onDone();
    } catch (e) {
      setError(e instanceof ApiError && e.code === 'dossiers_limite' ? 'Tu as déjà 50 dossiers.' : errMsg(e));
    } finally {
      setBusy(false);
    }
  }
  const move = () => run(async () => {
    const ids = chosen.map((s) => s.docId!);
    for (let i = 0; i < ids.length; i += 50) await api.addToFolder(folderId, ids.slice(i, i + 50));
  });
  const out = () => run(async () => { for (const s of inFolders) await api.removeFromFolder(s.folderId!, s.docId!); });
  const del = () => run(async () => { for (const s of chosen) await api.deleteDoc(s.docId!); });

  return (
    <div className="selbar" role="region" aria-label="Actions sur les cours choisis">
      <p className="selcount"><span role="status">{n} {plural(n, 'choisi', 'choisis')}</span>{n < all && <> · <button type="button" className="link" onClick={pickAll}>Tout choisir ({all})</button></>}</p>
      {panel === 'move' && (
        <div className="selpanel">
          <FolderSelect value={folderId} onChange={setFolderId} label="Dossier" none="Choisis un dossier" folders={folders} onCreated={onCreated} />
          {moved > 0 && <p className="notice">{moved} {plural(moved, 'cours sera déplacé', 'cours seront déplacés')} depuis un autre dossier.</p>}
          <div className="btn-row">
            <button type="button" className="btn btn-small" disabled={!folderId || busy} onClick={move}>Ranger ici</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setPanel(null)}>Annuler</button>
          </div>
        </div>
      )}
      {panel === 'delete' && (
        <div className="selpanel">
          <p><strong>Supprimer {n} {plural(n, 'fiche', 'fiches')} ?</strong> Le cours complet reste gardé.</p>
          <div className="btn-row">
            <button type="button" className="btn btn-small btn-danger" disabled={busy} onClick={del}>Oui, supprimer</button>
            <button type="button" className="btn btn-small btn-ghost" onClick={() => setPanel(null)}>Annuler</button>
          </div>
        </div>
      )}
      {!panel && (
        <div className="btn-row">
          <button type="button" className="btn btn-small" disabled={!n} onClick={() => setPanel('move')}>📁 Ranger dans un dossier</button>
          <button type="button" className="btn btn-small btn-ghost" disabled={!inFolders.length || busy} onClick={out}>Sortir du dossier</button>
          <button type="button" className="btn btn-small btn-ghost" disabled={!n} onClick={() => setPanel('delete')}>🗑 Supprimer</button>
        </div>
      )}
    </div>
  );
}
