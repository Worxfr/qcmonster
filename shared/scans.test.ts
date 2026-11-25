import { describe, expect, it } from 'vitest';
import { CONFIRM_TIMEOUT_S, EXPIRES_SOON_S, BadCursorError, cleanFolderName, cleanTopic, labelKey, listScans, statusOfJob, stageOf, UnknownFolderError, type ScanItem, type ScanQuery } from './scans.js';
import { FicheItemSchema, FolderItemSchema, JobItemSchema } from './items.js';
import { keys } from './ddb/keys.js';
import { jobCapEur } from './names.js';
import { planSections } from './scans.js';
import { CoursItemSchema, CoursTextItemSchema } from './items.js';
import { deleteStudentTree, type TreeDb, type TreeKey } from './delete-tree.js';

const S1 = 's1';
const job = (id: string, o: Record<string, unknown> = {}): ScanItem => ({ PK: `STUDENT#${S1}`, SK: `JOB#${id}`, state: 'en_attente_envoi', pages: 1, createdAt: '2026-12-01T10:00:00Z', ...o });
const doc = (id: string, o: Record<string, unknown> = {}): ScanItem => ({ PK: `STUDENT#${S1}`, SK: `DOC#${id}`, titre: 'Cours', matiere: 'svt', pagesConsommees: 1, createdAt: '2026-12-01T10:03:00Z', ...o });
const run = (jobs: ScanItem[], docs: ScanItem[], query: ScanQuery = {}, folders: { studentId: string; folderId: string }[] = []) => listScans({ jobs, docs, folders, query });

describe('libelles', () => {
  it('labelKey ignore casse, accents et espaces', () => expect(labelKey('  La  Révolution FRANÇAISE ')).toBe('la revolution francaise'));
  it('cleanTopic retire chevrons et controles, borne a 80, vide => undefined', () => {
    expect(cleanTopic('<b>Cellule</b>\n')).toBe('b Cellule /b');
    expect(cleanTopic('x'.repeat(200))?.length).toBe(80);
    expect(cleanTopic('   ')).toBeUndefined();
    expect(cleanTopic(42)).toBeUndefined();
    expect(cleanFolderName('  Brevet ')).toBe('Brevet');
  });
});

describe('statut', () => {
  it('correspondance etat -> etape', () => {
    const m = { en_attente_envoi: 'envoi', verification_fichier: 'lecture', transcription: 'lecture', a_confirmer: 'a_confirmer', verification: 'verification', generation: 'qcm', termine: 'termine', rejete: 'echec', echec: 'echec', expire: 'echec' };
    for (const [state, stage] of Object.entries(m)) expect(stageOf({ state })).toBe(stage);
    expect(stageOf({ state: 'verification', stage: 'fiche' })).toBe('fiche');
    expect(stageOf({ state: 'generation', stage: 'fiche' })).toBe('qcm'); // etape fine incoherente ignoree
  });
  it('pages recues pendant l\'envoi, pages lues pendant la lecture, borne au total', () => {
    expect(statusOfJob(job('a', { pages: 3, uploadedKeys: ['k0', 'k1'] }))).toMatchObject({ stage: 'envoi', pagesDone: 2, pagesTotal: 3 });
    expect(statusOfJob(job('a', { pages: 3, state: 'transcription', readPages: [1] }))).toMatchObject({ stage: 'lecture', pagesDone: 1 });
    expect(statusOfJob(job('a', { pages: 3, state: 'transcription', readPages: [1, 1, 1, 2] })).pagesDone).toBe(2); // une page lue deux fois ne compte qu'une fois
    expect(statusOfJob(job('a', { pages: 2, state: 'transcription', readPages: [1, 2, 3] })).pagesDone).toBe(2); // borne au total
    expect(statusOfJob(job('a', { pages: 3, state: 'generation' })).pagesDone).toBe(3);
  });
  it('echec: message lisible, avec repli si le job n\'en porte pas', () => {
    expect(statusOfJob(job('a', { state: 'rejete', message: 'Le texte est trop court', finishedAt: '2026-12-01T10:01:00Z' }))).toMatchObject({ stage: 'echec', message: 'Le texte est trop court', finishedAt: '2026-12-01T10:01:00Z' });
    expect(statusOfJob(job('a', { state: 'echec' })).message).toMatch(/échoué/);
  });
});

