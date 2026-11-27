import { useEffect, useLayoutEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { api } from '../api';
import { Rich } from '../components/Math';
import { ErrorBox, Pill } from '../components/ui';
import { safeUrl } from '../game';
import { errMsg } from '../hooks';
import type { Claim, Doc } from '../types';

/**
 * La fiche comme un document: des paragraphes de texte continu, chaque affirmation est un segment colore
 * (vert: verifie, orange: non verifiable, rouge: erreur). Sources et signalement sont dans une surimpression
 * (popover sur PC, feuille basse sur mobile), jamais repetes sous chaque phrase.
 *
 * Choix de fidelite (docs/FICHE-UX-report.md): le texte d'un paragraphe est ecrit par le modele et ne se decoupe pas
 * exactement en affirmations. Un paragraphe qui cite des `claimIds` est donc RENDU A PARTIR DU TEXTE DE CES AFFIRMATIONS,
 * dans l'ordre: aucune affirmation ne change de texte ni d'etat. Un paragraphe sans `claimIds` est affiche tel quel, sans marque.
 */
export type Para = { key: string; heading?: string; claims: Claim[]; plain?: string };

export function buildParas(doc: Pick<Doc, 'body' | 'claims' | 'summary'>): Para[] {
  const byId = new Map(doc.claims.map((c) => [c.claimId, c]));
  const used = new Set<string>();
  const out: Para[] = [];
  (doc.body ?? []).forEach((p, i) => {
    const claims = [...new Set(p.claimIds ?? [])].map((id) => byId.get(id)).filter((c): c is Claim => !!c);
    claims.forEach((c) => used.add(c.claimId));
    out.push(claims.length ? { key: `p${i}`, heading: p.heading, claims } : { key: `p${i}`, heading: p.heading, claims: [], plain: p.text });
  });
  const rest = doc.claims.filter((c) => !used.has(c.claimId));
  if (!out.length) {
    // ancienne fiche (sans paragraphes): un seul texte continu a partir des affirmations
    if (rest.length) out.push({ key: 'p0', claims: rest });
    else out.push({ key: 'p0', claims: [], plain: doc.summary });
  } else if (rest.length) {
    // aucune affirmation ne disparait: celles qu'aucun paragraphe ne cite sont ajoutees a la fin
    out.push({ key: 'rest', heading: 'Autres points contrôlés', claims: rest });
  }
  return out;
}

const MARK = { verifiee: '✓', non_verifiable: '?', erreur: '✗' } as const;
const SR = { verifiee: 'vérifié', non_verifiable: 'non vérifiable', erreur: 'erreur' } as const;
type Marked = keyof typeof MARK;
const isMarked = (s: Claim['status']): s is Marked => s in MARK;

export function FicheText({ doc, docId, focusClaimId }: { doc: Doc; docId: string; focusClaimId?: string }) {
  const paras = buildParas(doc);
  const root = useRef<HTMLDivElement>(null);
  const first = focusClaimId ? paras.flatMap((p) => p.claims.map((c) => ({ key: `${p.key}-${c.claimId}`, c }))).find((x) => x.c.claimId === focusClaimId) : undefined;
  const [open, setOpen] = useState<{ key: string; claim: Claim } | null>(first && isMarked(first.c.status) ? { key: first.key, claim: first.c } : null);
  const auto = useRef(!!first); // ouverte par le lien (signalement, cours): on ne vole pas le focus
  const [sent, setSent] = useState<Set<string>>(new Set());

  const anchor = (key: string) => document.getElementById(`seg-${key}`);
  function close(toSegment: boolean) {
    const key = open?.key;
    setOpen(null);
    if (toSegment && key) requestAnimationFrame(() => anchor(key)?.focus());
  }

  // clic ou toucher a l'exterieur, Echap
  useEffect(() => {
    if (!open) return;
    const down = (e: Event) => {
      const t = e.target as Node;
      if (t instanceof Element && (t.closest('.fiche-pop') || t.closest('.seg'))) return;
      setOpen(null);
    };
    const key = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') close(true);
    };
    document.addEventListener('pointerdown', down);
    document.addEventListener('keydown', key);
    return () => { document.removeEventListener('pointerdown', down); document.removeEventListener('keydown', key); };
  });

  // position (PC) sous la derniere ligne du segment, ramenee dans la colonne; au-dessus si le bas de l'ecran est trop proche
  useLayoutEffect(() => {
    if (!open || !root.current) return;
    const seg = anchor(open.key);
    const pop = root.current.querySelector<HTMLElement>('.fiche-pop');
    if (!seg || !pop) return;
    const box = root.current.getBoundingClientRect();
    const rects = seg.getClientRects();
    const r = rects[rects.length - 1] ?? seg.getBoundingClientRect();
    const w = Math.min(380, box.width);
    const left = Math.max(0, Math.min(r.left - box.left, box.width - w));
    let top = r.bottom - box.top + 6;
    if (r.bottom + pop.offsetHeight + 12 > window.innerHeight && rects[0] && rects[0].top - pop.offsetHeight - 12 > 0) top = rects[0].top - box.top - pop.offsetHeight - 6;
    pop.style.left = `${left}px`;
    pop.style.top = `${top}px`;
    pop.style.width = `${w}px`;
  }, [open]);

  // focus: dans la surimpression a l'ouverture (sauf ouverture par lien), puis rendu au segment
  useEffect(() => {
    if (!open) return;
    if (auto.current) {
      auto.current = false;
      anchor(open.key)?.scrollIntoView?.({ block: 'center' });
      return;
    }
    root.current?.querySelector<HTMLElement>('.fiche-pop button')?.focus();
  }, [open]);

  function toggle(key: string, claim: Claim) {
    setOpen((o) => (o?.key === key ? null : { key, claim }));
  }
  function onKey(e: KeyboardEvent, key: string, claim: Claim) {
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(key, claim); }
  }

  return (
    <div className="fiche-doc" ref={root}>
      <p className="fiche-legend muted">
        <span className="seg-mark seg-mark-verifiee" aria-hidden="true">✓</span> vérifié{' '}
        <span className="seg-mark seg-mark-non_verifiable" aria-hidden="true">?</span> non vérifiable.
        {' '}Touche une phrase colorée pour voir les sources.
      </p>
      <div className="fiche-body">
        {paras.map((p) => (
          <div key={p.key}>
            {p.heading && <h3><Rich text={p.heading} /></h3>}
            <p>
              {p.plain !== undefined ? <Rich text={p.plain} /> : p.claims.map((c, i) => {
                const key = `${p.key}-${c.claimId}`;
                const sep = i > 0 ? ' ' : '';
                if (!isMarked(c.status)) return <span key={key}>{sep}<Rich text={c.text} /></span>;
                const isOpen = open?.key === key;
                return (
                  <span key={key}>
                    {sep}
                    <span
                      id={`seg-${key}`}
                      className={`seg seg-${c.status}${isOpen ? ' seg-open' : ''}`}
                      role="button"
                      tabIndex={0}
                      aria-expanded={isOpen}
                      aria-haspopup="dialog"
                      aria-controls={isOpen ? 'fiche-pop' : undefined}
                      onClick={() => toggle(key, c)}
                      onKeyDown={(e) => onKey(e, key, c)}
                    >
                      <Rich text={c.text} />
                      <sup className={`seg-mark seg-mark-${c.status}`} aria-hidden="true">{MARK[c.status]}</sup>
                      <span className="sr-only"> ({SR[c.status]}, ouvrir les sources)</span>
                    </span>
                  </span>
                );
              })}
            </p>
          </div>
        ))}
      </div>
      {open && (
        <>
          <div className="fiche-backdrop" aria-hidden="true" onClick={() => close(false)} />
          <Pop
            claim={open.claim}
            docId={docId}
            sent={sent.has(open.claim.claimId)}
            onSent={() => setSent((s) => new Set(s).add(open.claim.claimId))}
            onClose={() => close(true)}
            onLeave={() => setOpen(null)}
          />
        </>
      )}
    </div>
  );
}

