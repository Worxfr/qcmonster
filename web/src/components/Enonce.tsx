import { useMemo } from 'react';
import { isBigFormula, parseEnonce, type Sentence } from '../enonce';
import { Formula, Rich } from './Math';

/** Une valeur longue (nombre puis unite) passe sur deux lignes: `symbole = nombre` puis l'unite, pour ne pas etre coupee sur mobile. */
function splitUnit(tex: string): [string, string?] {
  const eq = tex.indexOf('=');
  const m = tex.length > 30 ? /(?:\\[ ,;]\s*)*\\mathrm\{/.exec(tex.slice(eq)) : null;
  if (!m || eq < 0 || m.index === 0) return [tex];
  const at = eq + m.index;
  return [tex.slice(0, at).trim(), tex.slice(at).replace(/^(?:\\[ ,;]\s*)+/, '').trim()];
}

/** Une phrase; une formule longue qui la termine passe sur sa propre ligne, en grand. */
function Phrase({ s }: { s: Sentence }) {
  const last = s[s.length - 1];
  const tail = s.length > 1 && last && 'text' in last && /^[\s.;,]*$/.test(last.text) ? s[s.length - 2] : last;
  const big = tail && 'math' in tail && isBigFormula(tail.math) ? tail : null;
  const body = big ? s.slice(0, s.indexOf(big)) : s;
  return (
    <>
      {body.length > 0 && <p>{body.map((x, i) => ('text' in x ? <span key={i}>{x.text}</span> : <Formula key={i} tex={x.math} />))}</p>}
      {big && <p className="enonce-big"><Formula tex={big.math} display /></p>}
    </>
  );
}

/**
 * Enonce lisible: contexte, donnees, question(s). Si le texte ne se decoupe pas, il reste un seul bloc (repli).
 * Tout le texte passe par `Rich` / `Formula` (filtre partage + KaTeX trust: false).
 */
export function Enonce({ text }: { text: string }) {
  const e = useMemo(() => parseEnonce(text), [text]);
  if (!e) return <div className="enonce enonce-plain" aria-label="Énoncé"><Rich text={text} /></div>;
  return (
    <div className="enonce" aria-label="Énoncé">
      {e.contexte.length > 0 && <div className="enonce-ctx">{e.contexte.map((s, i) => <Phrase key={i} s={s} />)}</div>}
      {e.donnees.length > 0 && (
        <section className="enonce-data" aria-labelledby="enonce-data-h">
          <h2 id="enonce-data-h" className="enonce-h"><span aria-hidden="true">📐</span> Données</h2>
          <dl>
            {e.donnees.map((d, i) => (
              <div key={i} className="enonce-datum">
                {d.label && <dt>{d.label}</dt>}
                <dd>{(([v, u]) => <><Formula tex={v} />{u && <span className="enonce-unit"><Formula tex={u} /></span>}</>)(splitUnit(d.tex))}</dd>
              </div>
            ))}
          </dl>
        </section>
      )}
      {e.questions.length > 0 && (
        <section className="enonce-q" aria-labelledby="enonce-q-h">
          <h2 id="enonce-q-h" className="enonce-h"><span aria-hidden="true">❓</span> {e.questions.length > 1 ? 'Questions' : 'Question'}</h2>
          <ol className={e.questions.length > 1 ? 'enonce-qs' : 'enonce-qs enonce-q1'}>
            {e.questions.map((s, i) => (
              <li key={i}>{e.questions.length > 1 && <span className="enonce-qn" aria-hidden="true">{i + 1}</span>}<div><Phrase s={s} /></div></li>
            ))}
          </ol>
        </section>
      )}
    </div>
  );
}
