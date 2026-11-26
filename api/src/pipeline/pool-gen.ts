// Q1 (docs/Q1-design.md section 4): second tour de generation, la « banque » de questions. Un appel `variantes` puis un controle a l'aveugle
// des nouveaux QCM; tout le reste (validation, proximite, numerotation) est fait par le code. Toute erreur d'APPEL DE MODELE est absorbee:
// la fiche est publiee avec la banque du premier tour (sinon Step Functions rejouerait `generate` et repayerait le premier tour).
import { z } from 'zod';
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema, questionId } from '../../../shared/items.js';
import { sanitizeLatex } from '../../../shared/latex.js';
import { log } from '../../../shared/log/index.js';
import { closeness, poolCap, type PoolQuestion } from '../../../shared/pool.js';
import { callModel, type Ctx } from './ctx.js';
import { SYSTEM_JSON, solvePrompt, variantsPrompt } from './prompts.js';
import { shuffleChoices, validGap, validQcm, type EligibleClaim } from './steps-doc.js';
import { ModelOutputError, parseModelJson, salvageTruncatedList } from './text.js';

export const SECOND_ROUND_MAX_ELAPSED_MS = 120_000; // la moitie des 240 s de `generate`
export const MAX_NN = 99; // limite du format `[0-9]{2}`

export interface PoolQcm { claimId: string; enonce: string; choix: string[]; cle: number }
export interface PoolGap { claimId: string; phrase: string; attendu: string }

const VarQcm = z.object({ claimId: z.string(), enonce: z.string(), choix: z.array(z.string()), cle: z.number().int() });
const VarGap = z.object({ claimId: z.string(), phrase: z.string(), attendu: z.string() });
const VarOut = z.object({ qcm: z.array(VarQcm).max(60), trous: z.array(VarGap).max(60) });
const SolveOut = z.object({ reponses: z.array(z.object({ n: z.number().int(), choix: z.number().int() })).max(40) });

const asPool = {
  qcm: (docId: string, q: PoolQcm, id: string): PoolQuestion => ({ id, docId, claimId: q.claimId, kind: 'qcm', texte: q.enonce, reponse: q.choix[q.cle] ?? '' }),
  gap: (docId: string, g: PoolGap, id: string): PoolQuestion => ({ id, docId, claimId: g.claimId, kind: 'gap', texte: g.phrase, reponse: g.attendu }),
};

/** Sortie du modele: JSON complet, sinon (sortie coupee par la limite de jetons) les objets entiers deja ecrits. */
function readVariants(raw: string): z.infer<typeof VarOut> {
  try {
    return parseModelJson(raw, VarOut);
  } catch (e) {
    if (!(e instanceof ModelOutputError)) throw e;
    const list = <T>(key: string, s: z.ZodType<T>): T[] => (salvageTruncatedList(raw, key) ?? []).flatMap((x) => { const r = s.safeParse(x); return r.success ? [r.data] : []; });
    const out = { qcm: list('qcm', VarQcm), trous: list('trous', VarGap) };
    if (out.qcm.length + out.trous.length === 0) throw e;
    return out;
  }
}

/** Retire les questions trop proches d'une deja retenue (ou d'une precedente de la meme liste). */
export function dropClose<T>(items: T[], make: (x: T, k: number) => PoolQuestion, kept: PoolQuestion[]): T[] {
  const out: T[] = [];
  const all = [...kept];
  items.forEach((x, k) => {
    const p = make(x, k);
    if (all.some((o) => closeness(o, p))) return;
    all.push(p);
    out.push(x);
  });
  return out;
}

