// verify-run: etapes 7 a 10 pour un document (design-v2 4.1, revue B4). Entree {jobId, docId, budgetRestantCentimes}, sortie avec SON cout.
// Ecrit VERDICT#<nn>, PASSAGE#, CLAIMCACHE#. Ne modifie jamais CLAIM# (ecrit par L2a). Aucun texte de cours dans les journaux.
import { CostBlockedError, invokeModel, JobBudgetExceededError, type CostStore, type ModelPort } from '../../../shared/bedrock.js';
import { JOB_COST_CAP_EUR } from '../../../shared/names.js';
import { costEur } from '../../../shared/pricing.js';
import { log } from '../../../shared/log/index.js';
import type { VerifyInput, VerifyOutput } from '../../../shared/items.js';
import { checkVerdict, judgePrompt, mergeSecondRead, needsSecondRead, parseVerdicts, secondReadPrompt, type Checked, type JudgeClaim } from './judge.js';
import { CLAIMS_PER_CALL } from './limits.js';
import type { Passage, SearchPort } from './search.js';
import { fingerprint, type ClaimItem, type VerdictBody, type VerifyStore } from './store.js';

export interface VerifyDeps {
  store: VerifyStore;
  search: SearchPort;
  model: { port: ModelPort; costStore: CostStore; arn: string };
}

const MAX_TOKENS = 4096;
type Final = VerdictBody;
const nonVerifiable: Final = { statut: 'non_verifiable', secondeLecture: false, sources: [] };

interface Work {
  nn: number;
  claim: ClaimItem;
  passages: Passage[];
  checked?: Checked;
  secondRead?: boolean;
  final?: Final;
}

/** Une affirmation `non_factuelle` (consigne, opinion, exercice) n'a rien a verifier. Le type est ecrit par L2a a l'etape 5. */
const isNonFactual = (c: ClaimItem): boolean => normalizeType(c.type) === 'non_factuelle';
const normalizeType = (t: string) => t.toLowerCase().replace(/[\s-]+/g, '_');

const chunks = <T>(a: T[], n: number): T[][] => Array.from({ length: Math.ceil(a.length / n) }, (_, i) => a.slice(i * n, i * n + n));

