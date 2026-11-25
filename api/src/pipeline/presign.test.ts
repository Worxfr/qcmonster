import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { s3Store } from './entry.js';

// B4: la politique du POST pre-signe fixe la cle (un seul objet, nom choisi par le serveur), le type et la taille.
describe('POST pre-signe des scans', () => {
  const saved = { ...process.env };
  beforeEach(() => {
    process.env.AWS_ACCESS_KEY_ID = 'AKIDEXAMPLE0000000000'; // factice: la signature est locale, aucun appel reseau
    process.env.AWS_SECRET_ACCESS_KEY = 'secret-factice-pour-test-hors-ligne';
    process.env.AWS_REGION = 'eu-west-3';
  });
  afterEach(() => {
    process.env = { ...saved };
  });
  it('impose la cle exacte, le type et la taille, sans prefixe ouvert', async () => {
    const store = await s3Store('bucket-de-test');
    const p = await store.presignPost({ prefix: 'scans/s1/j1/', firstKey: 'scans/s1/j1/0', contentType: 'image/jpeg', maxBytes: 5242880, expiresSec: 900 });
    expect(p.fields.key).toBe('scans/s1/j1/0');
    const policy = JSON.parse(Buffer.from(p.fields.Policy ?? p.fields.policy, 'base64').toString('utf8')) as { conditions: unknown[] };
    const flat = JSON.stringify(policy.conditions);
    expect(flat).toMatch(/\{"key":"scans\/s1\/j1\/0"\}|\["eq","\$key","scans\/s1\/j1\/0"\]/); // forme objet ou eq: les deux fixent la cle exacte
    expect(flat).toContain('["eq","$Content-Type","image/jpeg"]');
    expect(flat).toContain('["content-length-range",1,5242880]');
    expect(flat).not.toContain('starts-with');
  });
});
