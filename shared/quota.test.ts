import { describe, expect, it } from 'vitest';
import { consumePages, memoryQuotaDb, releasePages, reservePages, type QuotaScope } from './quota.js';
import { quotaDefaults } from './names.js';

const scope = (sid: string, over: Partial<QuotaScope> = {}): QuotaScope => ({ familyId: 'f1', studentId: sid, month: '2026-12', studentLimit: 20, familyLimit: 50, ...over });

describe('quota de pages', () => {
  it('50 reservations concurrentes d\'une page pour 20 pages donnent exactement 20 reussites (acceptation L1 n.5)', async () => {
    const db = memoryQuotaDb();
    const results = await Promise.all(Array.from({ length: 50 }, () => reservePages(db, scope('s1'), 1)));
    expect(results.filter(Boolean)).toHaveLength(20);
  });
  it('le plafond famille (50) borne la somme des eleves', async () => {
    const db = memoryQuotaDb();
    const r = await Promise.all(Array.from({ length: 60 }, (_, i) => reservePages(db, scope(`s${i % 3}`, { studentLimit: 30 }), 1)));
    expect(r.filter(Boolean)).toHaveLength(50);
  });
  it('un refus ne modifie aucun compteur (tout ou rien)', async () => {
    const db = memoryQuotaDb();
    expect(await reservePages(db, scope('s1'), 20)).toBe(true);
    expect(await reservePages(db, scope('s1'), 1)).toBe(false);
    expect(db.items.get('FAMILY#f1|QUOTA#2026-12#FAMILY')?.restant).toBe(30);
  });
  it('rendre puis reserver; consommer ne rend rien', async () => {
    const db = memoryQuotaDb();
    await reservePages(db, scope('s1'), 20);
    await releasePages(db, scope('s1'), 5);
    expect(await reservePages(db, scope('s1'), 5)).toBe(true);
    await consumePages(db, scope('s1'), 20);
    expect(await reservePages(db, scope('s1'), 1)).toBe(false);
    expect(db.items.get('FAMILY#f1|QUOTA#2026-12#s1')).toMatchObject({ utilise: 20, reserve: 0, restant: 0 });
  });
  it('refuse un nombre de pages invalide', async () => {
    await expect(reservePages(memoryQuotaDb(), scope('s1'), 0)).rejects.toThrow(RangeError);
  });
  it('quotas par defaut: 20/50 en prod, x10 en dev', () => {
    expect(quotaDefaults('prod')).toEqual({ studentPages: 20, familyPages: 50 });
    expect(quotaDefaults('dev')).toEqual({ studentPages: 200, familyPages: 500 });
  });
});
