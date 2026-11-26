// ID1 (#33): identifiant de connexion et surnom. Chaque test de concurrence ou de reservation echoue sans la reservation `NAME#` ecrite dans la meme ecriture que l'eleve.
import { describe, expect, it } from 'vitest';
import { deleteFamilyTree } from '../../../shared/delete-tree.js';
import { keys } from '../../../shared/ddb/keys.js';
import { POLICY_VERSION } from '../../../shared/policy.js';
import { nameKey } from '../../../shared/pseudo-rules.js';
import { displayNameOf, loginIdOf, studentView } from '../game/access.js';
import { getLeaderboard, getMe } from '../game/family-read.js';
import { LOGIN_SUFFIX_ALPHABET, randomSuffix } from '../lib/deps.js';
import { HttpError, type ParentCtx } from '../lib/http.js';
import { AliasTakenError } from '../lib/identity.js';
import { FID, parentCtx, testDeps, type TestEnv } from '../lib/testkit.js';
import { activate } from './activation.js';
import { createStudent, deleteStudent, regenerateLoginId, updateStudent } from './students.js';

const PW = 'Un-mot-de-passe-long-1';
const CONSENT = { parentalAuthority: true as const, policyVersion: POLICY_VERSION };
const ctx2: ParentCtx = { sub: 'sub-par2', username: 'par2', familyId: 'fam2' };
const tokenOf = (url: string) => url.split('#token=')[1];
const mk = (t: TestEnv, pseudo: string, ctx = parentCtx) => createStudent(t.deps, ctx, { pseudo, schoolLevel: 'seconde', under15: false, ...CONSENT });
const fam = (t: TestEnv, fid = FID) => t.store.commit([{ item: { ...keys.family(fid), plafondPages: 50, ownerSub: 'sub-x' }, when: 'any' }]);
const err = async (p: Promise<unknown>): Promise<HttpError> => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e).toBeInstanceOf(HttpError);
  return e as HttpError;
};
const names = (t: TestEnv, fid = FID) => [...t.store.items.values()].filter((i) => i.PK === `FAMILY#${fid}` && i.SK.startsWith('NAME#')).map((i) => i.SK.slice(5)).sort();

