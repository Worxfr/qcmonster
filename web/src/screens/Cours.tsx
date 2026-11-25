import { useState } from 'react';
import { ApiError, api } from '../api';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import { fmtDay, plural, subjectClass, subjectLabel } from '../labels';
import { go } from '../router';

type Choice = 'garder' | 'supprimer' | null;

/** Cours complet (lecture seule): texte par pages, phrases numerotees, parties colorees par section. */
export function Cours({ id }: { id: string }) {
  const c = useLoad(() => api.cours(id), [id]);
  const [ask, setAsk] = useState(false);
  const [choice, setChoice] = useState<Choice>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (c.loading && !c.data) return <Loading />;
  if (!c.data) return <><ErrorBox message={c.error} /><button className="btn btn-ghost" onClick={() => go('/docs')}>Retour à mes cours</button></>;
  const cours = c.data;
  const all = cours.texts.flatMap((p) => p.sentences);
  const pos = new Map(all.map((s, i) => [s.id, i]));
  const starts = cours.sections.map((s) => pos.get(s.fromSentenceId) ?? 0);
  const secOf = (i: number) => starts.reduce((acc, st, k) => (i >= st ? k : acc), 0);
  let num = 0;

  async function remove() {
    if (!choice) return;
    setBusy(true);
    setError(null);
    try {
      await api.deleteCours(id, choice);
      go('/docs');
    } catch (e) {
      setError(e instanceof ApiError && e.status === 403 ? "Seul l'élève peut supprimer un cours." : errMsg(e));
      setBusy(false);
    }
  }

  return (
    <>
      <Card title="Cours complet">
        <p className="muted">Du {fmtDay(cours.createdAt)} · {cours.pages} {plural(cours.pages, 'page', 'pages')} · {all.length} {plural(all.length, 'phrase', 'phrases')}</p>
        <p><a className="link" href="#/docs">‹ Mes cours</a></p>
        <ol className="cours-secs" aria-label="Parties du cours">
          {cours.sections.map((s, i) => (
            <li key={s.fromSentenceId} className={`cours-sec sec-${i % 6}`}>
              <span className="cf-secnum">{i + 1}</span>
              <span className="grow">
                <strong>{subjectLabel(s.subject)}{s.topic ? ` · ${s.topic}` : ''}</strong>
                {s.title && <><br /><span className="muted">{s.title}</span></>}
              </span>
              {s.status === 'fiche' && s.docId && <a className="btn btn-small" href={`#/doc/${encodeURIComponent(s.docId)}`}>Lire la fiche<span className="sr-only"> {i + 1}</span></a>}
              {s.status === 'supprimee' && <span className="pill pill-warn">Fiche supprimée</span>}
              {s.status === 'sans_fiche' && <span className="pill pill-warn">Pas de fiche</span>}
              {s.status === 'ignoree' && <span className="subj subj-none">Ignorée</span>}
            </li>
          ))}
        </ol>
      </Card>

      {cours.texts.map((p) => (
        <Card key={p.page} title={`Page ${p.page}`}>
          {p.sentences.length === 0 && <p className="muted">Cette page prolonge la phrase de la page précédente.</p>}
          <ol className="cours-text">
            {p.sentences.map((s) => {
              num += 1;
              const k = secOf(pos.get(s.id) ?? 0);
              const sec = cours.sections[k];
              return (
                <li key={s.id} className={`cours-sent sec-${k % 6}${sec?.status === 'ignoree' ? ' ign' : ''}`} value={num}>
                  <span className="cf-num" aria-hidden="true">{num}</span>
                  <span className="grow">
                    {cours.sections.length > 1 && <span className="cf-secpill">Partie {k + 1}{sec?.status === 'ignoree' ? ' · ignorée' : ''}</span>}{' '}
                    {s.text}
                  </span>
                </li>
              );
            })}
          </ol>
        </Card>
      ))}

      <Card title="Supprimer ce cours">
        {!ask ? (
          <>
            <p className="muted">Ton cours complet est gardé dans ton espace jusqu'à ce que tu le supprimes. Supprimer une fiche seule ne supprime pas le cours.</p>
            <button className="btn btn-ghost" onClick={() => setAsk(true)}>Supprimer ce cours</button>
          </>
        ) : (
          <fieldset className="del-choices">
            <legend><strong>Que fait-on des fiches de ce cours ?</strong></legend>
            {([['garder', 'Supprimer le cours et garder mes fiches'], ['supprimer', 'Supprimer le cours ET ses fiches']] as const).map(([v, l]) => (
              <label key={v} className={`choice${choice === v ? ' on' : ''}${v === 'supprimer' ? ' danger' : ''}`}>
                <input type="radio" name="del" checked={choice === v} onChange={() => setChoice(v)} />
                {l}
              </label>
            ))}
            <ErrorBox message={error} />
            <div className="btn-row">
              <button className="btn btn-danger" disabled={!choice || busy} onClick={remove}>Supprimer</button>
              <button className="btn btn-ghost" onClick={() => { setAsk(false); setChoice(null); }}>Annuler</button>
            </div>
          </fieldset>
        )}
      </Card>
    </>
  );
}
