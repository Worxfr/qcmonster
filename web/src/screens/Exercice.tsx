import { useCallback, useEffect, useRef, useState, type ChangeEvent } from 'react';
import { api, uploadScan } from '../api';
import { Rich } from '../components/Math';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { checkPhoto, exoError, EXO_WAIT_MS, MAX_PAGES_COPIE, pointsLeft, triesText } from '../exo';
import { go } from '../router';
import type { Exercice as Exo } from '../types';
import { usePoll } from '../usePoll';
import './exo.css';

interface Photo { key: number; file: File; url: string }
let seq = 0;

/** Un exercice: enonce, indices, solution, et envoi de la copie en photo (1 a 3 pages). */
export function Exercice({ id }: { id: string }) {
  const [exo, setExo] = useState<Exo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const x = await api.exercice(id);
      setExo(x);
      setError(null);
      return x;
    } catch (e) {
      setError(exoError(e));
      return null;
    }
  }, [id]);
  useEffect(() => { setExo(null); void load(); }, [load]);

  const generating = exo?.etat === 'generation';
  const { timedOut } = usePoll(async () => (await load())?.etat !== 'generation', generating, id, EXO_WAIT_MS);

  if (!exo) return error ? <><ErrorBox message={error} /><button className="btn" onClick={() => void load()}>Réessayer</button></> : <Loading />;
  if (generating) {
    return (
      <Card title="Ton exercice arrive">
        {timedOut
          ? <p role="alert" className="error">Ça prend plus de temps que prévu. Reviens dans un moment.</p>
          : <p role="status" className="exo-wait">⏳ Je prépare ton exercice, ça prend quelques secondes…</p>}
        <a className="btn btn-ghost" href={`#/exercices/${encodeURIComponent(exo.docId)}`}>Retour à la liste</a>
      </Card>
    );
  }
  if (exo.etat === 'echec') {
    return (
      <Card title="Oups">
        <p>Cet exercice n'a pas pu être préparé. Retourne à la liste et demande-en un autre.</p>
        <a className="btn" href={`#/exercices/${encodeURIComponent(exo.docId)}`}>Retour à la liste</a>
      </Card>
    );
  }
  return <Body exo={exo} setExo={setExo} />;
}