describe('ID1: creation', () => {
  it('identifiant en minuscules, surnom de depart, reservation du nom; plus de champ pseudo', async () => {
    const t = testDeps();
    await fam(t);
    const r = await mk(t, 'Léa Rose');
    expect(r.student.loginId).toMatch(/^lea-rose-s\d{3}$/);
    expect(r.student.displayName).toBe('Léa Rose');
    const stored = (await t.store.get(keys.student(FID, r.student.studentId)))!;
    expect(stored.pseudo).toBeUndefined();
    expect(names(t)).toEqual(['lea-rose']);
  });
  it('surnom de depart refuse: 400 pseudo_refuse, rien cree ni dans la base ni dans Cognito', async () => {
    const t = testDeps();
    await fam(t);
    const e = await err(mk(t, 'Connard'));
    expect([e.status, e.code]).toEqual([400, 'pseudo_refuse']);
    expect(e.message).not.toMatch(/connard/i);
    expect(t.identity.users.size).toBe(0);
    expect(names(t)).toEqual([]);
  });
  it('deux freres au meme surnom: le second est refuse (409 pseudo_pris); une autre famille peut le prendre', async () => {
    const t = testDeps();
    await fam(t);
    await fam(t, 'fam2');
    await mk(t, 'Lila');
    const e = await err(mk(t, 'LILA'));
    expect([e.status, e.code]).toEqual([409, 'pseudo_pris']);
    expect(t.identity.users.size).toBe(1);
    await expect(mk(t, 'Lila', ctx2)).resolves.toBeDefined();
  });
  it('deux creations en course sur le meme surnom: une seule gagne, l\'utilisateur Cognito du perdant est retire', async () => {
    const t = testDeps();
    await fam(t);
    const r = await Promise.allSettled([mk(t, 'Zoe'), mk(t, 'Zoe')]);
    expect(r.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    const lost = r.find((x) => x.status === 'rejected') as PromiseRejectedResult;
    expect((lost.reason as HttpError).code).toBe('pseudo_pris');
    expect(t.identity.users.size).toBe(1);
    expect(names(t)).toEqual(['zoe']);
  });
});

describe('ID1: activation', () => {
  async function two() {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const b = await mk(t, 'Bob');
    return { t, a, b, ta: tokenOf(a.activationLink.url), tb: tokenOf(b.activationLink.url) };
  }
  it('surnom refuse: 400 pseudo_refuse ET le jeton reste utilisable', async () => {
    const { t, ta } = await two();
    for (const bad of ['Porn', 'Lila2012', 'Л\u0430ra', 'a@b']) expect((await err(activate(t.deps, t.identity, { token: ta, password: PW, displayName: bad }))).code).toBe('pseudo_refuse');
    expect(await t.store.get(keys.activation(ta))).toBeDefined();
    expect((await t.store.get(keys.activation(ta)))!.usedAt).toBeUndefined();
    await expect(activate(t.deps, t.identity, { token: ta, password: PW })).resolves.toMatchObject({ displayName: 'Ana' });
  });
  it('surnom deja pris dans la famille: 409 pseudo_pris AVANT le jeton, qui reste utilisable', async () => {
    const { t, ta } = await two();
    const e = await err(activate(t.deps, t.identity, { token: ta, password: PW, displayName: 'bob' }));
    expect([e.status, e.code]).toEqual([409, 'pseudo_pris']);
    expect((await t.store.get(keys.activation(ta)))!.usedAt).toBeUndefined();
    expect([...t.identity.users.values()].every((u) => u.password === undefined)).toBe(true);
  });
  it('surnom accepte: 200 avec l\'identifiant, ancienne reservation liberee, nouvelle posee', async () => {
    const { t, a, ta } = await two();
    const r = await activate(t.deps, t.identity, { token: ta, password: PW, displayName: 'Anouk' });
    expect(r).toEqual({ loginId: a.student.loginId, displayName: 'Anouk' });
    expect(names(t)).toEqual(['anouk', 'bob']);
    expect(displayNameOf((await t.store.get(keys.student(FID, a.student.studentId)))!)).toBe('Anouk');
  });
  it('sans displayName: on garde le surnom de depart', async () => {
    const { t, a, ta } = await two();
    expect(await activate(t.deps, t.identity, { token: ta, password: PW })).toEqual({ loginId: a.student.loginId, displayName: 'Ana' });
    expect(names(t)).toEqual(['ana', 'bob']);
  });
  it('deux activations en course sur le meme surnom: une seule l\'obtient, l\'autre garde son surnom de depart avec displayNameChanged', async () => {
    const { t, ta, tb } = await two();
    const [x, y] = await Promise.all([activate(t.deps, t.identity, { token: ta, password: PW, displayName: 'Rio' }), activate(t.deps, t.identity, { token: tb, password: PW, displayName: 'Rio' })]);
    const got = [x, y].filter((r) => r.displayName === 'Rio');
    expect(got).toHaveLength(1);
    const lost = [x, y].find((r) => r.displayName !== 'Rio')!;
    expect(lost.displayNameChanged).toBe(true);
    expect(['Ana', 'Bob']).toContain(lost.displayName);
    expect(names(t)).toHaveLength(2);
    expect(names(t)).toContain('rio');
  });
  it('nom devenu indisponible apres le mot de passe: surnom de depart, displayNameChanged, compte actif', async () => {
    const { t, a, ta } = await two();
    const real = t.identity.setPassword;
    t.identity.setPassword = async (u, p) => {
      await real(u, p);
      await t.store.commit([{ item: { ...keys.name(FID, 'kim'), studentId: 'autre' }, when: 'any' }]); // un frere vient de le prendre
    };
    const r = await activate(t.deps, t.identity, { token: ta, password: PW, displayName: 'Kim' });
    expect(r).toEqual({ loginId: a.student.loginId, displayName: 'Ana', displayNameChanged: true });
    expect(t.identity.users.get(a.student.studentId)?.password).toBe(PW);
  });
  it('conflit de version sur l\'eleve pendant l\'activation: relecture et nouvel essai, rien n\'est perdu', async () => {
    const { t, a, ta } = await two();
    const real = t.identity.setPassword;
    t.identity.setPassword = async (u, p) => {
      await real(u, p);
      await updateStudent(t.deps, parentCtx, a.student.studentId, { schoolLevel: 'terminale' }); // le parent change le niveau au meme instant
    };
    const r = await activate(t.deps, t.identity, { token: ta, password: PW, displayName: 'Anouk' });
    expect(r.displayName).toBe('Anouk');
    const s = (await t.store.get(keys.student(FID, a.student.studentId)))!;
    expect([s.niveau, s.displayName, s.activationHash]).toEqual(['terminale', 'Anouk', undefined]);
  });
  it('ancien compte sans reservation: l\'activation pose le nouveau surnom sans toucher a celle d\'un frere', async () => {
    const t = testDeps();
    await fam(t);
    await mk(t, 'Max'); // reservation « max »
    const r = await mk(t, 'Tom');
    const old = (await t.store.get(keys.student(FID, r.student.studentId)))!;
    await t.store.remove(keys.name(FID, 'tom'));
    await t.store.commit([{ item: { ...old, loginId: undefined, displayName: undefined, pseudo: 'Tom-7k2f' }, when: 'any' }]);
    const out = await activate(t.deps, t.identity, { token: tokenOf(r.activationLink.url), password: PW, displayName: 'Tommy' });
    expect(out.displayName).toBe('Tommy');
    expect(names(t)).toEqual(['max', 'tommy']);
  });
});

describe('ID1: renommage par le parent', () => {
  it('refuse un doublon de famille (409), accepte le meme nom dans une autre famille, libere l\'ancienne reservation', async () => {
    const t = testDeps();
    await fam(t);
    await fam(t, 'fam2');
    const a = await mk(t, 'Ana');
    await mk(t, 'Bob');
    const o = await mk(t, 'Cleo', ctx2);
    const e = await err(updateStudent(t.deps, parentCtx, a.student.studentId, { displayName: 'bob' }));
    expect([e.status, e.code]).toEqual([409, 'pseudo_pris']);
    await expect(updateStudent(t.deps, ctx2, o.student.studentId, { displayName: 'Ana' })).resolves.toMatchObject({ displayName: 'Ana' });
    expect((await updateStudent(t.deps, parentCtx, a.student.studentId, { displayName: 'Anouk' })).displayName).toBe('Anouk');
    expect(names(t)).toEqual(['anouk', 'bob']);
    await expect(updateStudent(t.deps, parentCtx, a.student.studentId, { displayName: 'ANOUK' })).resolves.toMatchObject({ displayName: 'ANOUK' }); // meme cle: pas de conflit avec soi-meme
    expect(names(t)).toEqual(['anouk', 'bob']);
    await expect(mk(t, 'Ana')).resolves.toBeDefined(); // l'ancien nom est libre
  });
  it('surnom refuse par le parent: 400 pseudo_refuse; eleve d\'une autre famille: 404', async () => {
    const t = testDeps();
    await fam(t);
    await fam(t, 'fam2');
    const a = await mk(t, 'Ana');
    expect((await err(updateStudent(t.deps, parentCtx, a.student.studentId, { displayName: 'Fuck' }))).code).toBe('pseudo_refuse');
    expect((await err(updateStudent(t.deps, ctx2, a.student.studentId, { displayName: 'Zed' }))).status).toBe(404);
  });
  it('un renommage et une activation en course sur le meme nom: une seule gagne', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const b = await mk(t, 'Bob');
    const [x, y] = await Promise.allSettled([
      updateStudent(t.deps, parentCtx, a.student.studentId, { displayName: 'Rio' }),
      activate(t.deps, t.identity, { token: tokenOf(b.activationLink.url), password: PW, displayName: 'Rio' }),
    ]);
    const winners = [x.status === 'fulfilled' && x.value.displayName === 'Rio', y.status === 'fulfilled' && y.value.displayName === 'Rio'].filter(Boolean);
    expect(winners).toHaveLength(1);
    expect(names(t).filter((n) => n === 'rio')).toHaveLength(1);
  });
  it('anciens comptes: deux freres au meme nom derive, le renommage vers ce nom est refuse', async () => {
    const t = testDeps();
    await fam(t);
    const put = (sid: string, pseudo: string) => t.store.commit([{ item: { ...keys.student(FID, sid), pseudo, niveau: 'seconde', statut: 'actif', cognitoSub: `sub-${sid}` }, when: 'any' }]);
    await put('o1', 'Lila-7k2f');
    await put('o2', 'Lila-9x1z');
    const e = await err(updateStudent(t.deps, parentCtx, 'o2', { displayName: 'lila' }));
    expect(e.code).toBe('pseudo_pris');
    expect((await updateStudent(t.deps, parentCtx, 'o2', { displayName: 'Lilou' })).displayName).toBe('Lilou');
    expect(names(t)).toEqual(['lilou']); // pas de reservation pour l'ancien, le sien est posee
  });
});