describe('liste: entrees voisines du meme code', () => {
  it('scan a 1 page existant (job 1.2, sans champ 1.3) et fiche ancienne sans sujet, dossier ni pages', () => {
    const r = run([job('j1', { state: 'termine', docId: 'd1', finishedAt: '2026-12-01T10:03:00Z' })], [doc('d1', { jobId: 'j1', pagesConsommees: 0 })]);
    expect(r.items).toHaveLength(1);
    expect(r.items[0]).toMatchObject({ scanId: 'j1', docId: 'd1', subject: 'svt', pages: 1, status: { stage: 'termine' } });
    expect(r.items[0].topic).toBeUndefined();
    expect(r.items[0].folderId).toBeUndefined();
  });
  it('fiche dont le job a expire (TTL): reste listee, scanId = jobId ou docId', () => {
    const r = run([], [doc('d1', { jobId: 'j1', pages: 3 }), doc('d2')]);
    expect(r.items.map((i) => [i.scanId, i.pages]).sort()).toEqual([['d2', 1], ['j1', 3]]);
  });
  it('job termine dont la fiche a ete supprimee: pas de fantome', () => {
    expect(run([job('j1', { state: 'termine', docId: 'd1' })], []).items).toEqual([]);
  });
  it('job en cours sans matiere ni sujet: liste, filtre subject=none, propose la matiere suggeree', () => {
    const jobs = [job('j1', { state: 'transcription' }), job('j2', { state: 'a_confirmer', suggestedSubject: 'maths', suggestedTopic: 'Fractions' })];
    expect(run(jobs, [], { subject: 'none' }).items.map((i) => i.scanId)).toEqual(['j1']);
    expect(run(jobs, [], { subject: 'maths' }).items[0]).toMatchObject({ scanId: 'j2', topic: 'Fractions' });
    expect(run(jobs, []).inProgress).toBe(2);
  });
  it('le choix de l\'eleve prime sur la suggestion', () => {
    const r = run([job('j', { state: 'verification', suggestedSubject: 'maths', subjectChoice: 'physique', topicChoice: 'Forces' })], []);
    expect(r.items[0]).toMatchObject({ subject: 'physique', topic: 'Forces', status: { stage: 'verification' } });
  });
  it('dossier vide: connu, filtre renvoie une liste vide (pas une erreur)', () => {
    const r = run([], [doc('d1')], { folderId: 'f1' }, [{ studentId: S1, folderId: 'f1' }]);
    expect(r.items).toEqual([]);
  });
  it('dossier d\'un autre eleve ou inconnu: 404 (UnknownFolderError), meme si la fiche le cite', () => {
    expect(() => run([], [doc('d1', { dossierId: 'fx' })], { folderId: 'fx' })).toThrow(UnknownFolderError);
  });
  it('fiche qui cite un dossier supprime ou etranger: traitee comme hors dossier', () => {
    const r = run([], [doc('d1', { dossierId: 'gone' })], { folderId: 'none' });
    expect(r.items).toHaveLength(1);
    expect(r.items[0].folderId).toBeUndefined();
  });
  it('un dossier de l\'eleve s2 ne range pas la fiche de s1 (cle eleve/dossier)', () => {
    const r = run([], [doc('d1', { dossierId: 'f1' })], {}, [{ studentId: 's2', folderId: 'f1' }]);
    expect(r.items[0].folderId).toBeUndefined();
  });
  it('parent: plusieurs eleves, studentId porte par chaque scan', () => {
    const other = { ...doc('d9'), PK: 'STUDENT#s2' };
    const r = run([], [doc('d1'), other]);
    expect(r.items.map((i) => i.studentId).sort()).toEqual(['s1', 's2']);
  });
});

