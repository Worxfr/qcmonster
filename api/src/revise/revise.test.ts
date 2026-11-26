// Modification d'un cours confirme (M1 #90, partie 1): creation, plafonds, verrou, machine, echec, reprise, annulation, suppression. Aucun appel reel.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { deleteStudentTree, memoryTreeDb } from '../../../shared/delete-tree.js';
import { REVISION_RESERVE_MICROS } from '../../../shared/scans.js';
import { coursApi } from '../cours/cours.js';
import { docsDelete } from '../docs/docs.js';
import { reclaimLock } from '../pipeline/append.js';
import { guarded } from '../pipeline/http.js';
import { treeDbFrom } from '../pipeline/ports.js';
import { endWithoutDoc } from '../pipeline/job.js';
import { expire, failJob, purgeScan } from '../pipeline/steps.js';
import { jobsCancel, jobsConfirm } from '../pipeline/api.js';
import { scansDelete } from '../scans/delete.js';
import { event, parent } from '../pipeline/testkit.js';
import { revCommit, revFail } from './machine.js';
import { bodyOf, cancel, correction, COURS, create, DOC, get, runMachine, setup, snapshot } from './testkit.js';

const ids = (revisionId: string) => ({ revisionId, sid: 's1', fid: 'f1', coursId: COURS });
const job = async (k: Awaited<ReturnType<typeof setup>>, id: string) => (await k.db.get(keys.job('s1', id)))!;
const head = (k: Awaited<ReturnType<typeof setup>>) => k.db.get(keys.cours('s1', COURS));

describe('interrupteur', () => {
  it('ferme par defaut: 404 sans rien ecrire; ouvert: 202', async () => {
    const k = await setup();
    const off = { ...k.ctx, cfg: {} };
    const before = k.db.items.size;
    expect((await create(off, correction)).statusCode).toBe(404);
    expect((await create({ ...k.ctx, cfg: { reviseEnabled: false } }, correction)).statusCode).toBe(404);
    expect(k.db.items.size).toBe(before);
    expect((await create(k.ctx, correction)).statusCode).toBe(202);
  });
});