describe('ID1: reservations liberees a la suppression', () => {
  it('supprimer un eleve libere son nom; supprimer la famille retire toutes les reservations', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    await mk(t, 'Bob');
    expect(names(t)).toEqual(['ana', 'bob']);
    await deleteStudent(t.deps, parentCtx, a.student.studentId);
    expect(names(t)).toEqual(['bob']);
    await expect(mk(t, 'Ana')).resolves.toBeDefined();
    await deleteFamilyTree(t.deps.tree, FID);
    expect([...t.store.items.values()].filter((i) => i.SK.startsWith('NAME#'))).toEqual([]);
  });
});

describe('ID1: nouvel identifiant de connexion', () => {
  it('l\'alias Cognito change, l\'ancien est libre, deconnexion globale, base a jour, mot de passe et surnom intacts', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const sid = a.student.studentId;
    await activate(t.deps, t.identity, { token: tokenOf(a.activationLink.url), password: PW });
    const r = await regenerateLoginId(t.deps, parentCtx, sid);
    expect(r.loginId).not.toBe(a.student.loginId);
    expect(r.loginId).toMatch(/^ana-s\d{3}$/);
    expect(t.identity.users.get(sid)).toMatchObject({ alias: r.loginId, password: PW });
    expect(t.identity.signOuts.get(sid)).toBe(1);
    const s = (await t.store.get(keys.student(FID, sid)))!;
    expect([s.loginId, s.displayName]).toEqual([r.loginId, 'Ana']);
    // L'ancien identifiant est libre: un autre eleve peut le recevoir.
    await expect(t.identity.createStudent({ studentId: 'x', familyId: FID, alias: a.student.loginId })).resolves.toBeDefined();
    await expect(t.identity.createStudent({ studentId: 'y', familyId: FID, alias: r.loginId })).rejects.toBeInstanceOf(AliasTakenError);
  });
  it('ne touche pas le champ pseudo brut d\'un ancien compte', async () => {
    const t = testDeps();
    await fam(t);
    await t.identity.createStudent({ studentId: 'o1', familyId: FID, alias: 'Lila-7k2f' });
    await t.store.commit([{ item: { ...keys.student(FID, 'o1'), pseudo: 'Lila-7k2f', niveau: 'seconde', statut: 'actif', cognitoSub: 'sub-o1' }, when: 'any' }]);
    const r = await regenerateLoginId(t.deps, parentCtx, 'o1');
    expect(r.loginId).toMatch(/^lila-s\d{3}$/);
    const s = (await t.store.get(keys.student(FID, 'o1')))!;
    expect(s.pseudo).toBe('Lila-7k2f');
    expect([loginIdOf(s), displayNameOf(s)]).toEqual([r.loginId, 'Lila']);
  });
  it('rejeu apres echec de la base: l\'alias deja pose dans Cognito est ecrit en base, pas un troisieme', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const sid = a.student.studentId;
    t.identity.failAfterAlias = 1; // Cognito a pose l'alias puis la reponse est perdue
    await expect(regenerateLoginId(t.deps, parentCtx, sid)).rejects.toThrow('Throttling');
    const posed = t.identity.users.get(sid)!.alias!;
    expect(posed).not.toBe(a.student.loginId);
    expect(loginIdOf((await t.store.get(keys.student(FID, sid)))!)).toBe(a.student.loginId);
    const r = await regenerateLoginId(t.deps, parentCtx, sid);
    expect(r.loginId).toBe(posed);
    expect(loginIdOf((await t.store.get(keys.student(FID, sid)))!)).toBe(posed);
  });
  it('la deconnexion globale est refaite a chaque appel, meme quand tout est deja coherent', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const sid = a.student.studentId;
    t.identity.failSignOut = 1;
    await expect(regenerateLoginId(t.deps, parentCtx, sid)).rejects.toThrow('Throttling');
    expect(t.identity.signOuts.get(sid)).toBeUndefined();
    const r = await regenerateLoginId(t.deps, parentCtx, sid); // base et Cognito coherents: pas de nouvel alias, mais deconnexion
    expect(t.identity.signOuts.get(sid)).toBe(1);
    expect(t.identity.users.get(sid)!.alias).toBe(r.loginId);
  });
  it('alias deja pris au tirage: nouvel essai; trop d\'echecs: erreur', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const real = t.identity.updateAlias;
    let n = 0;
    t.identity.updateAlias = async (u, al) => {
      if (n++ < 2) throw new AliasTakenError();
      return real(u, al);
    };
    await expect(regenerateLoginId(t.deps, parentCtx, a.student.studentId)).resolves.toBeDefined();
    n = -10;
    await expect(regenerateLoginId(t.deps, parentCtx, a.student.studentId)).rejects.toBeInstanceOf(AliasTakenError);
  });
  it('enumeration: eleve d\'une autre famille et eleve inconnu donnent exactement la meme reponse 404, sans toucher Cognito', async () => {
    const t = testDeps();
    await fam(t);
    await fam(t, 'fam2');
    const o = await mk(t, 'Cleo', ctx2);
    const e1 = await err(regenerateLoginId(t.deps, parentCtx, o.student.studentId));
    const e2 = await err(regenerateLoginId(t.deps, parentCtx, 'inconnu'));
    expect([e1.status, e1.code, e1.message]).toEqual([e2.status, e2.code, e2.message]);
    expect(e1.status).toBe(404);
    expect(t.identity.users.get(o.student.studentId)!.alias).toBe(o.student.loginId);
    expect(t.identity.signOuts.size).toBe(0);
  });
  it('utilisateur Cognito disparu: 404', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    t.identity.users.delete(a.student.studentId);
    expect((await err(regenerateLoginId(t.deps, parentCtx, a.student.studentId))).status).toBe(404);
  });
});

