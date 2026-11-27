// Outils de test du partage (S1 #34): base en memoire, horloge reglable, jeu de donnees minimal. Identifiants factices, aucun appel reel.
import { expect } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { HttpError } from '../lib/http.js';
import type { StudentCtx } from '../lib/http.js';
import { memoryDb, type Db } from '../pipeline/ports.js';
import { createShare } from './create.js';
import type { ShareCtx } from './ctx.js';

export const FID = 'fam1';
export const SID = 'stu1';
export const SUB = 'sub-stu1';
export const DOC = 'doc1';
export const student: StudentCtx = { sub: SUB, studentId: SID, familyId: FID };
export const parent = { sub: 'sub-par1', username: 'par1', familyId: FID };
export const otherFamilyParent = { sub: 'sub-par9', username: 'par9', familyId: 'fam9' };
export const otherStudent: StudentCtx = { sub: 'sub-stu2', studentId: 'stu2', familyId: FID }; // frere ou soeur, meme famille
export const strangerStudent: StudentCtx = { sub: 'sub-stu9', studentId: 'stu9', familyId: 'fam9' };

export interface Kit {
  db: ReturnType<typeof memoryDb>;
  ctx: ShareCtx;
  t: { ms: number };
  tokens: string[];
  with: (over: Partial<ShareCtx>) => ShareCtx;
}

export function kit(over: { publicEnabled?: boolean; db?: Db } = {}): Kit {
  const db = memoryDb();
  const t = { ms: Date.parse('2026-12-01T10:00:00Z') };
  let n = 0;
  const tokens: string[] = [];
  const ctx: ShareCtx = {
    db: over.db ?? db,
    env: 'dev',
    now: () => new Date(t.ms),
    newId: () => `01SHARE${String(++n).padStart(19, '0')}`,
    // 22 caracteres base64url, uniques
    newToken: () => {
      const tok = `tok${String(++n).padStart(6, '0')}ABCDEFGHIJKLM`.slice(0, 22);
      tokens.push(tok);
      return tok;
    },
    publicEnabled: over.publicEnabled ?? true,
  };
  return { db, ctx, t, tokens, with: (o) => ({ ...ctx, ...o }) };
}

type Put = Record<string, unknown> & { PK: string; SK: string };

/**
 * Famille, deux eleves (stu1 avec le partage ouvert, stu2), une famille etrangere, une fiche de stu1 avec `nQcm` QCM et `nGap` trous.
 * Les `paid` premieres questions (QCM d'abord) ont une ligne ATT `rewarded` (donc partageables).
 */
export async function seed(k: Kit, o: { nQcm?: number; nGap?: number; paid?: number; sharing?: boolean; docXp?: number; matiere?: string } = {}) {
  const put = (i: Put) => k.db.put(i);
  const nQcm = o.nQcm ?? 12;
  const nGap = o.nGap ?? 2;
  await put({ ...keys.family(FID), plafondPages: 50 });
  await put({ ...keys.student(FID, SID), loginId: 'lila-k7x2p', displayName: 'Lila', niveau: 'seconde', moins15: false, statut: 'actif', cognitoSub: SUB, ...(o.sharing === false ? {} : { sharing: true }) });
  await put({ ...keys.student(FID, 'stu2'), loginId: 'maxence-q8w3e', displayName: 'Maxence', niveau: 'seconde', moins15: false, statut: 'actif', cognitoSub: 'sub-stu2', sharing: true });
  await put({ ...keys.family('fam9'), plafondPages: 50 });
  await put({ ...keys.student('fam9', 'stu9'), loginId: 'zoe-a1b2c', displayName: 'Zoe', niveau: 'seconde', moins15: false, statut: 'actif', cognitoSub: 'sub-stu9', sharing: true });
  await put({ ...keys.doc(SID, DOC), titre: 'Fiche', matiere: o.matiere ?? 'svt', rev: 0, createdAt: '2026-11-01T10:00:00Z' });
  const ids: string[] = [];
  for (let i = 1; i <= nQcm; i++) {
    const nn = String(i).padStart(2, '0');
    await put({ ...keys.qcm(DOC, i), questionId: `${DOC}:qcm:${nn}`, enonce: `Question ${i} sur la cellule ?`, choix: [`A${i}`, `B${i}`, `C${i}`, `D${i}`], cle: i % 4, claimId: nn });
    ids.push(`${DOC}:qcm:${nn}`);
  }
  for (let i = 1; i <= nGap; i++) {
    const nn = String(i).padStart(2, '0');
    await put({ ...keys.gap(DOC, i), questionId: `${DOC}:gap:${nn}`, phrase: `La ____ ${i} produit de l'energie`, attendu: 'mitochondrie', claimId: nn });
    ids.push(`${DOC}:gap:${nn}`);
  }
  const paid = o.paid ?? 8;
  for (const q of ids.slice(0, paid)) await put({ ...keys.attempt(SID, q, '2026-11-20'), attempts: 1, done: true, rewarded: true, xp: o.docXp !== undefined ? 0 : 5 });
  if (o.docXp !== undefined) await put({ ...keys.attempt(SID, `${DOC}:qcm:99`, '2026-11-21'), attempts: 1, done: true, rewarded: true, xp: o.docXp });
  return { ids, paidIds: ids.slice(0, paid) };
}