describe('creation', () => {
  it('202: job, verrou, compteurs et requete ecrits ensemble; machine lancee avec les 4 identifiants', async () => {
    const k = await setup();
    const r = await create(k.ctx, correction);
    expect(r.statusCode).toBe(202);
    const b = bodyOf(r);
    expect(JSON.stringify(b)).not.toContain('chloroplastes'); // jamais de texte du cours
    const j = await job(k, b.revisionId);
    expect(j).toMatchObject({ kind: 'revision', state: 'verification', familyId: 'f1', reserveMicros: REVISION_RESERVE_MICROS });
    expect((await head(k))?.appendJobId).toBe(b.revisionId);
    expect(k.sfn.started[0].input).toEqual(ids(b.revisionId));
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(REVISION_RESERVE_MICROS);
    expect((await k.db.get(keys.revFamily('f1', '2026-12')))?.coutMicros).toBe(REVISION_RESERVE_MICROS);
    expect((await k.db.get(keys.revDay('s1', '2026-12-01')))?.n).toBe(1);
    expect(await k.db.get(keys.revChanges(b.revisionId))).toBeDefined();
  });
  it('parent 403, cours d\'un autre eleve ou inconnu 404 identique, corps invalide 400', async () => {
    const k = await setup();
    expect((await guarded((await import('./create.js')).reviseCreate)(k.ctx, parent({ params: { coursId: COURS }, body: correction }))).statusCode).toBe(403);
    const other = bodyOf(await create(k.ctx, correction, { coursId: 'inconnu' }));
    expect(other.code).toBe('introuvable');
    expect((await create(k.ctx, { corrections: 'x' })).statusCode).toBe(400);
    expect((await create(k.ctx, {})).statusCode).toBe(400);
  });
  it('refus 400 constants, rien n\'est ecrit: phrase inconnue, debut de partie, partie vide, 40 mots, LaTeX, 21 changements', async () => {
    const k = await setup();
    const before = snapshot(k.db) + k.db.items.size;
    const cases: unknown[] = [
      { removed: ['p1-s99'] },
      { removed: ['p1-s1'] },
      { removed: COURSE_IDS.slice(0, 8) },
      { corrections: [{ id: 'p1-s2', text: '$\\href{x}{y}$' }] },
      { removed: Array.from({ length: 21 }, (_, n) => `p1-s${n + 1}`) },
    ];
    for (const c of cases) {
      const r = await create(k.ctx, c);
      expect(r.statusCode, JSON.stringify(c)).toBe(400);
      expect(r.body).not.toContain('chloroplastes');
    }
    expect(snapshot(k.db) + k.db.items.size).toBe(before);
    // sous 40 mots: retirer presque tout
    const short = await create(k.ctx, { removed: ['p1-s2', 'p1-s3', 'p1-s4', 'p1-s5', 'p1-s6', 'p1-s7'] });
    expect(short.statusCode).toBe(400);
  });
  it('plafonds: 1 par cours et par jour, 2 par eleve et par jour, compteurs dans la transaction (un refus n\'en laisse aucun)', async () => {
    const k = await setup();
    const first = bodyOf(await create(k.ctx, correction));
    const second = await create(k.ctx, correction); // meme cours: verrou
    expect(second.statusCode).toBe(409);
    await runMachine(k.ctx, first.revisionId);
    expect((await job(k, first.revisionId)).state).toBe('termine');
    const again = await create(k.ctx, { corrections: [{ id: 'p1-s3', text: 'Elle absorbe du dioxyde de carbone par les feuilles de la plante.' }] });
    expect(again.statusCode).toBe(429);
    expect(bodyOf(again).code).toBe('plafond_revisions');
    expect((await k.db.get(keys.revDay('s1', '2026-12-01')))?.n).toBe(1); // le refus n'a rien compte
  });
  it('plafond mensuel en cout reel: eleve (0,50) et famille (1,50); la reserve est reglee au cout reel une seule fois', async () => {
    const k = await setup();
    await k.db.put({ ...keys.revMonth('s1', '2026-12'), coutMicros: 450_000 });
    expect((await create(k.ctx, correction)).statusCode).toBe(429);
    await k.db.put({ ...keys.revMonth('s1', '2026-12'), coutMicros: 0 });
    await k.db.put({ ...keys.revFamily('f1', '2026-12'), coutMicros: 1_450_000 });
    expect((await create(k.ctx, correction)).statusCode).toBe(429);
    await k.db.put({ ...keys.revFamily('f1', '2026-12'), coutMicros: 0 });
    const b = bodyOf(await create(k.ctx, correction));
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(REVISION_RESERVE_MICROS);
    await runMachine(k.ctx, b.revisionId);
    const spent = (await job(k, b.revisionId)).coutMicros as number;
    expect(spent).toBeGreaterThan(0);
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(spent); // reserve remplacee par le cout reel
    await revFail(k.ctx, ids(b.revisionId));
    await revCommit(k.ctx, ids(b.revisionId));
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(spent); // rejoue: aucun second reglement
    expect((await k.db.get(keys.revFamily('f1', '2026-12')))?.coutMicros).toBe(spent);
  });
  it('mutation: deux creations simultanees, une seule gagne (jamais deux verrous ni deux reserves)', async () => {
    const k = await setup();
    const rs = await Promise.all([create(k.ctx, correction), create(k.ctx, correction)]);
    expect(rs.map((r) => r.statusCode).sort()).toEqual([202, 409]);
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(REVISION_RESERVE_MICROS);
  });
  it('un lancement de machine qui echoue ne laisse ni verrou, ni reserve, ni compteur, ni requete', async () => {
    const k = await setup();
    const ctx = { ...k.ctx, sfn: { ...k.ctx.sfn, start: async () => { throw new Error('panne'); } } };
    await expect(create(ctx, correction)).rejects.toThrow('panne');
    expect((await head(k))?.appendJobId).toBeUndefined();
    expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe(0);
    expect((await k.db.get(keys.revDay('s1', '2026-12-01')))?.n).toBe(0);
    expect((await k.db.query('JOB#' + [...k.db.items.values()].find((i) => i.kind === 'revision')!.SK.slice(4))).length).toBe(0);
    expect((await create(k.ctx, correction)).statusCode).toBe(202); // le cours est de nouveau modifiable
  });
  it('fiche trop retouchee: 409 fiche_trop_revisee, rien ecrit', async () => {
    const k = await setup();
    await k.db.put({ ...keys.claim(DOC, 90), texte: 'x y z t u', origine: { page: 1, phraseId: 'p1-s8', extrait: 'a b' }, type: 'factuelle', aRisque: false });
    const r = await create(k.ctx, correction);
    expect(r.statusCode).toBe(409);
    expect(bodyOf(r).code).toBe('fiche_trop_revisee');
    expect((await head(k))?.appendJobId).toBeUndefined();
  });
  it('parties ignorees seulement: 200 termine tout de suite, sans machine ni verrou, texte et blocs ecrits', async () => {
    const k = await setup({}, { sections: 'two' });
    const r = await create(k.ctx, { corrections: [{ id: 'p1-s8', text: 'Ce phenomene a lieu surtout pendant la journee quand il fait clair.' }] });
    expect(r.statusCode).toBe(200);
    expect(bodyOf(r).etat).toBe('terminee');
    expect(k.sfn.started).toHaveLength(0);
    expect((await head(k))?.appendJobId).toBeUndefined();
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', COURS, 1)))).toContain('il fait clair');
    expect((await k.db.get(keys.doc('s1', DOC)))?.rev).toBeUndefined(); // la fiche n'est pas touchee
    expect((await create(k.ctx, correction)).statusCode).toBe(429); // 1 par cours et par jour, meme sans fiche
  });
});