function Pop({ claim, docId, sent, onSent, onClose, onLeave }: { claim: Claim; docId: string; sent: boolean; onSent: () => void; onClose: () => void; onLeave: () => void }) {
  const [report, setReport] = useState(false);
  const [comment, setComment] = useState('');
  const [err, setErr] = useState<string | null>(null);
  const box = useRef<HTMLDivElement>(null);

  async function send(e: FormEvent) {
    e.preventDefault();
    try {
      await api.report(docId, comment.trim(), claim.claimId);
      onSent();
      setReport(false);
      setComment('');
    } catch (x) {
      setErr(errMsg(x));
    }
  }

  return (
    <div
      id="fiche-pop"
      ref={box}
      className={`fiche-pop fiche-pop-${claim.status}`}
      role="dialog"
      tabIndex={-1}
      aria-label={`Sources de l'affirmation (${SR[claim.status as Marked] ?? ''})`}
      onBlur={(e) => { if (!box.current?.contains(e.relatedTarget as Node | null) && !(e.relatedTarget instanceof Element && e.relatedTarget.closest('.seg'))) onLeave(); }}
    >
      <div className="fiche-pop-head">
        <Pill status={claim.status} />
        <button type="button" className="fiche-pop-close" onClick={onClose} aria-label="Fermer">✕</button>
      </div>
      {claim.aRisque && <p className="muted">⚠ Sujet sensible : demande aussi à ton professeur.</p>}
      {claim.sources.length > 0 ? (
        <ul className="sources">
          {claim.sources.map((s) => {
            const href = safeUrl(s.url);
            return (
              <li key={s.passageId}>
                {href ? <a href={href} target="_blank" rel="noopener noreferrer">{s.titre} <span className="muted">({s.site})</span></a> : <span>{s.titre} ({s.site})</span>}
                <blockquote>{s.extrait}</blockquote>
              </li>
            );
          })}
        </ul>
      ) : <p className="muted">Pas de source trouvée pour cette phrase.</p>}
      {sent && <p role="status" className="ok">Merci ! Ton parent va regarder ton signalement.</p>}
      {report ? (
        <form onSubmit={send} className="stack">
          <label>Qu'est-ce qui est faux ?
            <textarea rows={2} value={comment} maxLength={500} required autoFocus onChange={(e) => setComment(e.target.value)} />
          </label>
          <ErrorBox message={err} />
          <button className="btn btn-small">Envoyer</button>
        </form>
      ) : (
        <button type="button" className="btn btn-small btn-ghost" onClick={() => setReport(true)}>Signaler une erreur</button>
      )}
    </div>
  );
}
