import { afterEach, describe, expect, it, vi } from 'vitest';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { sha256, type Key } from '../../../shared/ddb/keys.js';
import { DAILY_LIMIT, actorOf, createInvitation, type InviteDb, type InviteDeps } from './invitations.js';

process.env.QCM_ENV = 'dev';
process.env.TABLE_NAME = 'qcm-dev';
process.env.AWS_REGION = 'eu-west-3';
process.env.AWS_ACCESS_KEY_ID = 'x';
process.env.AWS_SECRET_ACCESS_KEY = 'x';

const mocked: { deps?: InviteDeps } = {};
vi.mock('../handlers/runtime.js', () => ({ inviteDeps: () => mocked.deps }));

const memDb = () => {
  const items = new Map<string, Key & Record<string, unknown>>();
  const db: InviteDb = {
    async putNew(item: Key) {
      await Promise.resolve();
      const k = `${item.PK}|${item.SK}`;
      if (items.has(k)) return false;
      items.set(k, item as Key & Record<string, unknown>);
      return true;
    },
  };
  return { db, items };
};
const at = (iso: string) => () => new Date(iso);
const ADMIN = { sub: 'sub-admin-1' };

describe('createInvitation', () => {
  it('succes: code de 128 bits, seul le hache est stocke, element identique a celui de create-invite', async () => {
    const { db, items } = memDb();
    const r = await createInvitation({ db, now: at('2026-12-01T09:00:00Z') }, ADMIN);
    expect(r.code).toMatch(/^[0-9a-f]{32}$/);
    expect(r).toMatchObject({ createdAt: '2026-12-01T09:00:00.000Z', remainingToday: DAILY_LIMIT - 1 });
    const invite = items.get(`INVITE#${sha256(r.code)}|META`);
    expect(invite).toEqual({ PK: `INVITE#${sha256(r.code)}`, SK: 'META', utilisee: false, creeLe: '2026-12-01T09:00:00.000Z' });
    expect(JSON.stringify([...items.values()])).not.toContain(r.code); // le code en clair n'est stocke nulle part
  });

  it('chaque code est different et usage unique (une cle par hache)', async () => {
    const { db } = memDb();
    const a = await createInvitation({ db, now: at('2026-12-01T09:00:00Z') }, ADMIN);
    const b = await createInvitation({ db, now: at('2026-12-01T09:00:00Z') }, ADMIN);
    expect(a.code).not.toBe(b.code);
    expect(b.remainingToday).toBe(DAILY_LIMIT - 2);
  });

  it('limite de debit: 20 par jour et par administrateur, 429 ensuite, autre administrateur et lendemain non touches', async () => {
    const { db, items } = memDb();
    const deps = { db, now: at('2026-12-01T09:00:00Z') };
    for (let i = 0; i < DAILY_LIMIT; i++) await createInvitation(deps, ADMIN);
    const before = items.size;
    await expect(createInvitation(deps, ADMIN)).rejects.toMatchObject({ status: 429, code: 'quota_epuise' });
    expect(items.size).toBe(before); // le refus n'a pas cree de code
    expect((await createInvitation(deps, { sub: 'sub-admin-2' })).remainingToday).toBe(DAILY_LIMIT - 1);
    expect((await createInvitation({ db, now: at('2026-12-02T00:00:01Z') }, ADMIN)).remainingToday).toBe(DAILY_LIMIT - 1);
  });

  it("audit: qui (hache du sub) et quand, jamais le code ni le sub en clair; l'audit expire (ttl)", async () => {
    const { db, items } = memDb();
    const r = await createInvitation({ db, now: at('2026-12-01T09:00:00Z') }, ADMIN);
    const audit = [...items.values()].find((i) => String(i.PK).startsWith('INVITE#AUDIT#'))!;
    expect(audit).toMatchObject({ evenement: 'invitation_creee', actor: actorOf(ADMIN.sub), creeLe: '2026-12-01T09:00:00.000Z' });
    expect(audit.ttl).toBeGreaterThan(Date.parse('2026-12-01T09:00:00Z') / 1000);
    expect(JSON.stringify(audit)).not.toContain(r.code);
    expect(JSON.stringify(audit)).not.toContain(ADMIN.sub);
  });
});

type H = (e: APIGatewayProxyEventV2WithJWTAuthorizer) => Promise<{ statusCode: number; body?: string }>;
const ev = (groups: string | undefined, routeKey = 'POST /admin/invitations') =>
  ({ routeKey, requestContext: { authorizer: { jwt: { claims: { sub: 'sub-x', ...(groups === undefined ? {} : { 'cognito:groups': groups }) } } } } }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('handler admin-invitations: refus avant tout appel AWS', () => {
  afterEach(() => vi.restoreAllMocks());
  it.each([
    ['sans groupe', undefined],
    ['groupe vide', ''],
    ['parent', '[parent]'],
    ['eleve', '[eleve]'],
    ['administrateur et eleve', '[admin eleve]'],
    ['groupe au nom proche', '[administrateur]'],
  ])('%s: 403 interdit', async (_n, groups) => {
    const h = (await import('../handlers/admin-invitations.js')).handler as H;
    const r = await h(ev(groups));
    expect(r.statusCode).toBe(403);
    expect(JSON.parse(r.body as string)).toEqual({ code: 'interdit', message: 'Acces refuse' });
  });

  it('administrateur sur une autre route: 404, jamais de code', async () => {
    const h = (await import('../handlers/admin-invitations.js')).handler as H;
    expect((await h(ev('[admin]', 'GET /autre'))).statusCode).toBe(404);
  });

  it('administrateur: 201, code dans la reponse, et le code ne figure dans AUCUNE ligne de journal', async () => {
    mocked.deps = { db: memDb().db, now: () => new Date('2026-12-01T09:00:00Z') };
    const lines: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation((c: unknown) => {
      lines.push(String(c));
      return true;
    });
    const h = (await import('../handlers/admin-invitations.js')).handler as H;
    const r = await h(ev('[admin parent]'));
    vi.restoreAllMocks();
    expect(r.statusCode).toBe(201);
    expect((r as { headers?: Record<string, string> }).headers?.['cache-control']).toBe('no-store');
    const body = JSON.parse(r.body as string) as { code: string };
    expect(body.code).toMatch(/^[0-9a-f]{32}$/);
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.join('')).not.toContain(body.code);
    expect(lines.join('')).not.toContain('sub-x');
  });
});