function Body({ exo, setExo }: { exo: Exo; setExo: (e: Exo) => void }) {
  const id = exo.exoId;
  const [hintErr, setHintErr] = useState<string | null>(null);
  const [hintBusy, setHintBusy] = useState(false);
  const [askSolution, setAskSolution] = useState(false);
  const [solution, setSolution] = useState<string | null>(null);
  const [solErr, setSolErr] = useState<string | null>(null);
  const [solBusy, setSolBusy] = useState(false);
  const now = pointsLeft(exo.indicesVus);
  const next = pointsLeft(exo.indicesVus + 1);

  async function hint() {
    setHintBusy(true);
    setHintErr(null);
    try {
      const h = await api.exerciceHint(id);
      setExo({ ...exo, indicesDonnes: [...exo.indicesDonnes.slice(0, h.rang - 1), h.texte], indicesVus: h.rang });
    } catch (e) {
      setHintErr(exoError(e, 'indice'));
    } finally {
      setHintBusy(false);
    }
  }

  async function showSolution() {
    setSolBusy(true);
    setSolErr(null);
    try {
      const s = await api.exerciceSolution(id);
      setSolution(s.solution);
      setAskSolution(false);
      setExo({ ...exo, solutionVue: true });
    } catch (e) {
      setSolErr(exoError(e, 'solution'));
      setAskSolution(false);
    } finally {
      setSolBusy(false);
    }
  }

  return (
    <>
      <p><a className="link" href={`#/exercices/${encodeURIComponent(exo.docId)}`}>‹ Mes exercices</a></p>
      <Card>
        <h1 className="exo-title">{exo.titre ?? 'Exercice'}</h1>
        <p>
          <span className="chip">⭐ {exo.solutionVue ? 'Plus de points (solution vue)' : `Jusqu'à ${now} points`}</span>
          <span className="chip chip-soft">📝 {triesText(exo.copiesRestantes)}</span>
        </p>
        <div className="exo-enonce" aria-label="Énoncé"><Rich text={exo.enonce ?? ''} /></div>
      </Card>

      <Card title="Un coup de pouce ?">
        {exo.indicesDonnes.length > 0 && (
          <ol className="exo-hints" aria-label="Tes indices">
            {exo.indicesDonnes.map((t, i) => <li key={i}><span className="exo-hint-n" aria-hidden="true">{i + 1}</span><span><Rich text={t} /></span></li>)}
          </ol>
        )}
        {exo.indicesVus < exo.indicesTotal && !exo.solutionVue ? (
          <>
            <button className="btn btn-alt" onClick={hint} disabled={hintBusy}>💡 Un indice</button>
            <p className="notice" role="note">⚠️ Chaque indice retire des points : avec le prochain, tu pourras gagner {next} points au plus (au lieu de {now}).</p>
          </>
        ) : exo.indicesVus >= exo.indicesTotal ? <p className="muted">Tu as vu les {exo.indicesTotal} indices.</p> : null}
        <ErrorBox message={hintErr} />
      </Card>

      <Rendre exo={exo} onSent={(copieId) => go(`/copie/${encodeURIComponent(copieId)}`)} />

      <Card title="La solution">
        {solution !== null ? (
          <div className="exo-solution" aria-label="Solution"><Rich text={solution} /></div>
        ) : askSolution ? (
          <div className="exo-warn" role="alertdialog" aria-label="Voir la solution ?">
            <p><strong>Attention :</strong> si tu regardes la solution, cet exercice ne te rapportera plus de points. Tu pourras quand même t'entraîner et te faire corriger.</p>
            <button className="btn" onClick={showSolution} disabled={solBusy}>Oui, voir la solution</button>
            <button className="btn btn-ghost" onClick={() => setAskSolution(false)}>Non, je continue</button>
          </div>
        ) : (
          <>
            <p className="muted">{exo.solutionVue ? 'Tu as déjà vu la solution.' : 'Elle est disponible après une première correction, ou après 3 indices et 10 minutes. La voir ferme les points de l\'exercice.'}</p>
            <button className="btn btn-ghost" onClick={() => (exo.solutionVue ? void showSolution() : setAskSolution(true))} disabled={solBusy}>{exo.solutionVue ? 'Revoir la solution' : 'Voir la solution'}</button>
          </>
        )}
        <ErrorBox message={solErr} />
      </Card>
    </>
  );
}

