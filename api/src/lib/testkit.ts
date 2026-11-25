// Outils de test du lot L3: dependances en memoire, horloge reglable, jeu de donnees minimal. Aucune donnee reelle (identifiants factices).
import { keys } from '../../../shared/ddb/keys.js';
import { memoryQuotaDb, type QuotaDb } from '../../../shared/quota.js';
import type { FamilyDeps } from '../family/ports.js';
import type { Deps } from './deps.js';
import { memoryIdentity } from './identity.js';
import { memoryPhotos } from './photos.js';
import { memoryStore, storeTreeDb } from './store.js';

export interface Clock {
  t: number;
  now: () => Date;
  advance: (ms: number) => void;
  set: (iso: string) => void;
}
export const clock = (iso = '2026-12-01T10:00:00+01:00'): Clock => {
  const c: Clock = {
    t: new Date(iso).getTime(),
    now: () => new Date(c.t),
    advance: (ms) => {
      c.t += ms;
    },
    set: (i) => {
      c.t = new Date(i).getTime();
    },
  };
  return c;
};

export function testDeps(opts: { iso?: string; env?: 'dev' | 'prod' } = {}) {
  const store = memoryStore();
  const quota: QuotaDb = memoryQuotaDb();
  const clk = clock(opts.iso);
  let n = 0;
  const identity = memoryIdentity();
  const photos = memoryPhotos();
  const deps: FamilyDeps = {
    store,
    quota,
    env: opts.env ?? 'prod',
    now: clk.now,
    newId: () => `id${String(++n).padStart(4, '0')}`,
    newToken: () => `tok-${String(++n).padStart(4, '0')}-abcdefghijklmnopqrstuvwxyz`,
    suffix: () => `s${String(++n).padStart(3, '0')}`,
    identity,
    photos,
    tree: storeTreeDb(store),
    webOrigin: 'https://front.example.invalid',
  };
  return { deps: deps as FamilyDeps & Deps, store, clk, identity, photos, quota };
}
export type TestEnv = ReturnType<typeof testDeps>;

export const FID = 'fam1';
export const SID = 'stu1';
export const SUB = 'sub-stu1';
export const studentCtx = { sub: SUB, studentId: SID, familyId: FID };
export const parentCtx = { sub: 'sub-par1', username: 'par1', familyId: FID };

/** Famille, eleve actif, fiche avec `nQcm` QCM et `nGap` trous (affirmations 01..), verdicts « verifiee » sauf `badClaims`. */
export async function seed(
  t: TestEnv,
  o: { fid?: string; sid?: string; docId?: string; nQcm?: number; nGap?: number; matiere?: string; pages?: number; doublon?: boolean; createdAt?: string; badClaims?: number[]; status?: string } = {},
) {
  const fid = o.fid ?? FID;
  const sid = o.sid ?? SID;
  const docId = o.docId ?? 'doc1';
  const s = t.store;
  const put = (item: Record<string, unknown> & { PK: string; SK: string }) => s.commit([{ item, when: 'any' }]);
  await put({ ...keys.family(fid), plafondPages: 50, ownerSub: 'sub-par1' });
  await put({ ...keys.student(fid, sid), pseudo: 'Pseudo-1abc', niveau: 'seconde', moins15: false, statut: o.status ?? 'actif', cognitoSub: `sub-${sid}`, quotaPages: 20 });
  await put({ ...keys.doc(sid, docId), titre: 'Titre', matiere: o.matiere ?? 'svt', pagesConsommees: o.pages ?? 2, doublon: o.doublon ?? false, createdAt: o.createdAt ?? t.clk.now().toISOString(), GSI1PK: `FAMILY#${fid}`, GSI1SK: 'DOC#2026-12-01' });
  const n = o.nQcm ?? 12;
  for (let i = 1; i <= n; i++) {
    const nn = String(i).padStart(2, '0');
    await put({ ...keys.qcm(docId, i), questionId: `${docId}:qcm:${nn}`, enonce: `Question ${i} ?`, choix: ['A', 'B', 'C', 'D'], cle: 1, claimId: nn });
    await put({ ...keys.verdict(docId, i), statut: (o.badClaims ?? []).includes(i) ? 'erreur' : 'verifiee', secondeLecture: false, sources: [] });
  }
  for (let i = 1; i <= (o.nGap ?? 0); i++) {
    const nn = String(i).padStart(2, '0');
    await put({ ...keys.gap(docId, i), questionId: `${docId}:gap:${nn}`, phrase: `Le ____ ${i}`, attendu: 'Énergie', claimId: nn });
  }
  return { fid, sid, docId, ctx: { sub: `sub-${sid}`, studentId: sid, familyId: fid } };
}

export const qid = (docId: string, kind: 'qcm' | 'gap', nn: number) => `${docId}:${kind}:${String(nn).padStart(2, '0')}`;
