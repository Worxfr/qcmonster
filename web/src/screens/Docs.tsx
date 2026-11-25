import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { FolderSelect } from '../components/FolderSelect';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg } from '../hooks';
import { fmtDay, plural, stageLabel, subjectClass, subjectLabel, timeLeft } from '../labels';
import { go, useRoute } from '../router';
import type { Folder, ScanList, ScanQuery, ScanSummary } from '../types';

const SORTS = [
  { id: 'date-desc', label: 'Plus récents', q: { sort: 'date', order: 'desc' } },
  { id: 'date-asc', label: 'Plus anciens', q: { sort: 'date', order: 'asc' } },
  { id: 'subject', label: 'Par matière', q: { sort: 'subject' } },
  { id: 'topic', label: 'Par sujet', q: { sort: 'topic' } },
] as const;
const STATUSES = [['', 'Tout'], ['en_cours', 'En cours'], ['termine', 'Terminés'], ['echec', 'Pas réussis']] as const;
const PAGE = 50;

interface Params { subject: string; topic: string; folderId: string; status: string; sort: string }
const EMPTY: Params = { subject: '', topic: '', folderId: '', status: '', sort: 'date-desc' };
const KEYS = Object.keys(EMPTY) as (keyof Params)[];

const rowKey = (s: ScanSummary) => `${s.scanId}/${s.docId ?? ''}`;
const isFinal = (s: ScanSummary) => s.status.stage === 'termine' || s.status.stage === 'echec';