describe('ID1: vues et comptes existants', () => {
  it('ancien compte: loginId = ancien pseudo, surnom sans suffixe; nouveau compte: les deux champs', () => {
    const base = { PK: 'FAMILY#f', SK: 'STUDENT#s', niveau: 'seconde', statut: 'actif' };
    expect(studentView({ ...base, pseudo: 'Lila-7k2f' })).toMatchObject({ pseudo: 'Lila-7k2f', loginId: 'Lila-7k2f', displayName: 'Lila' });
    expect(studentView({ ...base, pseudo: 'Sans' })).toMatchObject({ loginId: 'Sans', displayName: 'Sans' });
    expect(studentView({ ...base, loginId: 'lila-7k2fm', displayName: 'Lila Rose' })).toMatchObject({ pseudo: 'lila-7k2fm', loginId: 'lila-7k2fm', displayName: 'Lila Rose' });
  });
  it('GET /me: l\'eleve a loginId et displayName, le parent aucun des deux; le classement ne montre jamais l\'identifiant', async () => {
    const t = testDeps();
    await fam(t);
    const a = await mk(t, 'Ana');
    const sid = a.student.studentId;
    await activate(t.deps, t.identity, { token: tokenOf(a.activationLink.url), password: PW });
    const me = await getMe(t.deps, { sub: `sub-${sid}`, username: sid, role: 'eleve', familyId: FID });
    expect(me).toMatchObject({ loginId: a.student.loginId, displayName: 'Ana', pseudo: a.student.loginId });
    const par = await getMe(t.deps, { sub: 'sub-par1', username: 'par1', role: 'parent', familyId: FID });
    expect(Object.keys(par)).not.toContain('loginId');
    expect(Object.keys(par)).not.toContain('displayName');
    const week = '2026-W49';
    await t.store.commit([{ item: { ...keys.week(FID, week, sid), xp: 50, days: ['a', 'b', 'c'] }, when: 'any' }]);
    const lb = await getLeaderboard(t.deps, FID);
    expect(JSON.stringify(lb)).not.toContain(a.student.loginId);
    expect(nameKey('x')).toBe('x');
  });
});

describe('ID1: suffixe de l\'identifiant', () => {
  it('5 caracteres de l\'alphabet sans ambiguite, tirage par rejet sans biais', () => {
    expect(LOGIN_SUFFIX_ALPHABET).toHaveLength(31);
    expect(LOGIN_SUFFIX_ALPHABET).not.toMatch(/[01oli]/);
    // Les octets 248 a 255 (au-dela du plus grand multiple de 31) sont ecartes: seul 0..247 est utilise.
    const seq = [255, 250, 248, 0, 1, 2, 30, 31, 247, 5, 6, 7];
    const out = randomSuffix(() => Uint8Array.from(seq));
    expect(out).toBe([0, 1, 2, 30, 0].map((i) => LOGIN_SUFFIX_ALPHABET[i]).join(''));
    for (let i = 0; i < 200; i++) expect(randomSuffix()).toMatch(/^[abcdefghjkmnpqrstuvwxyz2-9]{5}$/);
  });
});
