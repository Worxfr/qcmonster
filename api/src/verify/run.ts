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
const CHARS_PER_TOKEN = 3.5;
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

export async function verifyClaims(deps: VerifyDeps, input: VerifyInput): Promise<{ costEur: number }> {
  const { store, search, model } = deps;
  const capEur = Math.min(input.budgetRestantCentimes / 100, JOB_COST_CAP_EUR);
  const existing = await store.listVerdicts(input.docId);
  // Cout deja depense par les tentatives precedentes (porte par les verdicts ecrits): le plafond du job vaut pour le cumul des tentatives.
  let spent = [...existing.values()].reduce((n, v) => n + (v.coutMicros ?? 0), 0) / 1e6;
  let stopped = false;
  const call = async (p: { system: string; prompt: string }, step: string, nClaims: number): Promise<string | null> => {
    if (stopped) return null;
    // Estimation: 3,5 caracteres par token en entree (francais), sortie attendue 120 tokens par affirmation (au plus MAX_TOKENS).
    // Un appel qui depasserait le reste du budget n'est pas emis. shortcut: ratio fixe; le cout reel est toujours compte (shared/bedrock.ts).
    const est = costEur('sonnet-5.5', { inputTokens: Math.ceil((p.prompt.length + p.system.length) / CHARS_PER_TOKEN), outputTokens: Math.min(MAX_TOKENS, 120 * nClaims + 200) });
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

  const claims = (await store.listClaims(input.docId)).filter((c) => !existing.has(c.nn));
  const early: [number, Final][] = [];
  const factual: Work[] = [];
  for (const { nn, claim } of claims) {
    if (isNonFactual(claim)) early.push([nn, { statut: 'non_factuelle', secondeLecture: false, sources: [] }]);
    else factual.push({ nn, claim, passages: [] });
  }

  // Etape 7: cache d'abord, puis recherche (en serie: l'outil espace ses requetes).
  const toJudge: Work[] = [];
  for (const w of factual) {
    const hit = await cacheHit(store, w.claim);
    if (hit) {
      early.push([w.nn, hit]);
      continue;
    }
    w.passages = await search.search(w.claim.texte);
    if (w.passages.length === 0) early.push([w.nn, nonVerifiable]);
    else toJudge.push(w);
  }
  for (const [nn, v] of early) await store.putVerdict(input.docId, nn, v);

  // Etapes 8 a 10 par lot de 25 (affirmations a risque d'abord: elles passent avant l'arret du budget). Chaque lot est ECRIT avant le suivant:
  // une panne au lot N ne perd pas les lots precedents, et leur cout est reporte sur le premier verdict du lot (plafond du job cumule).
  toJudge.sort((a, b) => Number(b.claim.aRisque) - Number(a.claim.aRisque));
  const asJudge = (batch: Work[]): JudgeClaim[] => batch.map((w, i) => ({ alias: `C${i + 1}`, texte: w.claim.texte, passages: w.passages.map((p, j) => ({ alias: `P${j + 1}`, passage: p })) }));
  for (const batch of chunks(toJudge, CLAIMS_PER_CALL)) {
    const before = spent;
    const jc = asJudge(batch);
    // Etape 8 puis 9 (controle par code).
    const text = await call(judgePrompt(jc), 'verify-judge', batch.length);
    const raw = text === null ? new Map() : parseVerdicts(text);
    batch.forEach((w, i) => {
      w.checked = checkVerdict(jc[i], raw.get(jc[i].alias));
    });
    // Etape 10: seconde lecture des `erreur` et des `verifiee` a risque. Si elle echoue, ce qui est acquis est ecrit, puis l'erreur est relancee.
    let failure: unknown;
    const second = batch.filter((w) => w.checked && needsSecondRead(w.checked, w.claim.aRisque));
    if (second.length) {
      try {
        const sj = asJudge(second);
        const t2 = await call(secondReadPrompt(sj), 'verify-second', second.length);
        const raw2 = t2 === null ? new Map() : parseVerdicts(t2);
        second.forEach((w, i) => {
          w.checked = mergeSecondRead(w.checked!, checkVerdict(sj[i], raw2.get(sj[i].alias)));
          w.secondRead = t2 !== null; // vrai seulement si l'appel a eu lieu
        });
      } catch (e) {
        failure = e;
        // Lecture non confirmee: non_verifiable (jamais en cache). Ces affirmations ne seront pas rejouees par un Retry.
        for (const w of second) w.checked = { statut: 'non_verifiable', sources: [] };
      }
    }
    await persistBatch(store, input.docId, batch, Math.round((spent - before) * 1e6));
    if (failure) throw failure;
  }
  return { costEur: spent };
}

/** Ecrit un lot: passages d'abord (toute source cite un passage stocke), puis verdicts (le cout du lot sur le premier), puis cache. */
async function persistBatch(store: VerifyStore, docId: string, batch: Work[], coutMicros: number): Promise<void> {
  for (const w of batch) {
    const c = w.checked ?? { statut: 'non_verifiable' as const, sources: [] };
    w.final = c.statut === 'non_verifiable' ? nonVerifiable : { statut: c.statut, niveau: c.niveau, secondeLecture: Boolean(w.secondRead), sources: c.sources };
  }
  const used = new Map<string, Passage>();
  for (const w of batch) for (const s of w.final?.sources ?? []) used.set(s.passageId, w.passages.find((p) => p.id === s.passageId)!);
  await store.putPassages([...used.values()]);
  for (const [i, w] of batch.entries()) await store.putVerdict(docId, w.nn, i === 0 && coutMicros > 0 ? { ...w.final!, coutMicros } : w.final!);
  for (const w of batch) {
    const f = w.final!;
    if ((f.statut === 'verifiee' || f.statut === 'erreur') && f.niveau) {
      await store.putCache(fingerprint(w.claim.texte), { statut: f.statut, niveau: f.niveau, secondeLecture: f.secondeLecture, passageIds: f.sources.map((s) => s.passageId), sources: f.sources });
    }
  }
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
