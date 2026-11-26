// H1-A: export (testsCount) et relevement de POLICY_VERSION (Q3): les parents deja inscrits ne sont pas bloques par le nouveau texte.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { POLICY_VERSION } from '../../../shared/policy.js';
import { getDashboard, getMe } from '../game/family-read.js';
import { HttpError } from '../lib/http.js';
import { FID, SID, parentCtx, seed, testDeps } from '../lib/testkit.js';
import { createStudent } from './students.js';
import { acceptPolicy, exportFamily } from './family.js';

const OLD = '2026-11-25';

describe('export: testsCount', () => {
  it('compte les passages de chaque eleve, sans renvoyer leur contenu ni le pointeur interne', async () => {
    const t = testDeps();
    await seed(t);
    await seed(t, { sid: 'stu9', docId: 'doc9' });
    const put = (item: Record<string, unknown> & { PK: string; SK: string }) => t.store.commit([{ item, when: 'any' }]);
    await put({ ...keys.test(SID, '2026-12-01T10:00:00Z', 'A'.repeat(26)), docId: 'doc1', items: [{ q: 'doc1:qcm:01', c: 'reponse-secrete' }] });
    await put({ ...keys.test(SID, '2026-12-02T10:00:00Z', 'B'.repeat(26)), docId: 'doc1', items: [] });
    await put({ ...keys.profile(SID), xp: 5, currentTest: { testId: 'x' }, anneesScolaires: ['2026-2027'] });
    const e = await exportFamily(t.deps, parentCtx);
    expect(e.students.find((s) => s.studentId === SID)).toMatchObject({ testsCount: 2, profile: { xp: 5, anneesScolaires: ['2026-2027'] } });
    expect(e.students.find((s) => s.studentId === 'stu9')).toMatchObject({ testsCount: 0 });
    expect(JSON.stringify(e)).not.toMatch(/reponse-secrete|currentTest/);
  });
});

describe('Q3: POLICY_VERSION relevee', () => {
  it('la version a change (les anciens consentements ne valent plus la version en vigueur)', () => {
    expect(POLICY_VERSION).not.toBe(OLD);
  });
  it('un parent inscrit sous l\'ancienne version continue de se connecter et de lire (GET /me, tableau de bord), sans etre bloque', async () => {
    const t = testDeps();
    await seed(t);
    await t.store.commit([{ item: { ...keys.family(FID), ownerSub: 'sub-par1', consentementLe: '2026-11-25T09:00:00.000Z', versionPolitique: OLD }, when: 'any' }]);
    const a = { sub: 'sub-par1', username: 'par1', role: 'parent' as const, familyId: FID };
    expect(await getMe(t.deps, a)).toMatchObject({ role: 'parent', familyId: FID });
    await expect(getDashboard(t.deps, parentCtx)).resolves.toBeDefined();
    expect((await exportFamily(t.deps, parentCtx)).consentement).toEqual({ consentementLe: '2026-11-25T09:00:00.000Z', versionPolitique: OLD }); // l'ancien consentement reste visible, non ecrase
  });
  it('un client qui envoie encore l\'ancienne version (page en cache) est refuse (400, rien cree); la nouvelle version est acceptee et enregistree', async () => {
    const t = testDeps();
    await seed(t);
    const body = { pseudo: 'Lila', schoolLevel: 'seconde' as const, under15: false, parentalAuthority: true as const };
    const before = (await t.store.query(`FAMILY#${FID}`, 'STUDENT#')).length;
    const e = await createStudent(t.deps, parentCtx, { ...body, policyVersion: OLD }).then(() => undefined, (x: unknown) => x);
    expect(e).toBeInstanceOf(HttpError);
    expect((e as HttpError).status).toBe(400);
    expect((await t.store.query(`FAMILY#${FID}`, 'STUDENT#')).length).toBe(before);
    const ok = await createStudent(t.deps, parentCtx, { ...body, policyVersion: POLICY_VERSION });
    expect(await t.store.get(keys.student(FID, ok.student.studentId))).toMatchObject({ versionPolitique: POLICY_VERSION });
  });
});

// H1-W: re-acceptation de la politique (C1 de la relecture de la PR #77, Q3 du proprietaire).
describe('H1-W: re-acceptation de la politique', () => {
  const parent = { sub: 'sub-par1', username: 'par1', role: 'parent' as const, familyId: FID };
  const withConsent = (t: ReturnType<typeof testDeps>, version?: string) =>
    t.store.commit([{ item: { ...keys.family(FID), ownerSub: 'sub-par1', consentementLe: '2026-11-25T09:00:00.000Z', ...(version ? { versionPolitique: version } : {}) }, when: 'any' }]);
  const status = (p: Promise<unknown>) => p.then(() => 0, (x: unknown) => (x as HttpError).status);

  it('GET /me signale une famille qui a consenti sur une autre version, ou sans version enregistree', async () => {
    const t = testDeps();
    await seed(t);
    await withConsent(t, OLD);
    expect(await getMe(t.deps, parent)).toMatchObject({ policyOutdated: true });
    await withConsent(t);
    expect(await getMe(t.deps, parent)).toMatchObject({ policyOutdated: true });
  });
  it('R1-D: une famille qui a consenti sur la version du 2026-11-26 (celle d\'avant la hausse unique) doit ré-accepter', async () => {
    const t = testDeps();
    await seed(t);
    await withConsent(t, '2026-11-26');
    expect(await getMe(t.deps, parent)).toMatchObject({ policyOutdated: true });
  });
  it('GET /me ne signale rien quand la version est a jour, ni pour un eleve', async () => {
    const t = testDeps();
    await seed(t);
    await withConsent(t, POLICY_VERSION);
    expect(await getMe(t.deps, parent)).not.toHaveProperty('policyOutdated');
    await withConsent(t, OLD);
    expect(await getMe(t.deps, { sub: 'sub-stu1', username: SID, role: 'eleve', familyId: FID })).not.toHaveProperty('policyOutdated');
  });
  it('POST /family/policy enregistre la version et la date; deux appels ne changent rien de plus', async () => {
    const t = testDeps();
    await seed(t);
    await withConsent(t, OLD);
    await acceptPolicy(t.deps, parentCtx, { consent: true, policyVersion: POLICY_VERSION });
    const m = await t.store.get(keys.family(FID));
    expect(m).toMatchObject({ versionPolitique: POLICY_VERSION, ownerSub: 'sub-par1' });
    expect(m?.consentementLe).not.toBe('2026-11-25T09:00:00.000Z');
    expect(await getMe(t.deps, parent)).not.toHaveProperty('policyOutdated');
    const again = await t.store.get(keys.family(FID));
    await acceptPolicy(t.deps, parentCtx, { consent: true, policyVersion: POLICY_VERSION });
    expect(await t.store.get(keys.family(FID))).toEqual(again);
  });
  it('POST /family/policy refuse sans consentement ou avec une autre version (400, rien ecrit), et une famille inconnue (404)', async () => {
    const t = testDeps();
    await seed(t);
    await withConsent(t, OLD);
    expect(await status(acceptPolicy(t.deps, parentCtx, { consent: false, policyVersion: POLICY_VERSION }))).toBe(400);
    expect(await status(acceptPolicy(t.deps, parentCtx, { consent: true, policyVersion: OLD }))).toBe(400);
    expect((await t.store.get(keys.family(FID)))?.versionPolitique).toBe(OLD);
    expect(await status(acceptPolicy(t.deps, { ...parentCtx, familyId: 'autre' }, { consent: true, policyVersion: POLICY_VERSION }))).toBe(404);
  });
});
