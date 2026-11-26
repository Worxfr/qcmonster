// M1 #90 partie 2: modifier un cours deja confirme (corriger, retirer, ajouter des phrases). Memes regles et memes fonctions que la relecture:
// `placeAdded` (-> `applyChanges` partage avec le serveur) montre la place exacte des ajouts. Rien n'est ecrit tant que l'eleve n'a pas valide;
// la modification est un travail du serveur sur une copie (rien ne change en cas d'echec ou d'annulation).
import { useMemo, useRef, useState } from 'react';
import { ApiError, api } from '../api';
import { Rich } from '../components/Math';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import { countWords, plural } from '../labels';
import { go } from '../router';
import type { Cours, Revision, Sentence } from '../types';
import { usePoll } from '../usePoll';
import { Added, MAX_ADDED, nextKey, placeAdded, removeAdded, toRequest } from './confirm/added';
import { buildModel } from './confirm/blocks';
import { AddEditor, SentenceEditor } from './confirm/ConfirmView';
import { DocView } from './confirm/DocView';
import { FigureView } from './confirm/FigureCard';
import { MIN_WORDS } from './confirm/sections';
import './confirm/confirm.css';

/** Limite de changements d'une modification (contrat: `ReviseRequest`, 20 au plus au total). */
export const MAX_CHANGES = 20;
/** Attente maximale du suivi (la machine a un filet de 30 minutes cote serveur). */
const WAIT_MS = 35 * 60_000;

const STEP: Record<string, string> = {
  preparation: 'Je prépare tes changements…',
  verification: 'Je compare ta nouvelle version à des sources…',
  generation: 'Je refais la fiche et les questions touchées…',
  validation: 'Je range tout dans ton cours…',
};

/** Message clair pour un refus de la route. 404 = interrupteur fermé (route pas encore ouverte sur cet environnement). */
export function reviseError(e: unknown): string {
  if (e instanceof ApiError) {
    if (e.status === 404) return "La modification des cours n'est pas encore ouverte. Ton cours n'a pas changé, reviens un peu plus tard.";
    if (e.status === 403) return "Seul l'élève peut modifier un cours.";
    if (e.status === 429) return e.code === 'budget_epuise' ? 'Le budget de modifications est atteint pour le moment. Ton cours n’a pas changé.' : "Tu as déjà fait assez de modifications pour aujourd'hui. Reviens demain, ton cours n'a pas changé.";
  }
  return errMsg(e);
}

export function Modifier({ id }: { id: string }) {
  const c = useLoad(() => api.cours(id), [id]);
  if (c.loading && !c.data) return <Loading />;
  if (!c.data) return <><ErrorBox message={c.error} /><button className="btn btn-ghost" onClick={() => go('/docs')}>Retour à mes cours</button></>;
  return <ModifierBody cours={c.data} />;
}

function ModifierBody({ cours }: { cours: Cours }) {
  const id = cours.coursId;
  // Une modification deja ouverte (autre onglet ou autre appareil): on la suit au lieu d'en proposer une autre.
  const [rev, setRev] = useState<Revision | null>(cours.revision ? { revisionId: cours.revision.revisionId, coursId: id, etat: 'en_cours', fiches: [], createdAt: '' } : null);
  const [request, setRequest] = useState<ReturnType<typeof buildRequest> | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  if (rev) {
    return (
      <Suivi
        coursId={id}
        rev={rev}
        onRev={setRev}
        onRetry={request ? () => { setNotice(null); return start(request); } : undefined}
        onBack={(msg) => { setRev(null); setNotice(msg); }}
      />
    );
  }
  async function start(body: ReturnType<typeof buildRequest>): Promise<string | null> {
    setRequest(body);
    try {
      setRev(await api.createRevision(id, body));
      return null;
    } catch (e) {
      return reviseError(e);
    }
  }
  return <Edition cours={cours} notice={notice} onSend={start} />;
}

function buildRequest(corrections: { id: string; text: string }[], removed: string[], added: Added[]) {
  return { ...(corrections.length ? { corrections } : {}), ...(removed.length ? { removed } : {}), ...(added.length ? { added: toRequest(added) } : {}) };
}

