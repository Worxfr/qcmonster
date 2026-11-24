import { describe, expect, it } from 'vitest';
import { StudentCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { keys, sha256 } from '../../../shared/ddb/keys.js';
import { postAnswer } from '../game/answers.js';
import { getSession } from '../game/session.js';
import { HttpError, parseBody } from '../lib/http.js';
import { FID, SID, parentCtx, qid, seed, testDeps, type TestEnv } from '../lib/testkit.js';
import { ACTIVATION_TTL_MS, activate, issueActivation } from './activation.js';
import { createFamily, deleteFamily, exportFamily, familyIdFor } from './family.js';
import { validateReport } from './reports.js';
import { createLink, createStudent, deleteStudent, updateStudent } from './students.js';

const rejects = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (code) expect((e as HttpError).code).toBe(code);
};
const tokenOf = (url: string) => url.split('#token=')[1];
const newStudent = (t: TestEnv, ctx = parentCtx) => createStudent(t.deps, ctx, { pseudo: 'Pseudo', schoolLevel: 'seconde', under15: false });

async function family(t: TestEnv) {
  await t.store.commit([{ item: { ...keys.family(FID), plafondPages: 50, ownerSub: 'sub-par1' }, when: 'any' }]);
}
const count = (t: TestEnv) => t.store.items.size;

