import { useState } from 'react';
import { ApiError, api } from '../api';
import { Rich } from '../components/Math';
import { Card, ErrorBox, Loading } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import { fmtDay, plural, subjectLabel } from '../labels';
import { go } from '../router';
import { buildModel } from './confirm/blocks';
import { DocView } from './confirm/DocView';
import { FigureView } from './confirm/FigureCard';
import './confirm/confirm.css';

type Choice = 'garder' | 'supprimer' | null;

/** Resultat de verification d'une phrase (apres la confirmation). Jamais la couleur seule: icone et mot. */
const MARK = {
  verifiee: { text: 'Vérifié', icon: '✓' },
  erreur: { text: 'Erreur trouvée', icon: '✗' },
  non_verifiable: { text: 'Non vérifiable', icon: '?' },
} as const;

/** Cours complet (lecture seule): texte mis en forme, figures gardees, resultat de la verification phrase par phrase. */
export function Cours({ id }: { id: string }) {
  const c = useLoad(() => api.cours(id), [id]);
  const [ask, setAsk] = useState(false);
  const [choice, setChoice] = useState<Choice>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [showMarks, setShowMarks] = useState(true);

  if (c.loading && !c.data) return <Loading />;
  if (!c.data) return <><ErrorBox message={c.error} /><button className="btn btn-ghost" onClick={() => go('/docs')}>Retour à mes cours</button></>;
  const cours = c.data;
  const model = buildModel(cours.texts, cours.blocks, cours.figures);
  const all = model.all;
  const pos = new Map(all.map((s, i) => [s.id, i]));
  const starts = cours.sections.map((s) => pos.get(s.fromSentenceId) ?? 0);
  const secOf = (i: number) => starts.reduce((acc, st, k) => (i >= st ? k : acc), 0);
  const marks = new Map((cours.marks ?? []).map((m) => [m.sentenceId, m]));
  const nFig = cours.figures?.length ?? 0;

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
        <p className="muted">Du {fmtDay(cours.createdAt)} · {cours.pages} {plural(cours.pages, 'page', 'pages')} · {all.length} {plural(all.length, 'phrase', 'phrases')}{nFig > 0 ? ` · ${nFig} ${plural(nFig, 'image', 'images')}` : ''}</p>
        <p><a className="link" href="#/docs">‹ Mes cours</a></p>
        <ol className="cours-secs" aria-label="Parties du cours">
          {cours.sections.map((s, i) => (
            <li key={s.fromSentenceId} className={`cours-sec sec-${i % 6}`}>
              <span className="cf-secnum">{i + 1}</span>
              <span className="grow">
                <strong>{subjectLabel(s.subject)}{s.topic ? ` · ${s.topic}` : ''}</strong>
                {s.title && <><br /><span className="muted">{s.title}</span></>}
              </span>
              {s.status === 'fiche' && s.docId && <a className="btn btn-small" href={`#/doc/${encodeURIComponent(s.docId)}`}>Lire la fiche<span className="sr-only"> {subjectLabel(s.subject)}{s.topic ? ` ${s.topic}` : ''}</span></a>}
              {s.status === 'supprimee' && <span className="pill pill-warn">Fiche supprimée</span>}
              {s.status === 'sans_fiche' && <span className="pill pill-warn">Pas de fiche</span>}
              {s.status === 'ignoree' && <span className="subj subj-none">Ignorée</span>}
            </li>
          ))}
        </ol>
      </Card>

      <Card title="Ton cours">
        {marks.size > 0 && (
          <div className="marks-bar">
            <label className="check marks-switch">
              <input type="checkbox" checked={showMarks} onChange={(e) => setShowMarks(e.target.checked)} />
              Montrer la vérification
            </label>
            {showMarks && (
              <ul className="cf-legend marks-legend" aria-label="Couleurs de la vérification">
                <li className="mk-verifiee"><span aria-hidden="true">✓</span> Vérifié</li>
                <li className="mk-erreur"><span aria-hidden="true">✗</span> Erreur trouvée</li>
                <li className="mk-non_verifiable"><span aria-hidden="true">?</span> Non vérifiable</li>
              </ul>
            )}
          </div>
        )}
        {all.length === 0 && <p className="muted">Ce cours est vide.</p>}
        <DocView
          model={model}
          label="Texte de ton cours"
          renderFigure={(f) => <FigureView figure={f} />}
          beforeSentence={(x) => {
            const i = pos.get(x.id) ?? 0;
            const k = secOf(i);
            const sec = cours.sections[k];
            if (cours.sections.length < 2 || !sec || starts[k] !== i) return null;
            return (
              <p className={`cours-part sec-${k % 6}`}>
                <span className="cf-secnum">Partie {k + 1}</span> {subjectLabel(sec.subject)}{sec.topic ? ` · ${sec.topic}` : ''}{sec.status === 'ignoree' ? ' · ignorée' : ''}
              </p>
            );
          }}
          renderSentence={(x, { block }) => {
            const m = showMarks ? marks.get(x.id) : undefined;
            const ign = cours.sections[secOf(pos.get(x.id) ?? 0)]?.status === 'ignoree';
            return (
              <span className={`cs${m ? ` mk-${m.status}` : ''}${ign ? ' ign' : ''}`}>
                <Rich text={x.text} formula={block.kind === 'formule'} />
                {m && <>{'\u2060'}<a className={`mk mk-${m.status}`} href={`#/doc/${encodeURIComponent(m.docId)}/${encodeURIComponent(m.claimId)}`} aria-label={`${MARK[m.status].text} : voir l'affirmation dans la fiche`}>
                    <span aria-hidden="true">{MARK[m.status].icon}</span><span className="mk-t"> {MARK[m.status].text}</span>
                  </a></>}{' '}
              </span>
            );
          }}
        />
      </Card>

      <Card title="Supprimer ce cours">
        {!ask ? (
          <>
            <p className="muted">Ton cours complet est gardé dans ton espace jusqu'à ce que tu le supprimes. Supprimer une fiche seule ne supprime pas le cours.{nFig > 0 ? ' Les images gardées partent avec le cours.' : ''}</p>
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
