import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Mascot } from '../components/Mascot';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { badgeLabel } from '../game';
import { archiveError } from '../history';
import { errMsg, useLoad } from '../hooks';
import type { ExportArchive, Student } from '../types';
import { POLICY_VERSION } from '../../../shared/policy';
import { PolicyLink } from './Policy';

export function Parent() {
  const d = useLoad(() => api.dashboard(), []);
  const lb = useLoad(() => api.leaderboard(), []);
  const [link, setLink] = useState<{ pseudo: string; url: string; expiresAt: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (d.loading) return <Loading />;
  if (!d.data) return <ErrorBox message={d.error} />;
  const dash = d.data;
  const used = dash.familyPagesLimit - dash.familyPagesRemaining;
  const pct = dash.familyPagesLimit ? Math.round((used / dash.familyPagesLimit) * 100) : 0;

  const act = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      d.reload();
    } catch (e) {
      setError(errMsg(e));
    }
  };
  const newLink = (s: Student) => act(async () => { const l = await api.activationLink(s.studentId); setLink({ pseudo: s.pseudo, ...l }); });

  return (
    <>
      <Card title="Pages de la famille">
        <p>{used} page{used > 1 ? 's' : ''} utilisée{used > 1 ? 's' : ''} sur {dash.familyPagesLimit} ce mois-ci.</p>
        <Bar pct={pct} label="Pages utilisées par la famille" />
      </Card>
      <ErrorBox message={error} />
      {link && (
        <Card title={`Lien d'activation de ${link.pseudo}`}>
          <p>À donner à l'élève en main propre. Il ne marche qu'une fois et expire le {new Date(link.expiresAt).toLocaleString('fr-FR')}.</p>
          <p><input readOnly aria-label="Lien d'activation" value={link.url} onFocus={(e) => e.target.select()} /></p>
          <button className="btn btn-small" onClick={() => navigator.clipboard?.writeText(link.url)}>Copier le lien</button>
          <button className="btn btn-small btn-ghost" onClick={() => setLink(null)}>Fermer</button>
        </Card>
      )}
      <Card title="Les élèves">
        {dash.students.length === 0 && <p>Aucun élève pour l'instant. Invite le premier ci-dessous.</p>}
        <ul className="list">
          {dash.students.map(({ student: s, progress: p }) => (
            <li key={s.studentId} className="student">
              <div className="hero-row">
                <Mascot stage={p.stage} size={72} label={false} />
                <div className="grow">
                  <h3>{s.pseudo} {s.status === 'suspendu' && <span className="pill pill-warn">Suspendu</span>}</h3>
                  <p className="muted">Niveau {p.level} · {p.xp} XP · série {p.streakDays} j</p>
                  <p>Pages restantes ce mois-ci : {p.pagesRemaining} sur {p.pagesLimit} (quota de l'élève : {s.pageQuota})</p>
                  <p className="btn-row">
                    <a className="btn btn-small" href={`#/suivi/${encodeURIComponent(s.studentId)}`}>📈 Suivi de {s.pseudo}</a>
                    <a className="btn btn-small btn-ghost" href={`#/eleve/${encodeURIComponent(s.studentId)}`}>📚 Les cours de {s.pseudo}</a>
                  </p>
                  {(p.badges?.length ?? 0) > 0 && (
                    <ul className="badges" aria-label={`Badges de ${s.pseudo}`}>
                      {p.badges!.map((b) => <li key={b} className="got"><span aria-hidden="true">🏅</span> {badgeLabel(b)}</li>)}
                    </ul>
                  )}
                </div>
              </div>
              <div className="actions">
                <label>Quota mensuel (pages, 0 à {dash.familyPagesLimit})
                  <input type="number" min={0} max={dash.familyPagesLimit} defaultValue={s.pageQuota} className="num"
                    onBlur={(e) => {
                      const v = Number(e.target.value);
                      if (e.target.value === '' || !Number.isInteger(v) || v < 0 || v > dash.familyPagesLimit) {
                        setError(`Le quota doit être un nombre entier entre 0 et ${dash.familyPagesLimit} (plafond de la famille).`);
                        e.target.value = String(s.pageQuota);
                      } else if (v !== s.pageQuota) void act(() => api.updateStudent(s.studentId, { pageQuota: v }));
                    }} />
                </label>
                <button className="btn btn-small" onClick={() => act(() => api.updateStudent(s.studentId, { status: s.status === 'actif' ? 'suspendu' : 'actif' }))}>
                  {s.status === 'actif' ? 'Suspendre' : 'Réactiver'}
                </button>
                <button className="btn btn-small btn-alt" onClick={() => newLink(s)}>Nouveau lien (mot de passe perdu)</button>
                <label>Niveau
                  <select value={s.schoolLevel} onChange={(e) => void act(() => api.updateStudent(s.studentId, { schoolLevel: e.target.value as Student['schoolLevel'] }))}>
                    <option value="seconde">Seconde</option>
                    <option value="premiere">Première</option>
                    <option value="terminale">Terminale</option>
                  </select>
                </label>
                <button className="btn btn-small btn-ghost" onClick={() => { if (window.confirm(`Supprimer ${s.pseudo} et toutes ses données ?`)) void act(() => api.deleteStudent(s.studentId)); }}>Supprimer</button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
      <Card title="Tes données">
        <p>Tu peux récupérer toutes les données de ta famille (comptes, fiches, résultats, signalements) dans un fichier lisible. Lis aussi la <PolicyLink />.</p>
        <button className="btn btn-small" onClick={() => void act(downloadExport)}>Télécharger les données</button>
      </Card>
      <ArchiveCard />
      <Invite onCreated={(l) => { setLink(l); d.reload(); }} />
      {lb.data && lb.data.entries.length > 0 && (
        <Card title={`Classement · ${lb.data.week}`}>
          <ol className="board">
            {[...lb.data.entries].sort((a, b) => b.xp - a.xp).map((e, i) => (
              <li key={e.studentId}><span className="rank">{i + 1}</span><span className="grow">{e.pseudo}</span><strong>{e.xp} XP</strong></li>
            ))}
          </ol>
        </Card>
      )}
    </>
  );
}

export async function downloadExport() {
  const data = await api.exportFamily();
  const url = URL.createObjectURL(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = 'qcmonster-donnees.json';
  a.click();
  URL.revokeObjectURL(url);
}

function Invite({ onCreated }: { onCreated: (l: { pseudo: string; url: string; expiresAt: string }) => void }) {
  const [pseudo, setPseudo] = useState('');
  const [level, setLevel] = useState<'seconde' | 'premiere' | 'terminale'>('seconde');
  const [under15, setUnder15] = useState(false);
  const [authority, setAuthority] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const valid = /^[A-Za-z][A-Za-z0-9 -]{1,19}$/.test(pseudo);

  async function submit(e: FormEvent) {
    e.preventDefault();
    if (!valid || !authority) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createStudent({ pseudo, schoolLevel: level, under15, parentalAuthority: authority as true, policyVersion: POLICY_VERSION });
      onCreated({ pseudo: r.student.pseudo, ...r.activationLink });
      setPseudo('');
      setAuthority(false);
    } catch (x) {
      setError(errMsg(x));
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card title="Inviter un élève">
      <form className="stack" onSubmit={submit}>
        <label>Pseudo (sans nom de famille)
          <input value={pseudo} onChange={(e) => setPseudo(e.target.value)} maxLength={20} required aria-describedby="pseudo-help" />
        </label>
        <p id="pseudo-help" className="muted">2 à 20 caractères : lettres, chiffres, espace ou tiret. Un code est ajouté (Lila-7k2f).</p>
        <label>Niveau
          <select value={level} onChange={(e) => setLevel(e.target.value as typeof level)}>
            <option value="seconde">Seconde</option>
            <option value="premiere">Première</option>
            <option value="terminale">Terminale</option>
          </select>
        </label>
        <label className="check"><input type="checkbox" checked={under15} onChange={(e) => setUnder15(e.target.checked)} /> L'élève a moins de 15 ans</label>
        <label className="check">
          <input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} required />
          <span>J'ai l'autorité parentale sur cet élève. J'ai lu la <PolicyLink /> et j'accepte, pour lui ou elle, que ses cours soient analysés et que son pseudo et ses résultats soient gardés. Je peux retirer mon accord à tout moment en supprimant son compte.</span>
        </label>
        <ErrorBox message={error} />
        <button className="btn" disabled={busy || !valid || !authority}>Créer et obtenir le lien</button>
      </form>
    </Card>
  );
}

/** Archive complète (zip) avec tout l'historique des tests: POST /family/export/archive, lien valable 10 minutes. */
function ArchiveCard() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [a, setA] = useState<ExportArchive | null>(null);

  async function ask() {
    setBusy(true);
    setError(null);
    try {
      setA(await api.exportArchive());
    } catch (e) {
      setError(archiveError(e)); // le lien d'une archive precedente, encore valable 10 minutes, reste affiche
    } finally {
      setBusy(false);
    }
  }
  const size = (n: number) => (n < 1024 * 1024 ? `${Math.max(1, Math.round(n / 1024))} Ko` : `${(n / 1024 / 1024).toFixed(1)} Mo`);

  return (
    <Card title="Archive avec l'historique des tests">
      <p>Un fichier zip avec toutes les données de ta famille et le résultat de chaque test, année après année. Le lien est valable 10 minutes. Tu peux demander 3 archives par heure.</p>
      <button className="btn btn-small" disabled={busy} onClick={() => void ask()}>{busy ? 'Préparation…' : "Préparer l'archive"}</button>
      <ErrorBox message={error} />
      {a && (
        <div className="soft archive-ready" role="status">
          <p><strong>Ton archive est prête</strong> ({size(a.sizeBytes)}, {a.tests} test{a.tests > 1 ? 's' : ''}, {a.students} élève{a.students > 1 ? 's' : ''}).</p>
          <p><a className="btn" href={a.url} rel="noopener noreferrer" download>⬇ Télécharger l'archive</a></p>
          <p className="muted">Le lien expire à {new Date(a.expiresAt).toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit' })}. Passé ce délai, prépare une nouvelle archive.</p>
          {a.truncated && <p className="notice">L'archive est limitée aux 50 000 tests les plus récents : les années les plus anciennes n'y sont pas.</p>}
        </div>
      )}
    </Card>
  );
}
