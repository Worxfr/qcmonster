// Outils de test de la modification d'un cours (M1 #90): un cours confirme avec une fiche, une machine simulee etape par etape. Aucun reseau, aucun appel de modele reel.
import type { Ctx } from '../pipeline/ctx.js';
import { COURSE_LINES, event, goodScript, makeCtx, type Script } from '../pipeline/testkit.js';
import type { Item } from '../pipeline/ports.js';
import { keys } from '../../../shared/ddb/keys.js';
import { questionId } from '../../../shared/items.js';
import { reviseCancel } from './cancel.js';
import { reviseCreate } from './create.js';
import { reviseGet } from './get.js';
import { revCommit, revExtract, revFail, revGenerate, revPrepare } from './machine.js';
import { guarded } from '../pipeline/http.js';

export const COURS = 'COURS1';
export const DOC = 'DOC1';
export const MINIMAL = [...COURSE_LINES];

/** Extraction scriptee d'une phrase corrigee (p1-s2) et generation de ses questions: la numerotation de la fiche commence apres CLAIM#04. */
export const reviseScript = (over: Partial<Script> = {}): Script =>
  goodScript({
    extraction: JSON.stringify({ titre: 'x', matiere: 'svt', affirmations: [{ phraseId: 'p1-s2', extrait: 'chloroplastes des cellules', texte: 'La photosynthese se deroule dans les chloroplastes des cellules vegetales.', type: 'factuelle', aRisque: false }] }),
    generation: JSON.stringify({
      resume: 'Les plantes vertes fabriquent leur matiere.',
      qcm: [{ claimId: '05', enonce: 'Ou se deroule la photosynthese ?', choix: ['Dans les chloroplastes', 'Dans les racines', 'Dans le noyau', 'Dans le sol'], cle: 0 }],
      trous: [{ claimId: '05', phrase: 'La photosynthese se deroule dans les ____ des cellules vegetales.', attendu: 'chloroplastes' }],
    }),
    solve: JSON.stringify({ reponses: [{ n: 1, choix: 0 }] }),
    variantes: '{"qcm":[],"trous":[]}',
    ...over,
  });

/** Cours confirme `COURS1` (8 phrases, une section avec fiche `DOC1` de 4 affirmations verifiees, 4 QCM, 4 trous) et la fiche. `extra`: parties ignorees. */
export async function setup(over: Partial<Script> = {}, opts: { sections?: 'one' | 'two' } = {}) {
  const k = await makeCtx(reviseScript(over));
  const ctx: Ctx = { ...k.ctx, cfg: { reviseEnabled: true } };
  const db = k.db;
  const lines = MINIMAL;
  const two = opts.sections === 'two';
  const sentences = lines.map((text, n) => ({ id: `p1-s${n + 1}`, text }));
  await db.put({ ...keys.cours('s1', COURS), jobId: 'JOB0', jobIds: ['JOB0'], pages: 1, createdAt: '2026-12-01T09:00:00Z', nbPhrases: lines.length, sections: [{ fromSentenceId: 'p1-s1', subject: 'svt', ignore: false, statut: 'fiche', docId: DOC }, ...(two ? [{ fromSentenceId: 'p1-s7', subject: 'autre', ignore: true, statut: 'ignoree' }] : [])] });
  await db.put({ ...keys.coursText('s1', COURS, 1), page: 1, sentences });
  await db.put({ ...keys.coursBlocks('s1', COURS), blocks: [{ id: 'b1', kind: 'paragraphe', sentenceIds: sentences.slice(0, 6).map((s) => s.id) }, { id: 'b2', kind: 'paragraphe', sentenceIds: sentences.slice(6).map((s) => s.id) }], figures: [] });
  await db.put({ PK: 'STUDENT#s1', SK: 'JOB#JOB0', state: 'termine', kind: undefined, pages: 1 });
  await db.put({ ...keys.doc('s1', DOC), titre: 'Photosynthese', matiere: 'svt', coursId: COURS, familyId: 'f1', nbQuestions: 4, resume: 'ancien resume', body: [{ text: 'ancien' }], recall: [] });
  const phr = ['p1-s2', 'p1-s3', 'p1-s5', 'p1-s6'];
  for (const [n, p] of phr.entries()) {
    await db.put({ ...keys.claim(DOC, n + 1), texte: `Affirmation ${n + 1} du cours.`, origine: { page: 1, phraseId: p, extrait: 'x y' }, type: 'factuelle', aRisque: false });
    await db.put({ ...keys.verdict(DOC, n + 1), statut: 'verifiee', secondeLecture: false, sources: [] });
  }
  for (let n = 1; n <= 3; n++) {
    await db.put({ ...keys.qcm(DOC, n), questionId: questionId(DOC, 'qcm', n), enonce: `Q${n} ?`, choix: ['a', 'b', 'c', 'd'], cle: 0, claimId: String(n).padStart(2, '0') });
    await db.put({ ...keys.gap(DOC, n), questionId: questionId(DOC, 'gap', n), phrase: `Trou ${n} ____`, attendu: 'x', claimId: String(n).padStart(2, '0') });
  }
  return { ...k, ctx, db };
}