describe('liste: filtres, tris, pages, menus', () => {
  const docs = [
    doc('d1', { titre: 'A', matiere: 'histoire_geo', sujet: 'La Révolution', createdAt: '2026-12-01T10:00:00Z', dossierId: 'f1' }),
    doc('d2', { titre: 'B', matiere: 'maths', sujet: 'fractions', createdAt: '2026-12-02T10:00:00Z' }),
    doc('d3', { titre: 'C', matiere: 'histoire_geo', sujet: 'la revolution', createdAt: '2026-12-03T10:00:00Z', dossierId: 'f1' }),
    doc('d4', { titre: 'D', matiere: 'histoire_geo', createdAt: '2026-12-04T10:00:00Z' }),
  ];
  const folders = [{ studentId: S1, folderId: 'f1' }];
  it('date decroissante par defaut, croissante avec order=asc', () => {
    expect(run([], docs).items.map((i) => i.docId)).toEqual(['d4', 'd3', 'd2', 'd1']);
    expect(run([], docs, { order: 'asc' }).items.map((i) => i.docId)).toEqual(['d1', 'd2', 'd3', 'd4']);
  });
  it('tri par sujet: sujets egaux sans casse ni accents regroupes, absents en dernier', () => {
    expect(run([], docs, { sort: 'topic', order: 'asc' }).items.map((i) => i.docId)).toEqual(['d2', 'd3', 'd1', 'd4']);
    expect(run([], docs, { sort: 'topic', order: 'desc' }).items.map((i) => i.docId).slice(-1)).toEqual(['d4']);
  });
  it('tri par matiere puis sujet', () => {
    expect(run([], docs, { sort: 'subject', order: 'asc' }).items.map((i) => i.docId)).toEqual(['d2', 'd3', 'd1', 'd4']);
  });
  it('filtres combines (ET) et sujet sans casse ni accents', () => {
    expect(run([], docs, { subject: 'histoire_geo', topic: 'LA REVOLUTION', folderId: 'f1' }, folders).items.map((i) => i.docId)).toEqual(['d3', 'd1']);
    expect(run([], docs, { folderId: 'none' }, folders).items.map((i) => i.docId)).toEqual(['d4', 'd2']);
  });
  it('filtre de statut', () => {
    const jobs = [job('j1', { state: 'a_confirmer' }), job('j2', { state: 'echec' }), job('j3', { state: 'transcription' })];
    expect(run(jobs, [], { status: 'en_cours' }).items.map((i) => i.scanId).sort()).toEqual(['j1', 'j3']);
    expect(run(jobs, [], { status: 'a_confirmer' }).items.map((i) => i.scanId)).toEqual(['j1']);
    expect(run(jobs, [], { status: 'echec' }).items.map((i) => i.scanId)).toEqual(['j2']);
    expect(run(jobs, [], { sort: 'status', order: 'asc' }).items.map((i) => i.scanId)).toEqual(['j3', 'j1', 'j2']);
  });
  it('menus: calcules sans les filtres, un libelle par sujet normalise', () => {
    const r = run([], docs, { subject: 'maths' }, folders);
    expect(r.items).toHaveLength(1);
    expect(r.facets.subjects).toEqual([{ subject: 'maths', count: 1 }, { subject: 'histoire_geo', count: 3 }]);
    expect(r.facets.topics.find((t) => labelKey(t.topic) === 'la revolution')?.count).toBe(2);
  });
  it('pagination par curseur, curseur invalide refuse', () => {
    const p1 = run([], docs, { limit: 3 });
    expect(p1.items).toHaveLength(3);
    expect(p1.nextCursor).toBeDefined();
    const p2 = run([], docs, { limit: 3, cursor: p1.nextCursor });
    expect(p2.items.map((i) => i.docId)).toEqual(['d1']);
    expect(p2.nextCursor).toBeUndefined();
    expect(() => run([], docs, { cursor: '!!' })).toThrow(BadCursorError);
  });
  it('aucun texte de cours dans la liste (titre et sujet bornes seulement)', () => {
    const r = run([], [doc('d1', { resume: 'RESUME SECRET', empreinteMinHash: [1] })]);
    expect(JSON.stringify(r)).not.toMatch(/SECRET|empreinte/);
  });
});