describe('machine: de bout en bout', () => {
  it('correction: fiche gardee (meme docId), anciennes affirmations retirees mais conservees, questions retirees mais conservees, rev en dernier', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId);
    const j = await job(k, b.revisionId);
    expect(j).toMatchObject({ state: 'termine' });
    expect(j.commitStartedAt).toBeDefined();
    expect(j.committedAt).toBeDefined();
    const fiche = (await k.db.get(keys.doc('s1', DOC)))!;
    expect(fiche.claimsRetired).toEqual([1]); // CLAIM#01 (phrase p1-s2)
    expect(fiche.rev).toBe(1);
    expect(fiche.resume).toBe('Les plantes vertes fabriquent leur matiere.');
    const part = await k.db.query(`DOC#${DOC}`);
    expect(part.find((x) => x.SK === 'CLAIM#01')).toBeDefined(); // jamais supprimee ni modifiee
    expect(part.find((x) => x.SK === 'CLAIM#01')?.texte).toBe('Affirmation 1 du cours.');
    expect(part.find((x) => x.SK === 'CLAIM#05')?.texte).toContain('chloroplastes des cellules');
    expect(part.find((x) => x.SK === 'QCM#01')?.retiree).toBe(true);
    expect(part.find((x) => x.SK === 'QCM#02')?.retiree).toBeUndefined();
    expect(part.find((x) => x.SK === 'QCM#04')).toMatchObject({ claimId: '05', questionId: `${DOC}:qcm:04` });
    expect(part.find((x) => x.SK === 'GAP#01')?.retiree).toBe(true);
    expect(part.find((x) => x.SK === 'VERDICT#05')?.ttl).toBeUndefined(); // aucun ttl promu dans la fiche vivante
    expect(fiche.nbQuestions).toBe(3 - 1 + 3 - 1 + 2);
    expect(JSON.stringify(await k.db.get(keys.coursText('s1', COURS, 1)))).toContain('Elle se deroule dans les chloroplastes des cellules vegetales.');
    expect((await head(k))?.appendJobId).toBeUndefined();
    // copie de travail et requete supprimees
    expect([...k.db.items.keys()].filter((x) => x.startsWith(`DOC#${b.revisionId}`) || x.startsWith(`JOB#${b.revisionId}`))).toEqual([]);
    expect(bodyOf(await get(k.ctx, b.revisionId)).etat).toBe('terminee');
  });
  it('phrase ajoutee et retiree: nbPhrases, identifiants stables, aucune renumerotation', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, { added: [{ key: 'n1', afterId: 'p1-s3', text: 'Elle se deroule dans les chloroplastes des cellules vegetales aussi.' }], removed: ['p1-s8'] }));
    await runMachine(k.ctx, b.revisionId);
    expect((await job(k, b.revisionId)).state).toBe('termine');
    expect((await head(k))?.nbPhrases).toBe(8);
    const t = JSON.stringify(await k.db.get(keys.coursText('s1', COURS, 1)));
    expect(t).toContain('"id":"p1-s9"');
    expect(t).not.toContain('"id":"p1-s8"');
    expect(t).toContain('"id":"p1-s7"');
  });
  it('les points deja gagnes restent: les ATT# et TEST# ne bougent pas', async () => {
    const k = await setup();
    await k.db.put({ ...keys.attempt('s1', `${DOC}:qcm:01`, '2026-12-01'), xp: 5 });
    await k.db.put({ ...keys.test('s1', '2026-12-01T09:00:00Z', 'T1'), docId: DOC, items: [{ q: `${DOC}:qcm:01` }] });
    const before = JSON.stringify([...k.db.items.values()].filter((i) => /^(ATT#|TEST#)/.test(i.SK)));
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId);
    expect(JSON.stringify([...k.db.items.values()].filter((i) => /^(ATT#|TEST#)/.test(i.SK)))).toBe(before);
  });
  it('aucune affirmation: pas un echec, l\'en-tete du cours et la fiche ne sont ecrits que par la validation', async () => {
    const k = await setup({ extraction: JSON.stringify({ titre: 'x', matiere: 'svt', affirmations: [] }) });
    const b = bodyOf(await create(k.ctx, correction));
    const putSpy: string[] = [];
    const orig = k.db.put.bind(k.db);
    k.db.put = async (it, n) => { putSpy.push(it.SK); return orig(it, n); };
    await runMachine(k.ctx, b.revisionId, { stopAfter: 'extract' });
    expect(putSpy.filter((s) => s.startsWith('COURS#') || s === `DOC#${DOC}`)).toEqual([]); // revExtract n'ecrit ni cours ni fiche
    expect((await job(k, b.revisionId)).state).toBe('verification'); // ni rejete ni echec
  });
});

describe('echec: tout ou rien', () => {
  for (const stop of ['prepare', 'extract', 'verify', 'generate'] as const) {
    it(`plantage apres ${stop}: cours, fiche, affirmations, questions identiques octet pour octet, verrou libere, copie supprimee`, async () => {
      const k = await setup();
      const before = snapshot(k.db);
      const b = bodyOf(await create(k.ctx, correction));
      await runMachine(k.ctx, b.revisionId, { stopAfter: stop });
      await revFail(k.ctx, ids(b.revisionId));
      expect(snapshot(k.db)).toBe(before);
      const j = await job(k, b.revisionId);
      expect(j.state).toBe('echec');
      expect(j.restoredAt).toBeDefined();
      expect((await head(k))?.appendJobId).toBeUndefined();
      expect([...k.db.items.keys()].filter((x) => x.startsWith(`DOC#${b.revisionId}`) || x.startsWith(`JOB#${b.revisionId}`))).toEqual([]);
      expect((await k.db.get(keys.revMonth('s1', '2026-12')))?.coutMicros).toBe((j.coutMicros as number) ?? 0); // reserve reglee au cout reel
    });
  }
  it('un modele illisible a la generation: rien ne change', async () => {
    const k = await setup({ generation: 'pas du json' });
    const before = snapshot(k.db);
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId);
    expect(snapshot(k.db)).toBe(before);
    expect((await job(k, b.revisionId)).state).toBe('echec');
  });
  it('plafond de 0,10 EUR atteint: la modification s\'arrete, le cours reste intact', async () => {
    const k = await setup();
    const before = snapshot(k.db);
    const b = bodyOf(await create(k.ctx, correction));
    await k.db.update(keys.job('s1', b.revisionId), { set: { coutMicros: 100_000 } });
    await runMachine(k.ctx, b.revisionId);
    expect(snapshot(k.db)).toBe(before);
    expect((await job(k, b.revisionId)).state).toBe('echec');
  });
});

describe('validation: reprise apres plantage', () => {
  /** Plante `rev-commit` apres la n-ieme ecriture (put/update/transact/remove) puis rejoue par `rev-fail`; l'etat final doit etre celui d'une validation sans panne. */
  async function crashAt(n: number) {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId, { stopAfter: 'generate' });
    let count = 0;
    const boom = (): void => {
      if (++count > n) throw new Error('plantage');
    };
    const db = k.ctx.db;
    const wrapped = { ...db, put: async (...a: Parameters<typeof db.put>) => { boom(); return db.put(...a); }, update: async (...a: Parameters<typeof db.update>) => { boom(); return db.update(...a); }, transact: async (...a: Parameters<typeof db.transact>) => { boom(); return db.transact(...a); }, remove: async (...a: Parameters<typeof db.remove>) => { boom(); return db.remove(...a); } };
    await revCommit({ ...k.ctx, db: wrapped as typeof db }, ids(b.revisionId)).catch(() => undefined);
    return { k, b, crashed: count > n };
  }
  const clean = async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId);
    return { k, b };
  };
  it('plantage apres chaque ecriture: la reprise (rev-fail) donne l\'etat final correct, jamais « finie » sur la seule foi de rev', async () => {
    const ref = await clean();
    const expected = JSON.stringify([...ref.k.db.items.values()].filter((i) => /^(COURS#|DOC#)/.test(i.SK) || i.PK === `DOC#${DOC}`).map((i) => ({ ...i, ttl: undefined })).sort((a, b) => `${a.PK}${a.SK}`.localeCompare(`${b.PK}${b.SK}`)).map(strip));
    for (let n = 0; n < 40; n++) {
      const { k, b, crashed } = await crashAt(n);
      if (!crashed) break;
      const ctxReplay = k.ctx;
      const started = (await job(k, b.revisionId)).commitStartedAt !== undefined;
      await revFail(ctxReplay, ids(b.revisionId));
      const j = await job(k, b.revisionId);
      if (!started) {
        // rien de visible n'avait ete ecrit: la modification est annulee, tout est intact
        expect(j.state).toBe('echec');
        expect((await head(k))?.appendJobId).toBeUndefined();
        continue;
      }
      expect(j.state, `apres ${n} ecritures`).toBe('termine');
      const got = JSON.stringify([...k.db.items.values()].filter((i) => /^(COURS#|DOC#)/.test(i.SK) || i.PK === `DOC#${DOC}`).map((i) => ({ ...i, ttl: undefined })).sort((a, b2) => `${a.PK}${a.SK}`.localeCompare(`${b2.PK}${b2.SK}`)).map(strip));
      // mêmes elements apres reprise qu'une validation sans panne (les identifiants de revision different: comparaison hors job)
      const g1 = normalize(got, b.revisionId), e1 = normalize(expected, ref.b.revisionId);
      expect(g1, `apres ${n} ecritures`).toBe(e1);
      expect((await head(k))?.appendJobId).toBeUndefined();
      expect((await k.db.get(keys.doc('s1', DOC)))?.rev).toBe(1); // 1 seule fois, meme rejoue
    }
  });
  it('rev ecrit AVANT le texte du cours (mutation de l\'ordre) serait detecte: rev absent tant que committedAt est absent', async () => {
    const { k, b } = await crashAt(8);
    const j = await job(k, b.revisionId);
    if (j.committedAt === undefined) expect((await k.db.get(keys.doc('s1', DOC)))?.rev).toBeUndefined();
  });
  it('rejeu apres l\'etape 4: le texte n\'est jamais reapplique deux fois (une phrase ajoutee n\'est pas dupliquee)', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, { added: [{ key: 'n1', afterId: 'p1-s3', text: 'Une phrase ajoutee par l eleve sur le cours.' }] }));
    await runMachine(k.ctx, b.revisionId);
    await revFail(k.ctx, ids(b.revisionId));
    await revCommit(k.ctx, ids(b.revisionId));
    expect(((await k.db.get(keys.coursText('s1', COURS, 1)))?.sentences as unknown[]).length).toBe(9);
  });
  it('si le rejeu echoue encore: job echec SANS restoredAt, copie et verrou gardes, le cours n\'est pas annule', async () => {
    const { k, b } = await crashAt(8);
    const db = k.ctx.db;
    const dead = { ...db, put: async () => { throw new Error('panne'); }, update: async (...a: Parameters<typeof db.update>) => { if (JSON.stringify(a[1]).includes('state')) return db.update(...a); throw new Error('panne'); }, transact: async () => { throw new Error('panne'); } };
    await revFail({ ...k.ctx, db: dead as typeof db }, ids(b.revisionId));
    const j = await job(k, b.revisionId);
    expect(j.state).toBe('echec');
    expect(j.restoredAt).toBeUndefined();
    expect((await head(k))?.appendJobId).toBe(b.revisionId); // verrou garde
    expect((await k.db.query(`DOC#${b.revisionId}-0`)).length).toBeGreaterThan(0); // copie gardee
    // un job echec non restaure ne libere pas le verrou (reclaimLock) et ne laisse pas creer une autre modification
    expect((await create(k.ctx, correction)).statusCode).toBe(409);
    expect(await reclaimLock(k.ctx, 's1', (await head(k))!)).toBe(false);
  });
});
const COURSE_IDS = Array.from({ length: 8 }, (_, n) => `p1-s${n + 1}`);
const strip = (i: Record<string, unknown>) => { const { ttl: _t, restoredAt: _r, ...o } = i; void _t; void _r; return o; };
const normalize = (s: string, id: string) => s.split(id).join('REV');

describe('annulation', () => {
  it('avant la validation: 204, verrou libere, la machine s\'arrete et rev-fail nettoie; apres: 409', async () => {
    const k = await setup();
    const before = snapshot(k.db);
    const b = bodyOf(await create(k.ctx, correction));
    expect((await cancel(k.ctx, b.revisionId)).statusCode).toBe(204);
    expect((await head(k))?.appendJobId).toBeUndefined();
    await runMachine(k.ctx, b.revisionId); // la tache suivante voit l'annulation
    expect(snapshot(k.db)).toBe(before);
    expect((await job(k, b.revisionId)).state).toBe('rejete');
    expect((await job(k, b.revisionId)).restoredAt).toBeDefined();
    expect((await cancel(k.ctx, b.revisionId)).statusCode).toBe(409);
  });
  it('apres commitStartedAt: 409 etat_invalide', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await k.db.update(keys.job('s1', b.revisionId), { set: { commitStartedAt: 'x' } });
    const r = await cancel(k.ctx, b.revisionId);
    expect(r.statusCode).toBe(409);
    expect((await head(k))?.appendJobId).toBe(b.revisionId);
  });
  it('isolation: revisionId d\'un autre eleve, d\'un autre cours ou inconnu: meme 404', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    const mine = bodyOf(await get(k.ctx, 'inconnu'));
    await k.db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s3', cognitoSub: 'sub-s3', statut: 'actif' });
    const theirs = await get(k.ctx, b.revisionId, { sub: 'sub-s3' });
    expect(theirs.statusCode).toBe(404);
    expect(bodyOf(theirs)).toEqual(mine);
    expect((await guarded((await import('./get.js')).reviseGet)(k.ctx, event({ params: { coursId: 'autre', revisionId: b.revisionId } }))).statusCode).toBe(404);
    expect((await guarded((await import('./get.js')).reviseGet)(k.ctx, parent({ params: { coursId: COURS, revisionId: b.revisionId } }))).statusCode).toBe(403);
  });
});

describe('verrou et suppression', () => {
  it('pendant une modification: ajout de pages, suppression du cours et suppression d\'une fiche touchee = 409 sans ecriture', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    const snap = JSON.stringify([...k.db.items.entries()]);
    const del = await guarded(coursApi)(k.ctx, { ...event({ params: { coursId: COURS } }), routeKey: 'DELETE /cours/{coursId}', queryStringParameters: { fiches: 'supprimer' } });
    expect(del.statusCode).toBe(409);
    const dd = await guarded(docsDelete)(k.ctx, event({ params: { docId: DOC } }));
    expect(dd.statusCode).toBe(409);
    const sc = await guarded((await import('../pipeline/api.js')).scansCreate)(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg', coursId: COURS } }));
    expect(sc.statusCode).toBe(409);
    expect(JSON.stringify([...k.db.items.entries()])).toBe(snap);
    expect(b.revisionId).toBeDefined();
  });
  it('une modification bloquee (echec sans restoredAt): DELETE /cours supprime la copie, leve le verrou et le cours', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId, { stopAfter: 'generate' });
    await k.db.update(keys.job('s1', b.revisionId), { set: { state: 'echec', commitStartedAt: 'x' } });
    const del = await guarded(coursApi)(k.ctx, { ...event({ params: { coursId: COURS } }), routeKey: 'DELETE /cours/{coursId}', queryStringParameters: { fiches: 'supprimer' } });
    expect(del.statusCode).toBe(204);
    expect([...k.db.items.keys()].filter((x) => x.startsWith(`DOC#${b.revisionId}`))).toEqual([]);
    expect(await head(k)).toBeUndefined();
  });
  it('GET /cours montre la modification ouverte (banniere), puis plus rien', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    const g = async () => bodyOf(await guarded(coursApi)(k.ctx, { ...event({ params: { coursId: COURS } }), routeKey: 'GET /cours/{coursId}' }));
    expect((await g()).revision).toEqual({ revisionId: b.revisionId, etat: 'en_cours' });
    await runMachine(k.ctx, b.revisionId);
    expect((await g()).revision).toBeUndefined();
  });
  it('suppression de l\'eleve avec une modification ouverte: plus aucune partition DOC#<revisionId>-<k> ni JOB#<revisionId>', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    await runMachine(k.ctx, b.revisionId, { stopAfter: 'generate' });
    const n = [...k.db.items.keys()].filter((x) => x.startsWith(`DOC#${b.revisionId}`) || x.startsWith(`JOB#${b.revisionId}`)).length;
    expect(n).toBeGreaterThan(0);
    await deleteStudentTree(treeDbFrom(k.ctx.db), 'f1', 's1');
    expect([...k.db.items.keys()].filter((x) => x.includes(b.revisionId))).toEqual([]);
  });
  it('deleteStudentTree (memoire): les docIds du job qui ne sont pas des copies de travail ne suppriment rien d\'autre', async () => {
    const tree = memoryTreeDb([{ PK: 'FAMILY#f', SK: 'STUDENT#s' }, { PK: 'STUDENT#s', SK: 'JOB#J1', docIds: ['J1-0', 'AUTRE'] }, { PK: 'DOC#J1-0', SK: 'CLAIM#01' }, { PK: 'DOC#AUTRE', SK: 'CLAIM#01' }]);
    await deleteStudentTree(tree, 'f', 's');
    expect(tree.keys().map((k) => k.PK)).toEqual(['DOC#AUTRE']);
  });
  it('reclaimLock: un job de modification n\'est repris que termine, ou final ET restaure (jamais restaure par ce chemin)', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    const h = async () => (await head(k))!;
    expect(await reclaimLock(k.ctx, 's1', await h())).toBe(false); // ouverte
    await k.db.update(keys.job('s1', b.revisionId), { set: { state: 'echec' } });
    expect(await reclaimLock(k.ctx, 's1', await h())).toBe(false); // echec non restaure: le verrou reste
    expect((await h()).appendJobId).toBe(b.revisionId);
    await k.db.update(keys.job('s1', b.revisionId), { set: { restoredAt: 'x' } });
    expect(await reclaimLock(k.ctx, 's1', await h())).toBe(true);
    expect((await h()).appendJobId).toBeUndefined();
  });
});