export const create = (ctx: Ctx, body: unknown, o: { sub?: string; groups?: string; coursId?: string } = {}) =>
  guarded(reviseCreate)(ctx, event({ sub: o.sub, groups: o.groups, params: { coursId: o.coursId ?? COURS }, body }));
export const get = (ctx: Ctx, revisionId: string, o: { sub?: string } = {}) => guarded(reviseGet)(ctx, event({ sub: o.sub, params: { coursId: COURS, revisionId } }));
export const cancel = (ctx: Ctx, revisionId: string) => guarded(reviseCancel)(ctx, event({ params: { coursId: COURS, revisionId } }));
export const bodyOf = (r: { body?: string }) => JSON.parse(r.body ?? '{}') as Record<string, unknown> & { revisionId: string };

/** Faux `verify-run`: un verdict `verifiee` par affirmation de la copie, avec un cout. */
export async function fakeVerify(ctx: Ctx, docId: string, coutMicros = 1000): Promise<void> {
  for (const c of (await ctx.db.query(`DOC#${docId}`, 'CLAIM#')).filter((x) => x.SK.startsWith('CLAIM#'))) {
    await ctx.db.put({ PK: c.PK, SK: c.SK.replace('CLAIM#', 'VERDICT#'), statut: 'verifiee', secondeLecture: false, sources: [], coutMicros });
  }
}

/** Rejoue la machine `revise` avec les vraies etapes (la simulation de l'infra rejoue la DEFINITION synthetisee). `stopAfter`: arret (plantage) apres cette etape. */
export async function runMachine(ctx: Ctx, revisionId: string, o: { stopAfter?: 'prepare' | 'extract' | 'verify' | 'generate' } = {}): Promise<void> {
  const ids = { revisionId, sid: 's1', fid: 'f1', coursId: COURS };
  try {
    const plan = await revPrepare(ctx, ids);
    if (o.stopAfter === 'prepare') return;
    for (const index of plan.indices) {
      const ex = await revExtract(ctx, { ...ids, index });
      if (o.stopAfter === 'extract') return;
      if (ex.claims > 0) await fakeVerify(ctx, ex.docId);
      if (o.stopAfter === 'verify') return;
      await revGenerate(ctx, { ...ids, index });
      if (o.stopAfter === 'generate') return;
    }
    await revCommit(ctx, ids);
  } catch {
    await revFail(ctx, ids);
  }
}

/** Instantane octet pour octet de tout ce qui est visible d'un cours et de sa fiche (hors job, compteurs et copie de travail). */
export function snapshot(db: { items: Map<string, Item> }): string {
  return JSON.stringify(
    [...db.items.values()]
      .filter((i) => /^(STUDENT#s1\|?)/.test(i.PK) ? /^(COURS#|DOC#|TEST#|ATT#|PROFILE)/.test(i.SK) : i.PK === `DOC#${DOC}`)
      .sort((a, b) => `${a.PK}${a.SK}`.localeCompare(`${b.PK}${b.SK}`)),
  );
}

export const correction = { corrections: [{ id: 'p1-s2', text: 'Elle se deroule dans les chloroplastes des cellules vegetales.' }] };
