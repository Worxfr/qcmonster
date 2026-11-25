import { describe, expect, it, vi } from 'vitest';
import { FetchRefused, guardedGetJson, userAgent } from './fetch.js';
import { jsonResponse } from './testkit.js';

const refused = async (p: Promise<unknown>) => {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(FetchRefused);
    return (e as FetchRefused).reason;
  }
  throw new Error('aurait du etre refuse');
};
const U = 'https://fr.wikipedia.org/w/api.php?action=query';
const init = (f: { mock: { calls: unknown[][] } }) => f.mock.calls[0][1] as RequestInit;

describe('lecture sortante gardee', () => {
  it('refuse un hote hors liste, sans appeler le reseau', async () => {
    const f = vi.fn();
    for (const u of ['https://evil.example/x', 'https://fr.wikipedia.org.evil.example/x', 'https://wikipedia.org/x', 'https://de.wikipedia.org/x', 'https://user:pw@fr.wikipedia.org/x', 'https://fr.wikipedia.org:8443/x', 'https://127.0.0.1/x', 'https://localhost/x']) {
      expect(await refused(guardedGetJson(u, { fetchImpl: f as never })), u).toBe('host');
    }
    expect(f).not.toHaveBeenCalled();
  });
  it('refuse http et les adresses mal formees', async () => {
    const f = vi.fn();
    expect(await refused(guardedGetJson('http://fr.wikipedia.org/x', { fetchImpl: f as never }))).toBe('scheme');
    expect(await refused(guardedGetJson('pas une url', { fetchImpl: f as never }))).toBe('format');
    expect(f).not.toHaveBeenCalled();
  });
  it('refuse une redirection (jamais suivie)', async () => {
    const f = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://evil.example/' } }));
    expect(await refused(guardedGetJson(U, { fetchImpl: f as never }))).toBe('redirect');
    expect(f).toHaveBeenCalledTimes(1);
    expect(init(f).redirect).toBe('manual');
  });
  it('refuse une reponse de plus de 64 Ko, annoncee ou en flux', async () => {
    const big = JSON.stringify({ x: 'a'.repeat(70_000) });
    expect(await refused(guardedGetJson(U, { fetchImpl: (async () => new Response(big, { status: 200, headers: { 'content-length': String(big.length) } })) as never }))).toBe('size');
    const stream = new ReadableStream({
      start(c) {
        c.enqueue(new TextEncoder().encode(big));
        c.close();
      },
    });
    expect(await refused(guardedGetJson(U, { fetchImpl: (async () => new Response(stream, { status: 200 })) as never }))).toBe('size');
  });
  it('accepte 64 Ko pile; refuse delai depasse, statut et format', async () => {
    const ok = JSON.stringify({ x: 'a'.repeat(65_536 - 8) });
    expect(ok.length).toBeLessThanOrEqual(65_536);
    expect(await guardedGetJson(U, { fetchImpl: (async () => new Response(ok, { status: 200 })) as never })).toEqual({ x: 'a'.repeat(65_536 - 8) });
    const hang = (_u: string, i: RequestInit) => new Promise((_r, rej) => i.signal!.addEventListener('abort', () => rej(new Error('abort'))));
    expect(await refused(guardedGetJson(U, { timeoutMs: 20, fetchImpl: hang as never }))).toBe('timeout');
    expect(await refused(guardedGetJson(U, { fetchImpl: (async () => new Response('x', { status: 500 })) as never }))).toBe('status');
    expect(await refused(guardedGetJson(U, { fetchImpl: (async () => new Response('<html>', { status: 200 })) as never }))).toBe('format');
  });
  it("User-Agent: le contact est obligatoire en production, repli hors production", () => {
    const env = { ...process.env };
    try {
      delete process.env.QCM_UA_CONTACT;
      process.env.QCM_ENV = 'prod';
      expect(() => userAgent()).toThrow(/QCM_UA_CONTACT/);
      process.env.QCM_UA_CONTACT = 'equipe@example.invalid';
      expect(userAgent()).toContain('equipe@example.invalid');
      delete process.env.QCM_UA_CONTACT;
      process.env.QCM_ENV = 'dev';
      expect(userAgent()).toMatch(/^QCMonsterVerifyBot\/1\.0 \(.+\) /);
      expect(userAgent()).toContain('example.invalid'); // A3: jamais l'adresse reelle du proprietaire
    } finally {
      process.env = env;
    }
  });
  it("n'envoie aucun en-tete d'identification, un User-Agent descriptif avec contact", async () => {
    const f = vi.fn(async () => jsonResponse({ ok: true }));
    await guardedGetJson(U, { fetchImpl: f as never });
    const names = Object.keys(init(f).headers as Record<string, string>).sort();
    expect(names).toEqual(['accept', 'user-agent']);
    expect(init(f).credentials).toBe('omit');
    expect(userAgent('equipe@example.invalid')).toMatch(/^QCMonsterVerifyBot\/1\.0 \(equipe@example\.invalid\) /);
  });
});