export async function verifyClaims(deps: VerifyDeps, input: VerifyInput): Promise<{ verdicts: Map<number, Final>; costEur: number }> {
  const { store, search, model } = deps;
  const capEur = Math.min(input.budgetRestantCentimes / 100, JOB_COST_CAP_EUR);
  let spent = 0;
  let stopped = false;
  const call = async (p: { system: string; prompt: string }, step: string): Promise<string | null> => {
    if (stopped) return null;
    // Estimation prudente (1 token pour 2 caracteres en entree, sortie maximale): un appel qui depasserait le reste du budget n'est pas emis.
    const est = costEur('sonnet-5.5', { inputTokens: Math.ceil((p.prompt.length + p.system.length) / 2), outputTokens: MAX_TOKENS });
    if (spent + est > capEur) {
      stopped = true;
      return null;
    }
    try {
      const r = await invokeModel({ model: 'sonnet-5.5', jobId: input.jobId, step, request: { modelArn: model.arn, system: p.system, prompt: p.prompt, maxTokens: MAX_TOKENS }, store: model.costStore, port: model.port, jobSpentEur: spent, jobCapEur: capEur });
      spent += r.costEur;
      return r.text;
    } catch (e) {
      if (e instanceof JobBudgetExceededError || e instanceof CostBlockedError) {
        stopped = true; // les affirmations restantes sont non_verifiable
        return null;
      }
      throw e;
    }
  };

  const verdicts = new Map<number, Final>(); // verdicts de ce passage; ceux deja ecrits sont repris tels quels (reprise apres Retry)
  const existing = await store.listVerdicts(input.docId);
  const claims = (await store.listClaims(input.docId)).filter((c) => !existing.has(c.nn));
  const factual: Work[] = [];
  for (const { nn, claim } of claims) {
    if (isNonFactual(claim)) verdicts.set(nn, { statut: 'non_factuelle', secondeLecture: false, sources: [] });
    else factual.push({ nn, claim, passages: [] });
  }

  // Etape 7: cache d'abord, puis recherche (en serie: l'outil espace ses requetes).
  const toJudge: Work[] = [];
  for (const w of factual) {
    const hit = await cacheHit(store, w.claim);
    if (hit) {
      verdicts.set(w.nn, hit);
      continue;
    }
    w.passages = await search.search(w.claim.texte);
    if (w.passages.length === 0) verdicts.set(w.nn, nonVerifiable);
    else toJudge.push(w);
  }

  // Etapes 8 et 9: jugement par lots de 25 (affirmations a risque d'abord: elles passent avant l'arret du budget), puis controle par code.
  toJudge.sort((a, b) => Number(b.claim.aRisque) - Number(a.claim.aRisque));
  const asJudge = (batch: Work[]): JudgeClaim[] => batch.map((w, i) => ({ alias: `C${i + 1}`, texte: w.claim.texte, passages: w.passages.map((p, j) => ({ alias: `P${j + 1}`, passage: p })) }));
  for (const batch of chunks(toJudge, CLAIMS_PER_CALL)) {
    const jc = asJudge(batch);
    const text = await call(judgePrompt(jc), 'verify-judge');
    const raw = text === null ? new Map() : parseVerdicts(text);
    batch.forEach((w, i) => {
      w.checked = checkVerdict(jc[i], raw.get(jc[i].alias));
    });
  }

  // Etape 10: seconde lecture des `erreur` et des `verifiee` a risque.
  const second = toJudge.filter((w) => w.checked && needsSecondRead(w.checked, w.claim.aRisque));
  for (const batch of chunks(second, CLAIMS_PER_CALL)) {
    const jc = asJudge(batch);
    const text = await call(secondReadPrompt(jc), 'verify-second');
    const raw = text === null ? new Map() : parseVerdicts(text);
    batch.forEach((w, i) => {
      w.checked = mergeSecondRead(w.checked!, checkVerdict(jc[i], raw.get(jc[i].alias)));
      w.secondRead = true;
    });
  }

  // Ecriture: passages d'abord (toute source cite un passage stocke), puis verdicts, puis cache.
  for (const w of toJudge) {
    const c = w.checked ?? { statut: 'non_verifiable' as const, sources: [] };
    w.final = c.statut === 'non_verifiable' ? nonVerifiable : { statut: c.statut, niveau: c.niveau, secondeLecture: Boolean(w.secondRead), sources: c.sources };
    verdicts.set(w.nn, w.final);
  }
  const used = new Map<string, Passage>();
  for (const w of toJudge) for (const s of w.final?.sources ?? []) used.set(s.passageId, w.passages.find((p) => p.id === s.passageId)!);
  await store.putPassages([...used.values()]);
  for (const [nn, v] of verdicts) await store.putVerdict(input.docId, nn, v);
  for (const w of toJudge) {
    const f = w.final!;
    if ((f.statut === 'verifiee' || f.statut === 'erreur') && f.niveau) {
      await store.putCache(fingerprint(w.claim.texte), { statut: f.statut, niveau: f.niveau, secondeLecture: f.secondeLecture, passageIds: f.sources.map((s) => s.passageId), sources: f.sources });
    }
  }
  return { verdicts, costEur: spent };
}

/** Verdict en cache reutilisable: les passages cites existent encore (TTL) et, pour une affirmation a risque, une seconde lecture a eu lieu. */
async function cacheHit(store: VerifyStore, claim: ClaimItem): Promise<Final | undefined> {
  const c = await store.getCache(fingerprint(claim.texte));
  if (!c || c.sources.length === 0 || (claim.aRisque && !c.secondeLecture)) return undefined;
  const stored = new Map((await store.getPassages(c.passageIds)).map((p) => [p.id, p]));
  const sources = c.sources.map((s) => {
    const p = stored.get(s.passageId);
    return p ? { ...s, url: p.url, site: p.site, titre: p.titre, niveau: p.niveau as 1 | 2 | 3 } : undefined;
  });
  if (sources.some((s) => !s)) return undefined;
  return { statut: c.statut, niveau: c.niveau, secondeLecture: c.secondeLecture, sources: sources as Final['sources'] };
}

/** Point d'entree de la Lambda (testable sans AWS). */
export async function verifyRun(deps: VerifyDeps, input: VerifyInput): Promise<VerifyOutput> {
  const t0 = Date.now();
  const { costEur } = await verifyClaims(deps, input);
  const all = await deps.store.listVerdicts(input.docId);
  const count = (s: string) => [...all.values()].filter((v) => v.statut === s).length;
  const out: VerifyOutput = { coutCentimes: Math.max(0, Math.ceil(costEur * 100 - 1e-9)), nbVerifiees: count('verifiee'), nbErreurs: count('erreur'), nbNonVerifiables: count('non_verifiable') };
  log({ jobId: input.jobId, step: 'verify-run', status: 'ok', durationMs: Date.now() - t0, costEur });
  return out;
}
