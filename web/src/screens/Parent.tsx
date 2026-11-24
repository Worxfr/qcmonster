import { useState, type FormEvent } from 'react';
import { api } from '../api';
import { Mascot } from '../components/Mascot';
import { Bar, Card, ErrorBox, Loading } from '../components/ui';
import { errMsg, useLoad } from '../hooks';
import type { Student } from '../types';

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
                  <p>Pages : {p.pagesRemaining}/{p.pagesLimit} (quota {s.pageQuota})</p>
                </div>
              </div>
              <div className="actions">
                <label>Quota mensuel
                  <input type="number" min={0} max={50} defaultValue={s.pageQuota} className="num"
                    onBlur={(e) => { const v = Number(e.target.value); if (Number.isInteger(v) && v >= 0 && v <= 50 && v !== s.pageQuota) void act(() => api.updateStudent(s.studentId, { pageQuota: v })); }} />
                </label>
                <button className="btn btn-small" onClick={() => act(() => api.updateStudent(s.studentId, { status: s.status === 'actif' ? 'suspendu' : 'actif' }))}>
                  {s.status === 'actif' ? 'Suspendre' : 'Réactiver'}
                </button>
                <button className="btn btn-small btn-alt" onClick={() => newLink(s)}>Nouveau lien (mot de passe perdu)</button>
                <button className="btn btn-small btn-ghost" onClick={() => { if (window.confirm(`Supprimer ${s.pseudo} et toutes ses données ?`)) void act(() => api.deleteStudent(s.studentId)); }}>Supprimer</button>
              </div>
            </li>
          ))}
        </ul>
      </Card>
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
      const r = await api.createStudent({ pseudo, schoolLevel: level, under15, parentalAuthority: true });
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
        <label className="check"><input type="checkbox" checked={authority} onChange={(e) => setAuthority(e.target.checked)} required /> J'ai l'autorité parentale sur cet élève</label>
        <ErrorBox message={error} />
        <button className="btn" disabled={busy || !valid || !authority}>Créer et obtenir le lien</button>
      </form>
    </Card>
  );
}