export const body = (ids: string[], over: Record<string, unknown> = {}) => ({ docId: DOC, questionIds: ids, title: 'La cellule', ttlDays: 7, ...over });
export const snapshot = (k: Kit, pks: RegExp): string[] => [...k.db.items.entries()].filter(([id]) => pks.test(id)).map(([id, v]) => `${id}=${JSON.stringify(v)}`).sort();

const FAR = '2027-01-01T00:00:00.000Z';
/** Elements d'un lien deja cree (tests de suppression): copie (META, DAY#, REPORT#), reference de l'eleve, emplacement famille. `c` = un caractere hexadecimal (hache). */
export function plantedShare(fid: string, sid: string, docId: string, k: number, c: string): (Record<string, unknown> & { PK: string; SK: string })[] {
  const hash = c.repeat(64);
  return [
    { ...keys.share(hash), shareId: `S${c}${k}`, title: 'Titre', questions: [], createdAt: '2026-12-01T10:00:00.000Z', expiresAt: FAR, state: 'actif', reports: 0, docRev: 0, ttl: 1 },
    { ...keys.shareDay(hash, '2026-12-01'), n: 2, ttl: 1 },
    { ...keys.shareReport(hash, 'R1'), reason: 'autre', at: 'x', ttl: 1 },
    { ...keys.shareRef(sid, k), shareId: `S${c}${k}`, hash, docId, title: 'Titre', count: 5, createdAt: '2026-12-01T10:00:00.000Z', expiresAt: FAR, famSlot: k, ttl: 1 },
    { ...keys.shareSlot(fid, k), sid, expiresAt: FAR, ttl: 1 },
  ];
}

export const fails = async (p: Promise<unknown>, status: number, code?: string) => {
  const e = await p.then(() => undefined, (x: unknown) => x);
  expect(e, 'une HttpError etait attendue').toBeInstanceOf(HttpError);
  expect((e as HttpError).status).toBe(status);
  if (code) expect((e as HttpError).code).toBe(code);
  return e as HttpError;
};
/** Base qui echoue des qu'on la touche: prouve « aucune lecture ni ecriture ». */
export const untouchable = (): Db =>
  new Proxy({} as Db, {
    get: () => () => {
      throw new Error('acces a la base interdit');
    },
  });
export const make = async (o: Parameters<typeof seed>[1] = {}) => {
  const k = kit();
  const s = await seed(k, o);
  return { k, ...s };
};
export const create = (k: Kit, ids: string[], over: Record<string, unknown> = {}) => createShare(k.ctx, student, body(ids, over) as never);