/** Ecrit `items` a partir de `max(nn)+1` (jamais d'ecrasement: `attribute_not_exists`), s'arrete a 99. Renvoie le nombre ecrit. */
async function writeFrom(ctx: Ctx, docId: string, kind: 'qcm' | 'gap', items: (PoolQcm | PoolGap)[]): Promise<number> {
  const prefix = kind === 'qcm' ? 'QCM#' : 'GAP#';
  let nn = (await ctx.db.query(`DOC#${docId}`, prefix)).reduce((m, x) => Math.max(m, Number(x.SK.slice(prefix.length)) || 0), 0) + 1;
  let n = 0;
  for (const it of items) {
    for (; nn <= MAX_NN; nn++) {
      const qid = questionId(docId, kind, nn);
      const item =
        kind === 'qcm'
          ? (() => {
              const q = it as PoolQcm;
              const sh = shuffleChoices(q.choix, q.cle, qid);
              return QcmItemSchema.parse({ ...keys.qcm(docId, nn), questionId: qid, enonce: sanitizeLatex(q.enonce.trim()), choix: sh.choix.map((c) => sanitizeLatex(c)), cle: sh.cle, claimId: q.claimId });
            })()
          : GapItemSchema.parse({ ...keys.gap(docId, nn), questionId: qid, phrase: sanitizeLatex((it as PoolGap).phrase.trim()), attendu: (it as PoolGap).attendu.trim(), claimId: it.claimId });
      if (await ctx.db.put(item, true)) {
        n++;
        nn++;
        break;
      }
    }
    if (nn > MAX_NN) break;
  }
  return n;
}

/**
 * Second tour. `first` = questions du premier tour deja ecrites. Renvoie le nombre de questions ajoutees (QCM, trous).
 * Pas de second tour sans fait verifie, sans question au premier tour, ni apres 120 s de `generate` (`startedMs`).
 */
export async function addVariants(
  ctx: Ctx,
  i: { sid: string; jobId: string },
  docId: string,
  eligible: Map<string, EligibleClaim>,
  first: { qcm: PoolQcm[]; gaps: PoolGap[] },
  startedMs: number,
): Promise<{ qcm: number; gaps: number }> {
  const none = { qcm: 0, gaps: 0 };
  if (eligible.size === 0 || first.qcm.length + first.gaps.length === 0) return none;
  if (ctx.now().getTime() - startedMs > SECOND_ROUND_MAX_ELAPSED_MS) return none;
  const cap = poolCap(eligible.size);
  const kept: PoolQuestion[] = [...first.qcm.map((q, k) => asPool.qcm(docId, q, `1q${k}`)), ...first.gaps.map((g, k) => asPool.gap(docId, g, `1g${k}`))];
  let cand: z.infer<typeof VarOut>;
  try {
    const deja = [...first.qcm.map((q) => q.enonce), ...first.gaps.map((g) => g.phrase)];
    const raw = await callModel(ctx, i, 'variantes', 'haiku', { system: SYSTEM_JSON, prompt: variantsPrompt([...eligible.values()], deja, cap), maxTokens: 6000 });
    cand = readVariants(raw);
  } catch (e) {
    log({ jobId: i.jobId, step: 'variantes', status: 'error', errorCode: e instanceof Error ? e.name : 'inconnue' }); // jamais le texte
    return none;
  }
  let qcm = dropClose(cand.qcm.filter((q) => validQcm(q, eligible)), (q, k) => asPool.qcm(docId, q, `2q${k}`), kept).slice(0, Math.max(0, cap - first.qcm.length));
  const gaps = dropClose(cand.trous.filter((g) => validGap(g, eligible)), (g, k) => asPool.gap(docId, g, `2g${k}`), [...kept, ...qcm.map((q, k) => asPool.qcm(docId, q, `2q${k}`))]).slice(0, Math.max(0, cap - first.gaps.length));
  if (qcm.length) {
    try {
      const prompt = solvePrompt(qcm.map((q, k) => ({ n: k + 1, claim: eligible.get(q.claimId)!.texte, enonce: q.enonce, choix: q.choix })));
      const solved = parseModelJson(await callModel(ctx, i, 'controle-qcm', 'haiku', { system: SYSTEM_JSON, prompt, maxTokens: 1000 }), SolveOut);
      const answers = new Map(solved.reponses.map((r) => [r.n, r.choix]));
      qcm = qcm.filter((q, k) => answers.get(k + 1) === q.cle);
    } catch (e) {
      log({ jobId: i.jobId, step: 'controle-qcm', status: 'error', errorCode: e instanceof Error ? e.name : 'inconnue' });
      qcm = []; // aucun QCM non controle n'est publie
    }
  }
  return { qcm: await writeFrom(ctx, docId, 'qcm', qcm), gaps: await writeFrom(ctx, docId, 'gap', gaps) };
}
