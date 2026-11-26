// Generation d'un exercice (E1, Lambda `exo-gen`, role `exo-role`: Haiku seulement). Deux appels: ecrire, puis resoudre A L'AVEUGLE (l'enonce seul);
// le CODE compare le resultat final. Un exercice non confirme n'est jamais propose. Ecrit EXO# (attribute_not_exists) puis passe EXOP a `prete` ou `echec`.
import { z } from 'zod';
import { createHash } from 'node:crypto';
import { CostBlockedError, JobBudgetExceededError } from '../../../shared/bedrock.js';
import { toMicros } from '../../../shared/cost.js';
import { keys } from '../../../shared/ddb/keys.js';
import { retiredClaims } from '../../../shared/items.js';
import { ExoDraftSchema, checkDraft, closeTo, norm, type ExoDraft } from '../../../shared/exo.js';
import { EXO_GEN_COST_CAP_EUR } from '../../../shared/names.js';
import { contentWords } from '../../../shared/pool.js';
import type { Deps } from '../lib/deps.js';
import type { Item } from '../lib/store.js';
import { exoSolvePrompt, exoWritePrompt } from '../pipeline/prompts-exo.js';
import { ModelOutputError, modelCaller, parseJson, type ModelDeps } from './model.js';
import type { GenInput } from './ports.js';

const SolveSchema = z.object({ valeur: z.union([z.number(), z.string()]) });
const toNumber = (v: number | string): number => (typeof v === 'number' ? v : Number(String(v).replace(/\s/g, '').replace(',', '.')));
export const sigOf = (enonce: string): string => createHash('sha256').update(norm(enonce)).digest('hex').slice(0, 32);

const jaccard = (a: Set<string>, b: Set<string>): number => {
  let inter = 0;
  for (const w of a) if (b.has(w)) inter++;
  return a.size + b.size === 0 ? 0 : inter / (a.size + b.size - inter);
};
/** Enonce deja fait sur la fiche: meme empreinte, ou plus de 60 % de mots utiles en commun. */
export const isDuplicate = (enonce: string, deja: string[]): boolean => {
  const sig = sigOf(enonce);
  const w = contentWords(enonce);
  return deja.some((d) => sigOf(d) === sig || jaccard(w, contentWords(d)) >= 0.6);
};

async function finish(deps: Deps, input: GenInput, etat: 'prete' | 'echec', write?: { item: Item }): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    const p = await deps.store.get(keys.exop(input.sid, input.docId, input.nn));
    if (!p) return;
    // Fiche: compteur `nbExercices` (DocSummary.exerciceCount), un nombre jamais un contenu.
    const fiche = write ? await deps.store.get(keys.doc(input.sid, input.docId)) : undefined;
    const ok = await deps.store.commit([
      ...(write ? [{ item: write.item, when: 'absent' as const }] : []),
      ...(fiche ? [{ item: { ...fiche, nbExercices: (typeof fiche.nbExercices === 'number' ? fiche.nbExercices : 0) + 1 }, when: fiche.v ?? ('any' as const) }] : []),
      { item: { ...p, etat }, when: p.v ?? 'any' },
    ]);
    if (ok) return;
    if (write && (await deps.store.get(write.item))) return; // EXO# existe deja (rejeu): rien a refaire
  }
  throw new Error('exo-gen: conflit persistant');
}

/** Resultat: `ignore` si la progression n'est plus en generation (rejeu, ou perimee), sinon `prete` ou `echec`. */
export async function generateExo(deps: Deps & ModelDeps, input: GenInput): Promise<'prete' | 'echec' | 'ignore'> {
  const p = await deps.store.get(keys.exop(input.sid, input.docId, input.nn));
  if (!p || p.etat !== 'generation') return 'ignore';
  const ref = `exo-${input.docId}-${input.nn}`;
  const caller = modelCaller(deps, ref, EXO_GEN_COST_CAP_EUR);
  try {
    const gone = retiredClaims(await deps.store.get(keys.doc(input.sid, input.docId))); // M1 #90: pas d'exercice sur une affirmation retiree
    const verdicts = (await deps.store.query(`DOC#${input.docId}`, 'VERDICT#')).filter((v) => v.statut === 'verifiee' && !gone.has(Number(String(v.SK).slice('VERDICT#'.length))));
    const claims = (
      await Promise.all(verdicts.map(async (v) => {
        const nn = String(v.SK).slice('VERDICT#'.length);
        const c = await deps.store.get({ PK: `DOC#${input.docId}`, SK: `CLAIM#${nn}` });
        return c && typeof c.texte === 'string' ? { id: nn, texte: c.texte } : undefined;
      }))
    ).filter((c): c is { id: string; texte: string } => c !== undefined);
    const fiche = await deps.store.get(keys.doc(input.sid, input.docId));
    if (claims.length < 2 || !fiche) {
      await finish(deps, input, 'echec');
      return 'echec';
    }
    const deja = (await deps.store.query(`DOC#${input.docId}`, 'EXO#')).map((e) => String(e.enonce ?? ''));
    let good: ExoDraft | undefined;
    for (let attempt = 0; attempt < 2 && !good; attempt++) {
      let d: ExoDraft;
      try {
        d = parseJson(await caller.call('haiku', 'exo-ecrire', { prompt: exoWritePrompt({ matiere: String(fiche.matiere), claims, deja }), maxTokens: 3000 }), ExoDraftSchema);
      } catch (e) {
        if (e instanceof ModelOutputError) continue;
        throw e;
      }
      const ids = new Set(claims.map((c) => c.id.replace(/^0+/, '') || '0'));
      d.claimIds = d.claimIds.filter((c) => ids.has(c.replace(/^0+/, '') || '0'));
      if (d.claimIds.length === 0 || checkDraft(d) || isDuplicate(d.enonce, deja)) continue;
      let solved: number;
      try {
        solved = toNumber(parseJson(await caller.call('haiku', 'exo-resoudre', { prompt: exoSolvePrompt(d.enonce), maxTokens: 1500 }), SolveSchema).valeur);
      } catch (e) {
        if (e instanceof ModelOutputError) continue;
        throw e;
      }
      if (Number.isFinite(solved) && closeTo(solved, d.finale.num.v, d.finale.num.tolRel)) good = d; // sinon: rejete, une seule regeneration
    }
    if (!good) {
      await finish(deps, input, 'echec');
      return 'echec';
    }
    const item = { ...keys.exo(input.docId, input.nn), v: 0, matiere: fiche.matiere, titre: good.titre, enonce: good.enonce, niveau: good.niveau, etapes: good.etapes, finale: good.finale, indices: good.indices, solution: good.solution, claimIds: good.claimIds, sig: sigOf(good.enonce), createdAt: deps.now().toISOString(), coutMicros: toMicros(caller.spentEur) };
    await finish(deps, input, 'prete', { item });
    return 'prete';
  } catch (e) {
    if (e instanceof JobBudgetExceededError || e instanceof CostBlockedError) {
      await finish(deps, input, 'echec');
      return 'echec';
    }
    throw e;
  }
}