describe('elements DynamoDB 1.3', () => {
  it('un job et une fiche sans champ 1.3 restent valides', () => {
    const j = { PK: 'STUDENT#s', SK: 'JOB#j', familyId: 'f', state: 'termine', pages: 1, createdAt: 'x', ttl: 1 };
    expect(JobItemSchema.safeParse(j).success).toBe(true);
    expect(JobItemSchema.safeParse({ ...j, pages: 3, stage: 'fiche', readPages: [1, 2], contentTypes: ['image/jpeg', 'image/png', 'image/png'], folderId: 'f1' }).success).toBe(true);
    expect(JobItemSchema.safeParse({ ...j, stage: 'qcm' }).success).toBe(false);
    const f = { PK: 'STUDENT#s', SK: 'DOC#d', titre: 'T', matiere: 'svt', empreinteMinHash: Array(64).fill(1), pagesConsommees: 0, createdAt: 'x' };
    expect(FicheItemSchema.safeParse(f).success).toBe(true);
    expect(FicheItemSchema.safeParse({ ...f, sujet: 'Cellule', dossierId: 'f1', pages: 2 }).success).toBe(true);
  });
  it('dossier: cle dans la partition de l\'eleve, supprime avec lui', async () => {
    expect(keys.folder('s1', 'f1')).toEqual({ PK: 'STUDENT#s1', SK: 'FOLDER#f1' });
    expect(FolderItemSchema.safeParse({ ...keys.folder('s1', 'f1'), nom: 'Brevet', nomCle: 'brevet', createdAt: 'x' }).success).toBe(true);
    const store: TreeKey[] = [{ PK: 'FAMILY#fam', SK: 'STUDENT#s1' }, { PK: 'STUDENT#s1', SK: 'FOLDER#f1' }, { PK: 'STUDENT#s1', SK: 'DOC#d1' }, { PK: 'STUDENT#s2', SK: 'FOLDER#f9' }];
    const db: TreeDb = {
      list: async (pk, p) => store.filter((k) => k.PK === pk && (!p || k.SK.startsWith(p))),
      remove: async (ks) => void ks.forEach((k) => store.splice(store.findIndex((x) => x.PK === k.PK && x.SK === k.SK), 1)),
    };
    await deleteStudentTree(db, 'fam', 's1');
    expect(store).toEqual([{ PK: 'STUDENT#s2', SK: 'FOLDER#f9' }]);
  });
});

describe('scans a relire: echeance de confirmation', () => {
  const NOW = new Date('2026-12-01T12:00:00Z');
  const at = (h: number) => new Date(NOW.getTime() + h * 3600_000).toISOString();
  const waiting = (id: string, exp?: string, o: Record<string, unknown> = {}) => job(id, { state: 'a_confirmer', ...(exp ? { confirmExpiresAt: exp } : {}), ...o });
  it('delai de 12 h: dans la promesse « 1 jour au plus » avec 20 min d\'envoi et 5 min de lecture', () => {
    expect(CONFIRM_TIMEOUT_S).toBe(12 * 3600);
    expect(20 * 60 + 5 * 60 + CONFIRM_TIMEOUT_S).toBeLessThan(24 * 3600);
    expect(EXPIRES_SOON_S).toBe(2 * 3600);
  });
  it('expiresAt et expiresSoon seulement a a_confirmer', () => {
    expect(statusOfJob(waiting('a', at(10)), NOW)).toMatchObject({ stage: 'a_confirmer', expiresAt: at(10), expiresSoon: false });
    expect(statusOfJob(waiting('a', at(2)), NOW).expiresSoon).toBe(true); // pile 2 h: bientot
    expect(statusOfJob(waiting('a', at(-1)), NOW).expiresSoon).toBe(true); // echeance passee, l'etat n'a pas encore change
    const other = statusOfJob(job('b', { state: 'transcription', confirmExpiresAt: at(1) }), NOW);
    expect(other.expiresAt).toBeUndefined();
    expect(other.expiresSoon).toBeUndefined();
  });
  it('scan a_confirmer d\'avant 1.3 (sans confirmExpiresAt): listé, sans echeance affichee', () => {
    expect(statusOfJob(waiting('old'), NOW).expiresAt).toBeUndefined();
  });
  it('liste: toReview compte les a_confirmer, le plus ancien en premier avec status + order=asc', () => {
    const jobs = [waiting('j2', at(5), { createdAt: '2026-12-01T09:00:00Z' }), waiting('j1', at(1), { createdAt: '2026-12-01T01:00:00Z' }), job('j3', { state: 'transcription' }), job('j4', { state: 'echec' })];
    const r = listScans({ jobs, docs: [], folders: [], query: { status: 'a_confirmer', sort: 'date', order: 'asc' }, now: NOW });
    expect(r.items.map((i) => i.scanId)).toEqual(['j1', 'j2']);
    expect(r.items[0].status.expiresSoon).toBe(true);
    expect(r.items[1].status.expiresSoon).toBe(false);
    expect(r.toReview).toBe(2);
    expect(r.inProgress).toBe(3);
  });
  it('apres expiration: echec avec message, plus a relire', () => {
    const r = listScans({ jobs: [job('j', { state: 'expire', message: 'Pas de confirmation apres 12 heures, la photo est supprimee' })], docs: [], folders: [], query: {}, now: NOW });
    expect(r.toReview).toBe(0);
    expect(r.items[0].status).toMatchObject({ stage: 'echec', message: expect.stringMatching(/12 heures/) });
  });
});