describe('POST /family', () => {
  const a = { sub: 'sub-new', username: 'new1' };
  it('cree la famille, pose famille_id et le groupe parent; l\'identifiant derive du sub', async () => {
    const t = testDeps();
    const me = await createFamily(t.deps, a);
    expect(me).toEqual({ userId: 'sub-new', role: 'parent', familyId: familyIdFor('sub-new') });
    expect(me.familyId).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(t.identity.users.get('new1')).toMatchObject({ familyId: me.familyId, groups: ['parent'] });
    expect(await t.store.get(keys.family(me.familyId))).toMatchObject({ ownerSub: 'sub-new', plafondPages: 50 });
  });
  it('un second appel (jeton perime) est refuse; une reprise apres echec Cognito reussit', async () => {
    const t = testDeps();
    await createFamily(t.deps, a);
    await rejects(createFamily(t.deps, a), 409, 'etat_invalide');
    const t2 = testDeps();
    await t2.store.commit([{ item: { ...keys.family(familyIdFor('sub-new')), ownerSub: 'sub-new' }, when: 'any' }]); // META ecrite, Cognito avait echoue
    expect((await createFamily(t2.deps, a)).familyId).toBe(familyIdFor('sub-new'));
    const t3 = testDeps();
    await t3.store.commit([{ item: { ...keys.family(familyIdFor('sub-new')), ownerSub: 'quelqu-un-d-autre' }, when: 'any' }]);
    await rejects(createFamily(t3.deps, a), 409);
  });
  it('refuse un eleve, un compte avec famille ou sans nom d\'utilisateur', async () => {
    const t = testDeps();
    await rejects(createFamily(t.deps, { ...a, role: 'eleve', familyId: FID }), 403);
    await rejects(createFamily(t.deps, { ...a, role: 'parent', familyId: FID }), 409);
    await rejects(createFamily(t.deps, { sub: 'x', username: '' }), 409);
  });
  it('deux appels simultanes: une seule famille', async () => {
    const t = testDeps();
    const r = await Promise.allSettled([createFamily(t.deps, a), createFamily(t.deps, a)]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
});

describe('POST /students', () => {
  it('sans la case « autorite parentale », la requete est refusee', () => {
    const body = (parentalAuthority: unknown) => ({ body: JSON.stringify({ pseudo: 'Pseudo', schoolLevel: 'seconde', under15: false, parentalAuthority }) });
    expect(() => parseBody(body(false), StudentCreateRequestSchema)).toThrow(HttpError);
    expect(() => parseBody({ body: JSON.stringify({ pseudo: 'Pseudo', schoolLevel: 'seconde', under15: false }) }, StudentCreateRequestSchema)).toThrow(HttpError);
    expect(parseBody(body(true), StudentCreateRequestSchema).pseudo).toBe('Pseudo');
  });
  it('cree l\'utilisateur Cognito, l\'eleve et un lien a usage unique valable 24 h; seul le hache est stocke', async () => {
    const t = testDeps();
    await family(t);
    const r = await newStudent(t);
    const sid = r.student.studentId;
    expect(r.student).toMatchObject({ status: 'actif', schoolLevel: 'seconde', under15: false, pageQuota: 20 });
    expect(r.student.pseudo).toMatch(/^Pseudo-s\d{3}$/);
    expect(t.identity.users.get(sid)).toMatchObject({ familyId: FID, alias: r.student.pseudo, groups: ['eleve'] });
    const token = tokenOf(r.activationLink.url);
    expect(r.activationLink.url).toBe(`https://front.example.invalid/activer#token=${token}`);
    expect(Date.parse(r.activationLink.expiresAt) - t.clk.now().getTime()).toBe(ACTIVATION_TTL_MS);
    const stored = JSON.stringify([...t.store.items.values()]);
    expect(stored).not.toContain(token); // jamais le jeton en clair
    expect(stored).toContain(sha256(token));
    expect(JSON.stringify(r)).not.toContain('cognitoSub');
    expect(await t.store.get(keys.activation(token))).toMatchObject({ sid, fid: FID, ttl: Math.floor((t.clk.now().getTime() + ACTIVATION_TTL_MS) / 1000) });
  });
  it('un pseudo deja pris recoit un autre suffixe; trop d\'echecs: erreur', async () => {
    const t = testDeps();
    await family(t);
    t.identity.failCreate = 2;
    expect((await newStudent(t)).student.pseudo).toMatch(/^Pseudo-/);
    const t2 = testDeps();
    await family(t2);
    t2.identity.failCreate = 3;
    await expect(newStudent(t2)).rejects.toThrow();
  });
  it('famille inconnue: 403; plafond d\'eleves; erreur Cognito inattendue relancee', async () => {
    const t = testDeps();
    await rejects(newStudent(t), 403);
    await family(t);
    for (let i = 0; i < 10; i++) await t.store.commit([{ item: { ...keys.student(FID, `s${i}`) }, when: 'any' }]);
    await rejects(newStudent(t), 403);
  });
  it('si l\'ecriture echoue, l\'utilisateur Cognito est retire', async () => {
    const t = testDeps();
    await family(t);
    t.store.failNextCommits(1);
    await rejects(newStudent(t), 409);
    expect(t.identity.users.size).toBe(0);
  });
  it('le pseudo est nettoye (espaces) avant le suffixe', async () => {
    const t = testDeps();
    await family(t);
    const r = await createStudent(t.deps, parentCtx, { pseudo: ' Deux  mots ', schoolLevel: 'premiere', under15: true });
    expect(r.student.pseudo).toMatch(/^Deux-mots-s/);
  });
});

describe('POST /activation (publique)', () => {
  async function created() {
    const t = testDeps();
    await family(t);
    const r = await newStudent(t);
    return { t, sid: r.student.studentId, token: tokenOf(r.activationLink.url) };
  }
  const PW = 'Un-mot-de-passe-long-1';
  it('fonctionne une fois, puis le lien est refuse', async () => {
    const { t, sid, token } = await created();
    await activate(t.deps, t.identity, { token, password: PW });
    expect(t.identity.users.get(sid)?.password).toBe(PW);
    await rejects(activate(t.deps, t.identity, { token, password: PW }), 404, 'introuvable');
    expect((await t.store.get(keys.student(FID, sid)))?.activationHash).toBeUndefined();
    expect(await t.store.get(keys.activation(token))).toBeUndefined();
  });
  it('refuse apres 24 h (horloge simulee), meme reponse 404 qu\'un jeton inconnu', async () => {
    const { t, token } = await created();
    t.clk.advance(ACTIVATION_TTL_MS - 1000);
    const expired = async () => {
      t.clk.advance(2000);
      return activate(t.deps, t.identity, { token, password: PW }).then(() => undefined, (e: HttpError) => e);
    };
    const e1 = await expired();
    const e2 = await activate(t.deps, t.identity, { token: 'x'.repeat(40), password: PW }).then(() => undefined, (e: HttpError) => e);
    expect([e1?.status, e1?.code, e1?.message]).toEqual([e2?.status, e2?.code, e2?.message]);
    expect(e1?.status).toBe(404);
  });
  it('juste avant l\'expiration, le lien marche', async () => {
    const { t, token } = await created();
    t.clk.advance(ACTIVATION_TTL_MS - 1000);
    await activate(t.deps, t.identity, { token, password: PW });
  });
  it('mot de passe refuse par la politique: 400 et le lien reste utilisable', async () => {
    const { t, sid, token } = await created();
    t.identity.failPasswordPolicy = true;
    await rejects(activate(t.deps, t.identity, { token, password: 'tropsimple1234' }), 400, 'requete_invalide');
    t.identity.failPasswordPolicy = false;
    await activate(t.deps, t.identity, { token, password: PW });
    expect(t.identity.users.get(sid)?.password).toBe(PW);
  });
  it('erreur Cognito inattendue: relancee, lien libere', async () => {
    const { t, token } = await created();
    t.identity.users.clear(); // setPassword leve « UserNotFound »
    await expect(activate(t.deps, t.identity, { token, password: PW })).rejects.toThrow('UserNotFound');
    expect(await t.store.get(keys.activation(token))).toBeDefined();
  });
  it('un nouveau lien remplace l\'ancien; eleve supprime: 404', async () => {
    const { t, sid, token } = await created();
    const second = tokenOf((await createLink(t.deps, parentCtx, sid)).url);
    await rejects(activate(t.deps, t.identity, { token, password: PW }), 404);
    await activate(t.deps, t.identity, { token: second, password: PW });
    const c = await created();
    const l2 = tokenOf((await createLink(c.t.deps, parentCtx, c.sid)).url);
    await c.t.store.commit([{ item: { ...keys.student(FID, c.sid), activationHash: sha256('autre') }, when: 'any' }]); // jeton remplace sans nettoyage
    await rejects(activate(c.t.deps, c.t.identity, { token: l2, password: PW }), 404);
    const d = await created();
    await d.t.store.remove(keys.student(FID, d.sid));
    await rejects(activate(d.t.deps, d.t.identity, { token: d.token, password: PW }), 404);
  });
  it('deux activations simultanees: une seule reussit', async () => {
    const { t, token } = await created();
    const r = await Promise.allSettled([activate(t.deps, t.identity, { token, password: PW }), activate(t.deps, t.identity, { token, password: PW })]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
  });
  it('element corrompu (hache different): refuse', async () => {
    const { t, token } = await created();
    const it = (await t.store.get(keys.activation(token)))!;
    await t.store.commit([{ item: { ...it, hash: 'zz' }, when: 'any' }]);
    await rejects(activate(t.deps, t.identity, { token, password: PW }), 404);
  });
  it('un jeton ne peut pas etre reclame deux fois (deja marque utilise)', async () => {
    const { t, token } = await created();
    const it = (await t.store.get(keys.activation(token)))!;
    await t.store.commit([{ item: { ...it, usedAt: 'x' }, when: 'any' }]);
    await rejects(activate(t.deps, t.identity, { token, password: PW }), 404);
  });
  it('l\'origine du front est obligatoire', () => {
    const t = testDeps();
    expect(() => issueActivation(t.deps, '', FID, SID)).toThrow('WEB_ORIGIN');
  });
});

describe('students-link, update, delete', () => {
  it('un parent ne touche pas l\'eleve d\'une autre famille (404)', async () => {
    const t = testDeps();
    await family(t);
    const other = await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await rejects(createLink(t.deps, parentCtx, other.sid), 404);
    await rejects(updateStudent(t.deps, parentCtx, other.sid, { status: 'suspendu' }), 404);
    await rejects(deleteStudent(t.deps, parentCtx, other.sid), 404);
    expect(await t.store.get(keys.student('fam2', other.sid))).toBeDefined();
  });
  it('suspension: l\'eleve est refuse par l\'API et son compte Cognito desactive; reactivation', async () => {
    const t = testDeps();
    const s = await seed(t);
    t.identity.users.set(SID, { sub: s.ctx.sub, enabled: true, groups: ['eleve'] });
    const v = await updateStudent(t.deps, parentCtx, SID, { status: 'suspendu' });
    expect(v.status).toBe('suspendu');
    expect(t.identity.users.get(SID)?.enabled).toBe(false);
    await rejects(getSession(t.deps, s.ctx, 'doc1'), 403);
    await updateStudent(t.deps, parentCtx, SID, { status: 'actif' });
    expect(t.identity.users.get(SID)?.enabled).toBe(true);
    await getSession(t.deps, s.ctx, 'doc1');
    // meme statut: Cognito n'est pas rappele
    await updateStudent(t.deps, parentCtx, SID, { status: 'actif' });
  });
  it('quota: limite par le plafond de la famille, applique au quota du mois, relu par le profil', async () => {
    const t = testDeps();
    const s = await seed(t);
    await rejects(updateStudent(t.deps, parentCtx, SID, {}), 400);
    await rejects(updateStudent(t.deps, parentCtx, SID, { pageQuota: 51 }), 400);
    const v = await updateStudent(t.deps, parentCtx, SID, { pageQuota: 30 });
    expect(v.pageQuota).toBe(30);
    const q = (t.quota as unknown as { items: Map<string, Record<string, number>> }).items.get(`FAMILY#${FID}|QUOTA#2026-12#${SID}`);
    expect([q?.limite, q?.restant]).toEqual([30, 30]);
    expect((await t.store.get(keys.student(FID, SID)))?.quotaPages).toBe(30);
    expect(s.sid).toBe(SID);
  });
  it('quota sans element famille: plafond par defaut; conflit: 409', async () => {
    const t = testDeps();
    await seed(t);
    await t.store.remove(keys.family(FID));
    await updateStudent(t.deps, parentCtx, SID, { pageQuota: 40 });
    t.store.failNextCommits(1);
    await rejects(updateStudent(t.deps, parentCtx, SID, { pageQuota: 10 }), 409);
    const t2 = testDeps({ env: 'dev' });
    await seed(t2);
    await t2.store.remove(keys.family(FID));
    expect((await updateStudent(t2.deps, parentCtx, SID, { pageQuota: 40 })).pageQuota).toBe(40);
  });
  it('nouveau lien: conflit = 409', async () => {
    const t = testDeps();
    await seed(t);
    t.store.failNextCommits(1);
    await rejects(createLink(t.deps, parentCtx, SID), 409);
    const l = await createLink(t.deps, parentCtx, SID); // eleve sans ancien lien
    expect(l.url).toContain('#token=');
  });
  it('suppression: tous les elements de l\'eleve, son lien, ses photos en cours et son utilisateur Cognito', async () => {
    const t = testDeps();
    await family(t);
    const r = await newStudent(t);
    const sid = r.student.studentId;
    const ctx = { sub: `sub-${sid}`, studentId: sid, familyId: FID };
    await seed(t, { sid, docId: 'docA' }); // remplace l'element eleve: on y remet le hache du lien
    await t.store.commit([{ item: { ...(await t.store.get(keys.student(FID, sid)))!, activationHash: sha256(tokenOf(r.activationLink.url)) }, when: 'any' }]);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    const put = (item: { PK: string; SK: string; [k: string]: unknown }) => t.store.commit([{ item, when: 'any' }]);
    await put({ ...keys.job(sid, 'job1'), state: 'transcription' });
    await put({ ...keys.text('job1', 1) });
    await put({ ...keys.transcriptions(sid, '2026-12-01') });
    await put({ ...keys.week(FID, '2026-W49', sid) });
    await put({ ...keys.quota(FID, '2026-12', sid) });
    await t.identity.attachFamily(sid, FID);
    await getSession(t.deps, ctx, 'docA');
    await postAnswer(t.deps, ctx, { questionId: qid('docA', 'qcm', 1), choice: 'B' });
    const mine = (k: { PK: string; SK: string }) => k.PK === `STUDENT#${sid}` || k.PK === `DOC#docA` || k.PK === 'JOB#job1' || k.SK === `STUDENT#${sid}` || k.SK.endsWith(`#${sid}`) || k.PK === `ACTIVATION#${sha256(tokenOf(r.activationLink.url))}`;
    const before = [...t.store.items.values()].filter(mine).length;
    const others = [...t.store.items.values()].filter((k) => !mine(k)).length;
    expect(before).toBeGreaterThan(10);
    await deleteStudent(t.deps, parentCtx, sid);
    expect([...t.store.items.values()].filter(mine).map((k) => `${k.PK}|${k.SK}`)).toEqual([]);
    expect([...t.store.items.values()].filter((k) => !mine(k))).toHaveLength(others); // rien d'autre n'est touche
    expect(t.identity.users.has(sid)).toBe(false);
    expect(t.photos.deleted).toEqual(['job1']);
    await rejects(deleteStudent(t.deps, parentCtx, sid), 404);
  });
});

describe('export et suppression de la famille', () => {
  it('export: eleves et fiches de la famille seulement, sans donnee interne', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    const e = await exportFamily(t.deps, parentCtx);
    expect(e.familyId).toBe(FID);
    expect(e.students.map((s) => s.studentId)).toEqual([SID]);
    expect(e.docs).toEqual([{ docId: 'doc1', title: 'Titre', subject: 'svt', createdAt: '2026-12-01T09:00:00.000Z' }]);
    expect(JSON.stringify(e)).not.toContain('cognitoSub');
    const empty = testDeps();
    const e2 = await exportFamily(empty.deps, { ...parentCtx, familyId: 'vide' });
    expect(e2.docs).toEqual([]);
    await t.store.commit([{ item: { ...keys.doc(SID, 'doc3'), GSI1PK: `FAMILY#${FID}`, GSI1SK: 'DOC#x' }, when: 'any' }]);
    expect((await exportFamily(t.deps, parentCtx)).docs.find((d) => d.docId === 'doc3')).toEqual({ docId: 'doc3', title: '', subject: 'autre', createdAt: '' });
  });
  it('suppression complete: elements de la famille, utilisateurs Cognito des eleves et du parent; autre famille intacte', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { fid: 'fam2', sid: 'stu2', docId: 'doc2' });
    await t.store.commit([{ item: { ...keys.report(FID, 'rep1'), docId: 'doc1', commentaire: 'x', statut: 'ouvert', createdAt: 'x' }, when: 'any' }]);
    t.identity.users.set(SID, { sub: 'sub-stu1', enabled: true, groups: ['eleve'] });
    t.identity.users.set('par1', { sub: 'sub-par1', enabled: true, groups: ['parent'] });
    const foreign = [...t.store.items.values()].filter((k) => k.PK.includes('fam2') || k.PK === 'STUDENT#stu2' || k.PK === 'DOC#doc2').length;
    await deleteFamily(t.deps, parentCtx);
    const left = [...t.store.items.values()];
    expect(left.filter((k) => k.PK === `FAMILY#${FID}` || k.PK === `STUDENT#${SID}` || k.PK === 'DOC#doc1')).toHaveLength(0);
    expect(left).toHaveLength(foreign);
    expect(t.identity.users.size).toBe(0);
  });
});

describe('reports-validate', () => {
  async function withReport(t: TestEnv, extra: Record<string, unknown> = {}) {
    const s = await seed(t);
    await t.store.commit([{ item: { ...keys.report(FID, 'rep1'), docId: 'doc1', claimId: '02', commentaire: 'erreur', statut: 'ouvert', createdAt: 'x', ...extra }, when: 'any' }]);
    return s;
  }
  it('valide: 15 XP a l\'eleve, badge chasseur d\'erreurs, une seule fois', async () => {
    const t = testDeps();
    await withReport(t);
    expect(await validateReport(t.deps, parentCtx, 'rep1', 'valide')).toEqual({ reportId: 'rep1', docId: 'doc1', claimId: '02', status: 'valide' });
    const p = await t.store.get(keys.profile(SID));
    expect(p).toMatchObject({ xp: 15, validReports: 1, badges: ['chasseur_d_erreurs'] });
    await rejects(validateReport(t.deps, parentCtx, 'rep1', 'valide'), 409);
    expect((await t.store.get(keys.profile(SID)))?.xp).toBe(15);
  });
  it('studentId ecrit par L2a: utilise s\'il est de la famille, ignore sinon', async () => {
    const t = testDeps();
    await withReport(t, { studentId: SID });
    await validateReport(t.deps, parentCtx, 'rep1', 'valide');
    expect((await t.store.get(keys.profile(SID)))?.xp).toBe(15);
    const t2 = testDeps();
    await withReport(t2, { studentId: 'etranger' });
    await validateReport(t2.deps, parentCtx, 'rep1', 'valide');
    expect((await t2.store.get(keys.profile(SID)))?.xp).toBe(15);
  });
  it('rejete: aucun XP; deja traite: 409', async () => {
    const t = testDeps();
    await withReport(t);
    const r = await validateReport(t.deps, parentCtx, 'rep1', 'rejete');
    expect(r.status).toBe('rejete');
    expect(await t.store.get(keys.profile(SID))).toBeUndefined();
    await rejects(validateReport(t.deps, parentCtx, 'rep1', 'rejete'), 409);
    const t2 = testDeps();
    await withReport(t2);
    t2.store.failNextCommits(1);
    await rejects(validateReport(t2.deps, parentCtx, 'rep1', 'rejete'), 409);
  });
  it('fiche supprimee: valide sans XP; conflit: 409', async () => {
    const t = testDeps();
    await withReport(t, { docId: 'disparue' });
    expect((await validateReport(t.deps, parentCtx, 'rep1', 'valide')).status).toBe('valide');
    expect(await t.store.get(keys.profile(SID))).toBeUndefined();
    const t2 = testDeps();
    await withReport(t2, { docId: 'disparue' });
    t2.store.failNextCommits(1);
    await rejects(validateReport(t2.deps, parentCtx, 'rep1', 'valide'), 409);
    const t3 = testDeps();
    await withReport(t3);
    t3.store.failNextCommits(3);
    await rejects(validateReport(t3.deps, parentCtx, 'rep1', 'valide'), 409);
  });
  it('signalement d\'une autre famille, ou illisible: 404', async () => {
    const t = testDeps();
    await withReport(t);
    await rejects(validateReport(t.deps, { ...parentCtx, familyId: 'fam2' }, 'rep1', 'valide'), 404);
    await t.store.commit([{ item: { ...keys.report(FID, 'rep2'), statut: 'bizarre' }, when: 'any' }]);
    await rejects(validateReport(t.deps, parentCtx, 'rep2', 'valide'), 404);
  });
  it('un signalement traite entre la lecture et l\'ecriture ne paie pas deux fois', async () => {
    const t = testDeps();
    await withReport(t);
    const r = await Promise.allSettled([validateReport(t.deps, parentCtx, 'rep1', 'valide'), validateReport(t.deps, parentCtx, 'rep1', 'valide')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect((await t.store.get(keys.profile(SID)))?.xp).toBe(15);
  });
});

describe('isolation entre familles', () => {
  it('le nombre d\'elements ne change pas quand une autre famille lit', async () => {
    const t = testDeps();
    await seed(t);
    const n = count(t);
    await exportFamily(t.deps, { ...parentCtx, familyId: 'autre' });
    expect(count(t)).toBe(n);
  });
});