function Edition({ cours, notice, onSend }: { cours: Cours; notice: string | null; onSend: (b: ReturnType<typeof buildRequest>) => Promise<string | null> }) {
  const read = useMemo(() => cours.texts.flatMap((p) => p.sentences), [cours.texts]);
  const known = useMemo(() => new Set(read.map((s) => s.id)), [read]);
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [removed, setRemoved] = useState<Set<string>>(new Set());
  const [added, setAdded] = useState<Added[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [adding, setAdding] = useState<{ afterId: string | null } | null>(null);
  const [hint, setHint] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const placed = useMemo(() => placeAdded(cours.texts, cours.blocks, added), [cours.texts, cours.blocks, added]);
  const model = useMemo(() => buildModel(placed.pages, placed.blocks, cours.figures), [placed, cours.figures]);
  const addedKeys = useMemo(() => new Set(added.map((a) => a.key)), [added]);
  const textOf = (s: Sentence) => edits[s.id] ?? s.text;
  const isGone = (s: Sentence) => removed.has(s.id);
  const isMod = (s: Sentence) => !addedKeys.has(s.id) && s.id in edits && edits[s.id] !== s.text && !isGone(s);

  // Verifications locales (le serveur refait les memes: 400 `requete_invalide`, rien n'est modifie).
  const corrections = read.filter((s) => isMod(s)).map((s) => ({ id: s.id, text: edits[s.id].trim() }));
  const gone = read.filter(isGone).map((s) => s.id);
  const total = corrections.length + gone.length + added.length;
  const starts = new Set(cours.sections.map((s) => s.fromSentenceId));
  const words = model.all.filter((s) => !isGone(s)).reduce((n, s) => n + countWords(textOf(s)), 0);
  const order = model.all.map((s) => s.id);
  const secOf = (sid: string) => {
    let k = 0;
    cours.sections.forEach((s, i) => { if (order.indexOf(s.fromSentenceId) <= order.indexOf(sid)) k = i; });
    return k;
  };
  const emptySection = cours.sections.some((_, k) => {
    const mine = read.filter((s) => secOf(s.id) === k);
    return mine.length > 0 && mine.every(isGone) && !added.some((a) => a.afterId && secOf(a.afterId) === k);
  });
  const blocker = total === 0 ? 'Change au moins une phrase pour continuer.'
    : total > MAX_CHANGES ? `Tu peux faire ${MAX_CHANGES} changements au plus à la fois (tu en as ${total}).`
    : words < MIN_WORDS ? `Il faut garder au moins ${MIN_WORDS} mots dans le cours.`
    : emptySection ? 'Une partie du cours ne peut pas rester sans phrase.'
    : null;

  const focusLater = (sid: string) => setTimeout(() => document.getElementById(`cf-s-${sid}`)?.focus(), 0);
  function setText(s: Sentence, text: string) {
    if (addedKeys.has(s.id)) return setAdded((l) => l.map((a) => (a.key === s.id ? { ...a, text } : a)));
    setEdits((e) => {
      const n = { ...e };
      if (text === s.text) delete n[s.id];
      else n[s.id] = text;
      return n;
    });
  }
  function remove(s: Sentence) {
    setActive(null);
    setHint(null);
    if (addedKeys.has(s.id)) return setAdded((l) => removeAdded(l, s.id));
    if (starts.has(s.id)) {
      setHint("On ne peut pas retirer la première phrase d'une partie du cours. Corrige-la plutôt, ou supprime la fiche.");
      return;
    }
    setRemoved((r) => new Set(r).add(s.id));
    focusLater(s.id);
  }
  function addSentence(afterId: string | null, text: string, newBlock: boolean) {
    const key = nextKey(added);
    setAdded((l) => [...l, { key, afterId, text: text.trim(), newBlock: afterId === null ? true : newBlock }]);
    setAdding(null);
    focusLater(key);
  }
  async function send() {
    if (blocker || busy) return;
    setBusy(true);
    setError(null);
    const err = await onSend(buildRequest(corrections, gone, added));
    if (err) { setError(err); setBusy(false); }
  }

  let n = 0;
  const num = new Map(model.all.map((s) => [s.id, ++n]));
  const state = (s: Sentence) => (isGone(s) ? 'Retirée' : isMod(s) ? 'Corrigée' : addedKeys.has(s.id) ? 'Ajoutée par toi' : null);

  return (
    <>
      <Card title="Modifier ton cours">
        <p><a className="link" href={`#/cours/${encodeURIComponent(cours.coursId)}`}>‹ Retour au cours</a></p>
        {notice && <p className="notice" role="status">{notice}</p>}
        <div className="mod-intro">
          <p><strong>Touche une phrase</strong> pour la corriger ou la retirer. Tu peux aussi ajouter une phrase oubliée.</p>
          <p className="muted">Je compare ce qui change à des sources et je refais seulement les fiches touchées. Tes points gagnés restent. Si ça ne marche pas, ton cours reste comme avant.</p>
        </div>
        <ul className="cf-legend" aria-label="Couleurs de la modification">
          <li className="lg-mod"><span aria-hidden="true">✎</span> Corrigé</li>
          <li className="lg-gone"><span aria-hidden="true">✕</span> Retiré</li>
          <li className="lg-add"><span aria-hidden="true">+</span> Ajouté par toi</li>
        </ul>
        <p className="cf-summary" role="status" aria-live="polite">
          {total === 0 ? 'Aucun changement pour le moment' : `${total} ${plural(total, 'changement', 'changements')} sur ${MAX_CHANGES} au plus`} · {words} {plural(words, 'mot gardé', 'mots gardés')}
        </p>
        {hint && <p className="notice" role="alert">{hint}</p>}
        <div className="confirm">
          {model.all.length > 0 && (
            adding && adding.afterId === null
              ? <AddEditor list={added} newBlockChoice={false} onSave={(t) => addSentence(null, t, true)} onCancel={() => setAdding(null)} />
              : <button type="button" id="cf-add-start" className="cf-addstart" disabled={added.length >= MAX_ADDED} onClick={() => { setActive(null); setAdding({ afterId: null }); }}><span aria-hidden="true">+</span> Ajouter une phrase au début du texte</button>
          )}
          <DocView
            model={model}
            label="Texte de ton cours à modifier"
            renderFigure={(f) => <FigureView figure={f} />}
            beforeSentence={(x) => {
              const k = secOf(x.id);
              if (cours.sections.length < 2 || !starts.has(x.id)) return null;
              return <p className={`cours-part sec-${k % 6}`}><span className="cf-secnum">Partie {k + 1}</span></p>;
            }}
            renderSentence={(s, { block }) => {
              const nn = num.get(s.id) ?? 0;
              const formula = block.kind === 'formule';
              if (active === s.id) {
                return (
                  <SentenceEditor
                    key={s.id}
                    s={{ ...s, added: addedKeys.has(s.id) || undefined } as Sentence}
                    n={nn}
                    text={textOf(s)}
                    formula={formula}
                    removed={isGone(s)}
                    changed={isMod(s)}
                    canCut={false}
                    addNote={added.length >= MAX_ADDED ? `Tu as déjà ajouté ${MAX_ADDED} phrases.` : null}
                    onAdd={() => { setActive(null); setAdding({ afterId: s.id }); }}
                    onCommit={(t, refocus) => { if (t !== textOf(s)) setText(s, t); setActive(null); if (refocus) focusLater(s.id); }}
                    onCancel={() => { setActive(null); focusLater(s.id); }}
                    onRemove={() => remove(s)}
                    onRestore={() => { setRemoved((r) => { const x = new Set(r); x.delete(s.id); return x; }); setActive(null); focusLater(s.id); }}
                    onReset={() => { setText(s, s.text); setActive(null); focusLater(s.id); }}
                    onCut={() => undefined}
                  />
                );
              }
              const st = state(s);
              const cls = `cf-sent sec-${secOf(s.id) % 6}${isGone(s) ? ' is-gone' : isMod(s) ? ' is-mod' : addedKeys.has(s.id) ? ' is-added' : ''}`;
              return (
                <span className="cf-sw">
                  <button type="button" id={`cf-s-${s.id}`} className={cls} onClick={() => { setHint(null); setActive(s.id); }}>
                    {st && <span className="cf-ico" aria-hidden="true">{isGone(s) ? '✕' : isMod(s) ? '✎' : '+'}</span>}
                    <Rich text={textOf(s)} formula={formula} />
                    <span className="sr-only">{`. Phrase ${nn}${st ? `, ${st.toLowerCase()}` : ''}.`}</span>
                  </button>{' '}
                  {addedKeys.has(s.id) && <span className="cf-tagadd">Ajoutée par toi</span>}{' '}
                  {adding?.afterId === s.id && <AddEditor list={added} newBlockChoice onSave={(t, nb) => addSentence(s.id, t, nb)} onCancel={() => { setAdding(null); focusLater(s.id); }} />}
                </span>
              );
            }}
          />
          {known.size === 0 && <p className="muted">Ce cours est vide.</p>}
        </div>
        <div className="mod-send">
          {blocker && total > 0 && <p className="cf-fielderr" role="status">{blocker}</p>}
          <ErrorBox message={error} />
          <button type="button" className="btn btn-big" disabled={!!blocker || busy} aria-busy={busy} onClick={() => void send()}>
            {busy ? 'Envoi…' : 'Enregistrer la modification'}
          </button>
          {total === 0 && <span className="muted"> {blocker}</span>}
        </div>
      </Card>
    </>
  );
}

/** Suivi d'une modification: en cours (avec annulation), terminee, echec (avec « Réessayer »). */
function Suivi({ coursId, rev, onRev, onRetry, onBack }: { coursId: string; rev: Revision; onRev: (r: Revision) => void; onRetry?: () => Promise<string | null>; onBack: (msg: string | null) => void }) {
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const stopped = useRef(false);
  usePoll(async () => {
    const r = await api.revision(coursId, rev.revisionId);
    if (stopped.current) return true;
    onRev(r);
    return r.etat !== 'en_cours';
  }, rev.etat === 'en_cours', rev.revisionId, WAIT_MS);

  async function cancel() {
    setBusy(true);
    setError(null);
    try {
      await api.cancelRevision(coursId, rev.revisionId);
      stopped.current = true;
      onBack("Modification annulée. Ton cours n'a pas changé.");
    } catch (e) {
      setError(e instanceof ApiError && e.status === 409 ? "Trop tard pour annuler : je range déjà tes changements dans le cours. Encore quelques secondes." : e instanceof ApiError && e.status === 404 ? 'Cette modification est déjà finie.' : errMsg(e));
      setBusy(false);
    }
  }
  async function retry() {
    if (!onRetry) return;
    setBusy(true);
    setError(null);
    const err = await onRetry();
    if (err) { setError(err); setBusy(false); } else setBusy(false);
  }

  if (rev.etat === 'terminee') {
    const low = rev.fiches.filter((f) => f.numerosRestants !== undefined && f.numerosRestants < 20);
    return (
      <Card title="Modification terminée">
        <p className="cf-append" role="status"><span aria-hidden="true">✅</span> {(rev.message ?? 'Ton cours est à jour').replace(/[.\s]*$/, '.')} Tes points gagnés sont gardés.</p>
        {low.length > 0 && <p className="notice">Une fiche a déjà été beaucoup retouchée : il te reste {Math.min(...low.map((f) => f.numerosRestants as number))} {plural(Math.min(...low.map((f) => f.numerosRestants as number)), 'retouche', 'retouches')} possibles sur elle.</p>}
        <a className="btn btn-big" href={`#/cours/${encodeURIComponent(coursId)}`}>Voir mon cours</a>
      </Card>
    );
  }
  if (rev.etat === 'echec') {
    return (
      <Card title="La modification n'a pas marché">
        <p role="alert" className="error">{(rev.message ?? "Je n'ai pas pu finir la modification").replace(/[.\s]*$/, '.')} Ton cours n'a pas changé.</p>
        <ErrorBox message={error} />
        <div className="btn-row">
          {onRetry && <button type="button" className="btn" disabled={busy} onClick={() => void retry()}>Réessayer</button>}
          <button type="button" className="btn btn-ghost" onClick={() => onBack(null)}>Revenir à mes changements</button>
          <a className="btn btn-ghost" href={`#/cours/${encodeURIComponent(coursId)}`}>Voir mon cours</a>
        </div>
      </Card>
    );
  }
  return (
    <Card title="Modification en cours">
      <p className="mod-progress" role="status" aria-live="polite"><span className="cf-spin" aria-hidden="true" /> {rev.etape ? STEP[rev.etape] : 'Je prépare tes changements…'}</p>
      <p className="muted">Ça peut prendre quelques minutes. Ton cours reste comme avant tant que ce n'est pas fini. Tu peux quitter cet écran, la modification continue.</p>
      <ErrorBox message={error} />
      <div className="btn-row">
        <button type="button" className="btn btn-ghost" disabled={busy} onClick={() => void cancel()}>Annuler la modification</button>
        <a className="btn btn-ghost" href={`#/cours/${encodeURIComponent(coursId)}`}>Retour au cours</a>
      </div>
    </Card>
  );
}