describe('revue PR 40', () => {
  it('cleanLabel retire controles C1, marques bidirectionnelles et invisibles', () => {
    expect(cleanTopic('a\u0085b\u200bc\u202ed\u2066e\ufefff')).toBe('a b c d e f');
    expect(cleanTopic('\u200b\u202e \ufeff <>')).toBeUndefined();
    expect(cleanFolderName('\u202eBrevet\u202c')).toBe('Brevet');
  });
  it('ScanSummary.state distingue annule (rejete), echec, expire; fiche = termine', () => {
    const jobs = [job('a', { state: 'rejete', message: 'Annule par l\'eleve' }), job('b', { state: 'echec' }), job('c', { state: 'expire' }), job('d', { state: 'bizarre' })];
    const r = run(jobs, [doc('x')]);
    const by = Object.fromEntries(r.items.map((i) => [i.scanId, i.state]));
    expect(by).toMatchObject({ a: 'rejete', b: 'echec', c: 'expire', d: 'echec', x: 'termine' });
  });
  it('sens par defaut: croissant pour matiere et sujet, decroissant pour date', () => {
    const docs = [doc('d1', { matiere: 'svt', sujet: 'b', createdAt: '2026-12-01T10:00:00Z' }), doc('d2', { matiere: 'maths', sujet: 'a', createdAt: '2026-12-02T10:00:00Z' }), doc('d3', { matiere: 'autre', sujet: 'c', createdAt: '2026-12-03T10:00:00Z' })];
    expect(run([], docs, { sort: 'subject' }).items.map((i) => i.docId)).toEqual(['d2', 'd1', 'd3']);
    expect(run([], docs, { sort: 'topic' }).items.map((i) => i.docId)).toEqual(['d2', 'd1', 'd3']);
    expect(run([], docs, { sort: 'date' }).items.map((i) => i.docId)).toEqual(['d3', 'd2', 'd1']);
  });
  it('meme docId dans deux partitions (parent): ni fusion ni perte', () => {
    const a = doc('same', { titre: 'A' });
    const b = { ...doc('same', { titre: 'B' }), PK: 'STUDENT#s2' };
    const jobB = { ...job('jb', { state: 'termine', docId: 'same' }), PK: 'STUDENT#s2' };
    const r = run([jobB], [a, b]);
    expect(r.items.map((i) => `${i.studentId}:${i.title}`).sort()).toEqual(['s1:A', 's2:B']);
  });
  it('curseur avec caracteres en trop refuse', () => {
    const p1 = run([], [doc('d1'), doc('d2')], { limit: 1 });
    expect(() => run([], [doc('d1'), doc('d2')], { cursor: `${p1.nextCursor}!` })).toThrow(BadCursorError);
  });
});