/** Prise de photos, envoi des pages (formulaire S3 pre-signe, comme un scan), puis lancement de la correction. */
function Rendre({ exo, onSent }: { exo: Exo; onSent: (copieId: string) => void }) {
  const [photos, setPhotos] = useState<Photo[]>([]);
  const [msgs, setMsgs] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState<number | null>(null);
  const [retry, setRetry] = useState(false);
  const draft = useRef<{ copieId: string; pages: number } | null>(null); // pages deja envoyees: un nouvel essai ne refait que `submit`
  const urls = useRef<string[]>([]);
  useEffect(() => () => urls.current.forEach((u) => URL.revokeObjectURL(u)), []);
  const busy = sent !== null;

  function pick(e: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(e.target.files ?? []);
    e.target.value = '';
    const out: string[] = [];
    const ok: Photo[] = [];
    for (const f of files) {
      const problem = checkPhoto(f, [...photos, ...ok].map((p) => p.file));
      if (problem) { if (!out.includes(problem)) out.push(problem); continue; }
      const url = URL.createObjectURL(f);
      urls.current.push(url);
      ok.push({ key: ++seq, file: f, url });
    }
    setMsgs(out);
    setError(null);
    if (ok.length) { setPhotos((p) => [...p, ...ok]); draft.current = null; setRetry(false); }
  }
  const remove = (i: number) => { setPhotos((p) => p.filter((_, j) => j !== i)); draft.current = null; setRetry(false); };

  async function send() {
    setError(null);
    setRetry(false);
    setSent(0);
    try {
      if (!draft.current) {
        const c = await api.createCopie(exo.exoId, photos.length, photos[0].file.type);
        if (c.envois.length < photos.length) throw new Error('Le serveur n\'a pas préparé assez d\'envois.');
        for (let i = 0; i < photos.length; i++) {
          const envoi = c.envois.find((x) => x.page === i + 1) ?? c.envois[i];
          try { await uploadScan(envoi, photos[i].file); } catch { await uploadScan(envoi, photos[i].file); } // un deuxieme essai par page
          setSent(i + 1);
        }
        draft.current = { copieId: c.copieId, pages: photos.length };
      }
      await api.submitCopie(draft.current.copieId);
      onSent(draft.current.copieId);
    } catch (e) {
      setError(exoError(e, draft.current ? 'copie' : 'envoi'));
      setRetry(true);
      setSent(null);
    }
  }

  if (exo.copiesRestantes <= 0) {
    return <Card title="Rendre ma copie"><p>{triesText(0)} Regarde la solution pour comprendre, ou reviens demain pour un autre exercice.</p></Card>;
  }
  return (
    <Card title="Rendre ma copie">
      <p className="lead">Fais l'exercice sur ta feuille, puis prends-la en photo (1 à {MAX_PAGES_COPIE} pages), bien à plat et avec de la lumière.</p>
      {exo.solutionVue && <p className="notice">Tu as vu la solution : cette copie sera corrigée, mais elle ne rapportera plus de points.</p>}
      {photos.length < MAX_PAGES_COPIE && !busy && (
        <div className="exo-photo-btns">
          <label className="btn btn-big file-btn exo-camera">
            {photos.length ? '📷 Photo de la page suivante' : '📷 Prendre ma copie en photo'}
            <input type="file" accept="image/jpeg,image/png" capture="environment" onChange={pick} aria-label="Prendre une photo avec l'appareil" />
          </label>
          <label className="btn btn-ghost file-btn exo-gallery">
            🖼️ Choisir dans mes photos
            <input type="file" accept="image/jpeg,image/png" multiple onChange={pick} aria-label="Choisir des photos dans la galerie" />
          </label>
        </div>
      )}
      {msgs.map((m) => <p key={m} role="alert" className="error">{m}</p>)}
      {photos.length > 0 && (
        <>
          <ol className="thumbs exo-thumbs" aria-label="Pages de ta copie, dans l'ordre">
            {photos.map((p, i) => (
              <li key={p.key} className="thumb">
                <span className="thumb-num" aria-hidden="true">{i + 1}</span>
                <img src={p.url} alt={`Page ${i + 1} de ta copie`} />
                <button type="button" className="btn btn-small btn-ghost" disabled={busy} onClick={() => remove(i)}>Retirer<span className="sr-only"> la page {i + 1}</span></button>
              </li>
            ))}
          </ol>
          {busy && (
            <div role="status">
              <p><strong>{sent} sur {photos.length}</strong> pages envoyées…</p>
              <Bar pct={Math.round(((sent ?? 0) / photos.length) * 100)} label="Envoi des pages" />
            </div>
          )}
          <button type="button" className="btn btn-big" onClick={send} disabled={busy} aria-busy={busy}>
            {busy ? 'Envoi en cours…' : draft.current && retry ? 'Rendre ma copie' : `Rendre ma copie (${photos.length} ${photos.length > 1 ? 'pages' : 'page'})`}
          </button>
        </>
      )}
      <ErrorBox message={error} />
      {retry && !busy && photos.length > 0 && <p className="muted">{draft.current ? 'Tes photos sont bien envoyées. Appuie sur « Rendre ma copie » pour réessayer.' : 'Appuie à nouveau sur « Rendre ma copie » pour réessayer.'}</p>}
    </Card>
  );
}