function toQuery(p: Params, studentId?: string): ScanQuery {
  const sort = SORTS.find((s) => s.id === p.sort) ?? SORTS[0];
  return {
    ...(studentId ? { studentId } : {}),
    ...(p.subject ? { subject: p.subject as ScanQuery['subject'] } : {}),
    ...(p.topic ? { topic: p.topic } : {}),
    ...(p.folderId ? { folderId: p.folderId } : {}),
    ...(p.status ? { status: p.status as ScanQuery['status'] } : {}),
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
  const [running, setRunning] = useState<ScanSummary[]>([]);
  const [delay, setDelay] = useState(3000);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const key = JSON.stringify([params, studentId]);

  const load = useCallback(async (first: boolean) => {
    try {
      const r = await api.listScans(toQuery(params, studentId));
      const run = r.inProgress > 0 ? await api.listScans({ ...(studentId ? { studentId } : {}), status: 'en_cours', limit: 20 }) : null;
      setList(r);
      if (first) { setMore([]); setCursor(r.nextCursor); }
      setRunning(run ? [...run.items].sort((a, b) => Number(b.status.stage === 'a_confirmer') - Number(a.status.stage === 'a_confirmer') || (a.status.expiresAt ?? 'z').localeCompare(b.status.expiresAt ?? 'z')) : []);
      setError(null);
      setDelay(3000);
    } catch (e) {
      if (e instanceof ApiError && e.status === 429) setDelay((d) => Math.min(12000, d * 2)); // limite de debit: on ralentit sans message
      else setError(errMsg(e));
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

  // Interrogation reguliere tant que des scans sont en cours et que l'onglet est visible.
  const inProgress = list?.inProgress ?? 0;
  useEffect(() => {
    if (inProgress <= 0) return;
    let stopped = false;
    let t: ReturnType<typeof setTimeout>;
    const loop = () => {
      if (stopped) return;
      t = setTimeout(async () => {
        if (stopped) return;
        if (!document.hidden) await load(false);
        if (stopped) return; // l'ecran a ete quitte pendant le chargement: pas de nouveau minuteur
        loop();
      }, delay);
    };
    loop();
    const vis = () => { if (!stopped && !document.hidden) void load(false); };
    document.addEventListener('visibilitychange', vis);
    return () => { stopped = true; clearTimeout(t); document.removeEventListener('visibilitychange', vis); };
  }, [inProgress > 0, delay, load]);

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

  const filtered = !!(params.subject || params.topic || params.folderId || params.status);
  const hideRunning = !params.status && running.length > 0;
  const seen = new Set((list?.items ?? []).map(rowKey));
  const items = [...(list?.items ?? []), ...more.filter((s) => !seen.has(rowKey(s)))].filter((s) => !(hideRunning && !isFinal(s)));
  const folderName = (id?: string) => folders.find((f) => f.folderId === id)?.name;
  const toggle = (docId: string) => setPicked((p) => { const n = new Set(p); if (n.has(docId)) n.delete(docId); else n.add(docId); return n; });
  const byDoc = new Map(items.filter((s) => s.docId).map((s) => [s.docId!, s]));
  const chosen = [...picked].map((d) => byDoc.get(d)).filter((s): s is ScanSummary => !!s);

  return (
    <>
      <Card title={readOnly ? `Les cours de ${pseudo ?? 'l\'élève'}` : 'Mes cours'}>
        {readOnly && <p className="muted">Tu vois les cours en lecture seule: ni le texte, ni les photos.</p>}
        {!readOnly && params.folderId && (
          <p><a className="link" href="#/folders">‹ Mes dossiers</a> · <strong>{folderName(params.folderId) ?? 'Dossier'}</strong></p>
        )}
        <Toolbar params={params} setParams={setParams} list={list} folders={folders} filtered={filtered} />
        {!readOnly && items.some((s) => s.docId) && (
          <div className="btn-row" style={{ marginTop: '.6rem' }}>
            <button type="button" className={`btn btn-small${selecting ? '' : ' btn-ghost'}`} aria-pressed={selecting} onClick={() => { setSelecting(!selecting); setPicked(new Set()); }}>
              {selecting ? 'Terminer' : 'Choisir'}
            </button>
            <a className="btn btn-small btn-ghost" href="#/folders">📁 Mes dossiers</a>
          </div>
        )}
      </Card>

      {running.length > 0 && !params.status && (
        <section className="card running" aria-label="En cours">
          <h2>⏳ En cours</h2>
          <ul className="list">
            {running.map((s) => <RunningRow key={s.scanId} s={s} readOnly={readOnly} />)}
          </ul>
        </section>
      )}

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
        <SelectionBar chosen={chosen} folders={folders} onCreated={(f) => setFolders((l) => [...l, f])} onDone={() => { setPicked(new Set()); setSelecting(false); void load(true); api.folders(studentId).then((r) => setFolders(r.items), () => undefined); }} setError={setError} />
      )}
    </>
  );
}

function Toolbar({ params, setParams, list, folders, filtered }: { params: Params; setParams: (p: Partial<Params>) => void; list: ScanList | null; folders: Folder[]; filtered: boolean }) {
  const [open, setOpen] = useState(filtered);
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
          <label>Statut
            <select value={params.status} onChange={(e) => setParams({ status: e.target.value })}>
              {STATUSES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
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

function RunningRow({ s, readOnly }: { s: ScanSummary; readOnly: boolean }) {
  const review = s.status.stage === 'a_confirmer';
  const left = timeLeft(s.status.expiresAt);
  return (
    <li className={`run-row${review && s.status.expiresSoon ? ' soon' : ''}`}>
      <span className="grow">
        <strong>{s.title ?? s.topic ?? 'Cours en lecture'}</strong><br />
        <span className="muted">{review ? `À relire${left ? ` · ${left}` : ''}` : stageLabel(s.status.stage)} · {s.status.pagesDone} sur {s.status.pagesTotal} pages</span>
      </span>
      {review && !readOnly && <button type="button" className="btn btn-small" onClick={() => go(`/job/${encodeURIComponent(s.scanId)}`)}>Vérifier<span className="sr-only"> le scan</span></button>}
    </li>
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
  const stage = s.status.stage;
  const failed = stage === 'echec';
  const running = !failed && stage !== 'termine';
  const canPick = !!s.docId && !readOnly;
  const target = s.docId && !readOnly ? `/doc/${encodeURIComponent(s.docId)}` : !readOnly ? `/job/${encodeURIComponent(s.scanId)}` : null;
  const title = s.title ?? (running ? 'Cours en lecture…' : 'Cours sans titre');
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
          {failed ? <span className="pill pill-warn">Pas réussi</span> : s.subject ? <span className={subjectClass(s.subject)}>{subjectLabel(s.subject)}</span> : <span className="subj subj-none">En cours</span>}
          {s.topic && <span className="scan-topic">{s.topic}</span>}
        </span>
        <span className="muted scan-sub">
          {s.pages} {plural(s.pages, 'page', 'pages')} · {fmtDay(s.createdAt)}
          {folder && <> · <span aria-label="dossier">📁 {folder}</span></>}
          {grouped && s.sectionIndex !== undefined && <> · fiche {s.sectionIndex + 1} sur {s.sectionCount}</>}
        </span>
        {failed && s.status.message && <span className="scan-fail">{s.status.message}</span>}
      </span>
      {!selecting && target && <span aria-hidden="true" className="chev">›</span>}
    </>
  );
  return (
    <li className={`scan-card${picked ? ' picked' : ''}${failed ? ' failed' : ''}${grouped ? ' in-group' : ''}`}>
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

function SelectionBar({ chosen, folders, onCreated, onDone, setError }: { chosen: ScanSummary[]; folders: Folder[]; onCreated: (f: Folder) => void; onDone: () => void; setError: (e: string | null) => void }) {
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
      <p className="selcount" role="status">{n} {plural(n, 'choisi', 'choisis')}</p>
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