describe('plafond de cout par traitement', () => {
  it('max(0,25 ; 0,15 x pages), arrondi au centime', () => {
    expect([1, 2, 3, 4, 10].map(jobCapEur)).toEqual([0.25, 0.3, 0.45, 0.6, 1.5]);
  });
  it('pages hors limites ramenees entre 1 et 10', () => {
    expect(jobCapEur(0)).toBe(0.25);
    expect(jobCapEur(-3)).toBe(0.25);
    expect(jobCapEur(99)).toBe(1.5);
    expect(jobCapEur(Number.NaN)).toBe(0.25);
    expect(jobCapEur(2.9)).toBe(0.3);
  });
});

describe('sections: une fiche par sujet', () => {
  const ids = ['p1-s1', 'p1-s2', 'p1-s3', 'p2-s1', 'p2-s2', 'p3-s1'];
  const sec = (id: string, ignore?: boolean) => ({ fromSentenceId: id, ...(ignore ? { ignore } : {}) });
  it('une seule section couvre tout (defaut)', () => {
    expect(planSections(ids, [sec('p1-s1')])).toEqual({ ok: true, ranges: [{ start: 0, end: 6, ignore: false }] });
  });
  it('coupe a cheval sur deux pages: sections [0,3[ [3,5[ [5,6[', () => {
    const r = planSections(ids, [sec('p1-s1'), sec('p2-s1'), sec('p3-s1', true)]);
    expect(r).toEqual({ ok: true, ranges: [{ start: 0, end: 3, ignore: false }, { start: 3, end: 5, ignore: false }, { start: 5, end: 6, ignore: true }] });
  });
  it('coupe au milieu d\'une page', () => {
    expect(planSections(ids, [sec('p1-s1'), sec('p1-s3')])).toMatchObject({ ok: true, ranges: [{ start: 0, end: 2 }, { start: 2, end: 6 }] });
  });
  it('refus: inconnu, ordre, doublon, debut, trop, rien a fiche, vide', () => {
    expect(planSections(ids, [sec('p1-s1'), sec('p9-s9')])).toEqual({ ok: false, error: 'inconnu' });
    expect(planSections(ids, [sec('p1-s1'), sec('p2-s1'), sec('p1-s3')])).toEqual({ ok: false, error: 'ordre' });
    expect(planSections(ids, [sec('p1-s1'), sec('p2-s1'), sec('p2-s1')])).toEqual({ ok: false, error: 'ordre' });
    expect(planSections(ids, [sec('p1-s2')])).toEqual({ ok: false, error: 'debut' });
    expect(planSections(ids, [sec('p1-s1'), sec('p1-s2'), sec('p1-s3'), sec('p2-s1'), sec('p2-s2'), sec('p3-s1'), sec('p3-s1')])).toEqual({ ok: false, error: 'trop' });
    expect(planSections(ids, [sec('p1-s1', true), sec('p2-s1', true)])).toEqual({ ok: false, error: 'aucune_fiche' });
    expect(planSections(ids, [])).toEqual({ ok: false, error: 'aucune_fiche' });
    expect(planSections([], [sec('p1-s1')])).toEqual({ ok: false, error: 'inconnu' });
  });
  it('6 sections au plus: 6 acceptees', () => {
    expect(planSections(ids, ids.map((id) => sec(id))).ok).toBe(true);
  });
});

