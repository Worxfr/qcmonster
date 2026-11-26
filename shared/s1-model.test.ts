// S1-K (#34): cles et schemas du partage de QCM. Aucun handler: seulement la forme des elements.
import { describe, expect, it } from 'vitest';
import { keys, sha256 } from './ddb/keys.js';
import { ShareItemSchema, ShareRefItemSchema, ShareSlotItemSchema, StudentSharingSchema } from './items.js';

const h = sha256('AbCdEfGhIjKlMnOpQrStUv');
const q = (n: number) => ({ kind: 'qcm' as const, prompt: `Question ${n} ?`, choices: ['a', 'b', 'c', 'd'], answer: 1 });
const meta = { ...keys.share(h), shareId: 'S1', title: 'Cours', questions: [1, 2, 3, 4, 5].map(q), createdAt: '2026-12-01T10:00:00Z', expiresAt: '2026-12-08T10:00:00Z', state: 'actif', reports: 0, docRev: 0, ttl: 1 };

describe('S1-K: cles et schemas du partage', () => {
  it('les cles du partage sont dans la partition SHARE# (publique) ou dans celles de l\'eleve et de la famille', () => {
    expect(keys.share(h)).toEqual({ PK: `SHARE#${h}`, SK: 'META' });
    expect(keys.shareDay(h, '2026-12-01')).toEqual({ PK: `SHARE#${h}`, SK: 'DAY#2026-12-01' });
    expect(keys.shareReport(h, 'R1')).toEqual({ PK: `SHARE#${h}`, SK: 'REPORT#R1' });
    expect(keys.shareRef('s1', 3)).toEqual({ PK: 'STUDENT#s1', SK: 'SHAREREF#3' });
    expect(keys.shareSlot('f1', 10)).toEqual({ PK: 'FAMILY#f1', SK: 'SHARESLOT#10' });
    expect(keys.shareCreateDay('s1', '2026-12-01')).toEqual({ PK: 'STUDENT#s1', SK: 'SHAREJ#2026-12-01' });
  });
  it('la copie accepte 5 a 20 questions et n\'a aucun champ d\'identite', () => {
    expect(ShareItemSchema.safeParse(meta).success).toBe(true);
    expect(ShareItemSchema.safeParse({ ...meta, questions: meta.questions.slice(1) }).success).toBe(false);
    expect(ShareItemSchema.safeParse({ ...meta, questions: Array.from({ length: 21 }, (_, k) => q(k)) }).success).toBe(false);
    expect(Object.keys(ShareItemSchema.shape)).not.toEqual(expect.arrayContaining(['sid']));
    for (const k of ['sid', 'fid', 'docId', 'familyId', 'studentId']) expect(Object.keys(ShareItemSchema.shape)).not.toContain(k);
    expect(ShareItemSchema.safeParse({ ...meta, PK: 'SHARE#jeton-en-clair' }).success).toBe(false); // seul le hache est une cle
  });
  it('references: emplacements 1 a 5 (eleve) et 1 a 10 (famille); `sharing` facultatif', () => {
    const ref = { ...keys.shareRef('s1', 5), shareId: 'S1', hash: h, docId: 'd1', title: 'Cours', count: 5, createdAt: 'x', expiresAt: 'y', famSlot: 10, ttl: 1 };
    expect(ShareRefItemSchema.safeParse(ref).success).toBe(true);
    expect(ShareRefItemSchema.safeParse({ ...ref, SK: 'SHAREREF#6' }).success).toBe(false);
    expect(ShareSlotItemSchema.safeParse({ ...keys.shareSlot('f1', 10), sid: 's1', expiresAt: 'y', ttl: 1 }).success).toBe(true);
    expect(ShareSlotItemSchema.safeParse({ ...keys.shareSlot('f1', 11), sid: 's1', expiresAt: 'y', ttl: 1 }).success).toBe(false);
    expect(StudentSharingSchema.parse({}).sharing).toBeUndefined();
  });
});