describe('une modification n\'est jamais un scan', () => {
  it('failJob, endWithoutDoc, purgeScan, expire, jobs-cancel, jobs-confirm et scans-delete ne la touchent pas', async () => {
    const k = await setup();
    const b = bodyOf(await create(k.ctx, correction));
    const snap = JSON.stringify([...k.db.items.entries()]);
    const j = await job(k, b.revisionId);
    await failJob(k.ctx, { jobId: b.revisionId, sid: 's1' });
    expect(await endWithoutDoc(k.ctx, 's1', b.revisionId, ['verification'], 'echec', 'x')).toBe(false);
    await purgeScan(k.ctx, 's1', b.revisionId, j);
    await expire(k.ctx, { jobId: b.revisionId, sid: 's1', phase: 'confirm' });
    for (const [h, ev] of [[jobsCancel, event({ params: { jobId: b.revisionId } })], [jobsConfirm, event({ params: { jobId: b.revisionId }, body: { corrections: [] } })], [scansDelete, event({ params: { scanId: b.revisionId } })]] as const) {
      expect((await guarded(h)(k.ctx, ev)).statusCode).toBe(404);
    }
    expect(JSON.stringify([...k.db.items.entries()])).toBe(snap);
    const list = await guarded((await import('../scans/list.js')).scansList)(k.ctx, event({}));
    expect(list.body).not.toContain(b.revisionId);
  });
});