describe('un scan, plusieurs fiches (liste et cours)', () => {
  const d = (id: string, o: Record<string, unknown>) => doc(id, { jobId: 'j1', coursId: 'c1', sectionCount: 3, ...o });
  const docs = [d('dB', { sectionIndex: 1, matiere: 'histoire_geo', titre: 'B' }), d('dA', { sectionIndex: 0, titre: 'A' }), d('dC', { sectionIndex: 2, titre: 'C', dossierId: 'f1' })];
  it('job termine: une entree par fiche, dans l\'ordre des sections, avec docIds et coursId', () => {
    const r = run([job('j1', { state: 'termine', docIds: ['dA', 'dB', 'dC'], docId: 'dA', coursId: 'c1', pages: 3 })], docs, { order: 'asc' }, [{ studentId: S1, folderId: 'f1' }]);
    expect(r.items.map((i) => i.docId)).toEqual(['dA', 'dB', 'dC']);
    expect(r.items.every((i) => i.scanId === 'j1' && i.sectionCount === 3 && i.coursId === 'c1' && i.state === 'termine')).toBe(true);
    expect(r.items[1].docIds).toEqual(['dA', 'dB', 'dC']);
    expect(r.items.map((i) => i.sectionIndex)).toEqual([0, 1, 2]);
    expect(r.inProgress).toBe(0);
  });
  it('filtres par fiche: chaque fiche a sa matiere, son sujet et son dossier', () => {
    const jobs = [job('j1', { state: 'termine', docIds: ['dA', 'dB', 'dC'] })];
    expect(run(jobs, docs, { subject: 'histoire_geo' }).items.map((i) => i.docId)).toEqual(['dB']);
    expect(run(jobs, docs, { folderId: 'f1' }, [{ studentId: S1, folderId: 'f1' }]).items.map((i) => i.docId)).toEqual(['dC']);
  });
  it('fiches seules (job expire): regroupees par jobId', () => {
    const r = run([], docs);
    expect(r.items).toHaveLength(3);
    expect(new Set(r.items.map((i) => i.scanId))).toEqual(new Set(['j1']));
    expect(r.items[0].docIds).toEqual(['dA', 'dB', 'dC']);
  });
  it('une fiche supprimee: les autres restent, sans fantome', () => {
    const r = run([job('j1', { state: 'termine', docIds: ['dA', 'dB', 'dC'] })], [docs[1], docs[2]]);
    expect(r.items.map((i) => i.docId).sort()).toEqual(['dA', 'dC']);
    expect(run([job('j1', { state: 'termine', docIds: ['dA'] })], []).items).toEqual([]);
  });
  it('job en cours: une seule entree meme avec un plan de sections; fiche ancienne a 1 section sans champs 1.3', () => {
    expect(run([job('j2', { state: 'verification', docIds: ['x', 'y'], coursId: 'c9' })], []).items).toHaveLength(1);
    const old = run([job('j0', { state: 'termine', docId: 'd0' })], [doc('d0', { jobId: 'j0' })]).items[0];
    expect(old.sectionCount).toBeUndefined();
    expect(old.docIds).toBeUndefined();
  });
});

describe('cours conserve', () => {
  it('cles dans la partition de l\'eleve, schemas', () => {
    expect(keys.cours('s1', 'c1')).toEqual({ PK: 'STUDENT#s1', SK: 'COURS#c1' });
    expect(keys.coursText('s1', 'c1', 2)).toEqual({ PK: 'STUDENT#s1', SK: 'COURS#c1#T02' });
    expect(CoursTextItemSchema.safeParse({ ...keys.coursText('s1', 'c1', 1), page: 1, sentences: [{ id: 'p1-s1', text: 'x', pages: [1, 2] }] }).success).toBe(true);
    const head = { ...keys.cours('s1', 'c1'), jobId: 'j', pages: 2, createdAt: 'x', nbPhrases: 3, sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', ignore: false, statut: 'fiche', docId: 'd' }] };
    expect(CoursItemSchema.safeParse(head).success).toBe(true);
    expect(CoursItemSchema.safeParse({ ...head, sections: [] }).success).toBe(false);
  });
  it('suppression d\'un eleve: en-tete et texte du cours supprimes, ceux d\'un autre eleve conserves', async () => {
    const store: TreeKey[] = [{ PK: 'FAMILY#fam', SK: 'STUDENT#s1' }, { PK: 'STUDENT#s1', SK: 'COURS#c1' }, { PK: 'STUDENT#s1', SK: 'COURS#c1#T01' }, { PK: 'STUDENT#s1', SK: 'DOC#d1' }, { PK: 'STUDENT#s2', SK: 'COURS#c9' }];
    const db: TreeDb = { list: async (pk, p) => store.filter((k) => k.PK === pk && (!p || k.SK.startsWith(p))), remove: async (ks) => void ks.forEach((k) => store.splice(store.findIndex((x) => x.PK === k.PK && x.SK === k.SK), 1)) };
    await deleteStudentTree(db, 'fam', 's1');
    expect(store).toEqual([{ PK: 'STUDENT#s2', SK: 'COURS#c9' }]);
  });
});
