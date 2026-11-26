// Coeur de la Lambda `eval-run` (dev seulement): execute le VRAI pipeline (transcription, extraction, verification, generation) pour UNE page
// synthetique, avec une base EN MEMOIRE (aucune ecriture dans la table, sauf le compteur de cout via le CostStore injecte).
// Les modeles sont appeles par `invokeModel` (shared/bedrock.ts): compteur COST#dev, plafond de dev et plafond par traitement s'appliquent.
// Aucun contenu de cours n'est journalise: la reponse (renvoyee a l'appelant) peut en contenir, les journaux jamais.
// shortcut: etape `quota-consume` remplacee par l'ajout direct du cout de verification (pas de quota en evaluation); cache de verdicts
// non partage entre deux pages (chaque appel repart de zero), donc le cout mesure est un pire cas par rapport a la production.
import type { CostStore, ModelPort, ModelRequest } from '../../shared/bedrock.js';
import type { CostTotals } from '../../shared/cost.js';
import { keys } from '../../shared/ddb/keys.js';
import { VerdictItemSchema } from '../../shared/items.js';
import { toMicros } from '../../shared/cost.js';
import { costEur, type Usage } from '../../shared/pricing.js';
import { memoryQuotaDb } from '../../shared/quota.js';
import { jobKey, type Ctx } from '../../api/src/pipeline/ctx.js';
import { memoryCrop, memoryDb, memoryFigureStore, memoryScanStore, memorySfn } from '../../api/src/pipeline/ports.js';
import { imageFormat, scanCheck, transcribe } from '../../api/src/pipeline/steps.js';
import { claimStatus, extract, generate } from '../../api/src/pipeline/steps-doc.js';
import { scansPrefix, transition } from '../../api/src/pipeline/job.js';
import { verifyRun, type ClaimTrace, type JudgeTrace } from '../../api/src/verify/run.js';
import type { SearchPort, Passage } from '../../api/src/verify/search.js';
import type { CacheEntry, VerdictBody, VerifyStore } from '../../api/src/verify/store.js';
import { ClaimItemSchema } from '../../shared/items.js';

/** Pages autorisees: jeu synthetique public de reglage (golden/MANIFEST.json) et pages negatives. Jamais `synth-h-*` (cachees) ni `real-*` (privees). */
export const PAGE_ID = /^(synth-(fr|hist|maths|phys|svt)-\d{2}(\.clean)?|neg-[a-z]+)$/;
export const MAX_IMAGE_BYTES = 4 * 1024 * 1024;

export type StepName = 'transcription' | 'extraction' | 'verification' | 'generation' | 'controle-qcm';
export interface StepStat { step: StepName; calls: number; durationMs: number; inputTokens: number; outputTokens: number; costEur: number }

export interface EvalDeps {
  models: { haiku: string; sonnet: string };
  port: ModelPort;
  costStore: CostStore;
  search: SearchPort;
  now?: () => Date;
}

export interface PageResult {
  refused: boolean;
  state: string;
  message?: string;
  transcript: string;
  /** `excerpt`: extrait copie de la transcription (controle d'ancrage du pipeline, etape 6). */
  claims: { text: string; excerpt?: string; cause?: string; passages?: number; status: 'verifiee' | 'erreur' | 'non_verifiable' | 'non_factuelle' }[];
  outputText: string;
  steps: StepStat[];
  costEur: number;
  durationSec: number;
  costBefore: CostTotals;
  costAfter: CostTotals;
  /** Un enregistrement par appel de jugement (V2): nombres seulement, aucun contenu. */
  judge: JudgeTrace[];
  /** Appels dont le cout n'a pas pu etre ajoute au compteur (a rattraper). */
  uncounted: number;
  /** Nom de la classe de l'erreur si le pipeline s'est arrete sur une erreur (jamais son message). */
  errorClass?: string;
  /** Message d'une erreur de SERVICE AWS (Bedrock, DynamoDB...), 300 caracteres au plus, pour diagnostiquer l'acces au modele. Jamais le message d'une autre erreur. */
  errorDetail?: string;
}

export const bytesFromBase64 = (b64: string): Uint8Array => {
  if (b64.length > Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 || !/^[A-Za-z0-9+/]+={0,2}$/.test(b64)) throw new RangeError('image invalide');
  return new Uint8Array(Buffer.from(b64, 'base64'));
};

/** Magasin de verification en memoire: les verdicts vont dans la base (lus ensuite par `generate`), passages et cache dans des Maps. */
function evalVerifyStore(db: Ctx['db']): VerifyStore {
  const passages = new Map<string, Passage>();
  const cache = new Map<string, CacheEntry>();
  return {
    async listClaims(docId) {
      const items = await db.query(`DOC#${docId}`, 'CLAIM#');
      return items.map((i) => ({ nn: Number(i.SK.slice('CLAIM#'.length)), claim: ClaimItemSchema.parse(i) })).sort((a, b) => a.nn - b.nn);
    },
    async listVerdicts(docId) {
      const items = await db.query(`DOC#${docId}`, 'VERDICT#');
      return new Map(items.map((i) => [Number(i.SK.slice('VERDICT#'.length)), { ...(VerdictItemSchema.parse(i) as VerdictBody), coutMicros: typeof i.coutMicros === 'number' ? i.coutMicros : undefined }]));
    },
    async putVerdict(docId, nn, v) {
      const { coutMicros, ...body } = v;
      await db.put({ ...VerdictItemSchema.parse({ ...keys.verdict(docId, nn), ...body }), ...(coutMicros ? { coutMicros } : {}) });
    },
    async putPassages(ps) {
      for (const p of ps) passages.set(p.id, p);
    },
    async getPassages(ids) {
      return ids.map((i) => passages.get(i)).filter((p): p is Passage => !!p);
    },
    async getCache(fp) {
      return cache.get(fp);
    },
    async putCache(fp, e) {
      cache.set(fp, e);
    },
  };
}

export async function runPage(deps: EvalDeps, input: { pageId: string; image: Uint8Array }): Promise<PageResult> {
  if (!PAGE_ID.test(input.pageId)) throw new RangeError('page non autorisee');
  if (input.image.byteLength < 1 || input.image.byteLength > MAX_IMAGE_BYTES || !imageFormat(input.image)) throw new RangeError('image invalide');
  const t0 = Date.now();
  const sid = 'EVALstudent';
  const jobId = `EVALjob${t0.toString(36)}`;
  const steps = new Map<StepName, StepStat>();
  let phase: StepName = 'transcription';
  let uncounted = 0;
  const judge: JudgeTrace[] = [];
  const causes = new Map<number, ClaimTrace>();
  const stepOf = (req: ModelRequest): StepName => (req.images?.length ? 'transcription' : req.prompt.includes('<cours>') ? 'extraction' : req.prompt.includes('<affirmations>') ? 'generation' : req.prompt.includes('<questions>') ? 'controle-qcm' : phase);
  // Mesure par etape: le cout est recalcule avec les memes prix que le compteur (shared/pricing.ts).
  const port: ModelPort = {
    async converse(req) {
      const s = stepOf(req);
      const t = Date.now();
      const res = await deps.port.converse(req);
      const usage: Usage = res.usage;
      const st = steps.get(s) ?? { step: s, calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costEur: 0 };
      st.calls++;
      st.durationMs += Date.now() - t;
      st.inputTokens += usage.inputTokens;
      st.outputTokens += usage.outputTokens;
      st.costEur += costEur(req.modelArn === deps.models.sonnet ? 'sonnet-5.5' : 'haiku-5.5', usage);
      steps.set(s, st);
      return res;
    },
  };
  const costStore: CostStore = {
    read: () => deps.costStore.read(),
    async add(eur) {
      try {
        return await deps.costStore.add(eur);
      } catch (e) {
        uncounted++;
        throw e;
      }
    },
  };
  const quota = memoryQuotaDb();
  const db = memoryDb(quota.items);
  const s3 = memoryScanStore();
  let n = 0;
  const ctx: Ctx = { env: 'dev', db, quota, s3, sfn: memorySfn(), figures: memoryFigureStore(s3), crop: memoryCrop(), cfg: { figuresEnabled: false }, models: deps.models, port, costStore, now: deps.now ?? (() => new Date()), newId: () => `EVALdoc${String(++n).padStart(19, '0')}` };

  const costBefore = await costStore.read();
  const fmt = imageFormat(input.image)!;
  await db.put({
    ...jobKey(sid, jobId), familyId: 'EVALfamily', studentId: sid, state: 'verification_fichier', pages: 1, expectedFiles: 1, contentType: `image/${fmt}`,
    quotaState: 'none', coutMicros: 0, coutCentimes: 0, createdAt: ctx.now().toISOString(), ttl: Math.floor(Date.now() / 1000) + 3600,
  });
  s3.objects.set(`${scansPrefix(sid, jobId)}0`, input.image);
  const wf = { sid, jobId };

  let errorClass: string | undefined;
  let errorDetail: string | undefined;
  const finish = async (): Promise<PageResult> => {
    const job = await db.get(jobKey(sid, jobId));
    const part = job && typeof job.docId === 'string' ? await db.query(`DOC#${job.docId}`) : [];
    const verdicts = new Map(part.filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [x.SK.slice('VERDICT#'.length), x]));
    const claims = part.filter((x) => x.SK.startsWith('CLAIM#')).map((c) => ({ text: String(c.texte), excerpt: typeof (c.origine as { extrait?: unknown } | undefined)?.extrait === 'string' ? (c.origine as { extrait: string }).extrait : undefined, status: claimStatus(c, verdicts.get(c.SK.slice('CLAIM#'.length))), cause: causes.get(Number(c.SK.slice('CLAIM#'.length)))?.cause, passages: causes.get(Number(c.SK.slice('CLAIM#'.length)))?.passages }));
    const fiche = (await db.query(`STUDENT#${sid}`, 'DOC#'))[0];
    const texts = (await db.query(`JOB#${jobId}`, 'TEXT#')).sort((a, b) => Number(a.page) - Number(b.page));
    const transcript = texts.flatMap((t) => (t.sentences as { text: string }[]).map((s) => s.text)).join('\n');
    const costAfter = await costStore.read().catch(() => costBefore);
    const stepList = [...steps.values()];
    return {
      refused: job?.state !== 'termine',
      state: String(job?.state ?? 'inconnu'),
      ...(typeof job?.message === 'string' ? { message: job.message } : {}),
      transcript,
      claims,
      outputText: JSON.stringify({ fiche: fiche ?? null, qcm: part.filter((x) => x.SK.startsWith('QCM#')), trous: part.filter((x) => x.SK.startsWith('GAP#')) }),
      steps: stepList,
      costEur: stepList.reduce((a, s) => a + s.costEur, 0),
      durationSec: (Date.now() - t0) / 1000,
      costBefore,
      costAfter,
      judge,
      uncounted,
      ...(errorClass ? { errorClass } : {}),
      ...(errorDetail ? { errorDetail } : {}),
    };
  };

  try {
    if (!(await scanCheck(ctx, wf)).ok) return await finish();
    if (!(await transcribe(ctx, wf)).ok) return await finish();
    // Confirmation de l'eleve simulee sans correction (comme `jobs-confirm` sans corrections).
    await transition(ctx, sid, jobId, ['transcription'], 'a_confirmer');
    await transition(ctx, sid, jobId, ['a_confirmer'], 'verification', { confirmedAt: ctx.now().toISOString() });
    phase = 'extraction';
    const ex = await extract(ctx, wf);
    if (!ex.ok || !ex.docId) return await finish();
    phase = 'verification';
    await verifyRun({ store: evalVerifyStore(db), search: deps.search, model: { port, costStore, arn: deps.models.sonnet }, onTrace: (t) => judge.push(t), onClaim: (c) => causes.set(c.nn, c) }, { jobId, docId: ex.docId, budgetRestantCentimes: ex.budgetRestantCentimes ?? 0 });
    const verifyEur = steps.get('verification')?.costEur ?? 0;
    await db.update(jobKey(sid, jobId), { set: { state: 'generation', verifyCostAdded: true }, add: { coutMicros: toMicros(verifyEur) }, cond: { exists: true, in: { state: ['verification'] } } });
    phase = 'generation';
    await generate(ctx, wf);
  } catch (e) {
    errorClass = e instanceof Error ? e.constructor.name : 'Erreur';
    // Seules les erreurs du SDK AWS (elles portent `$metadata`) exposent leur message: il decrit la requete refusee, pas le cours.
    if (e instanceof Error && '$metadata' in e) errorDetail = `${e.name}: ${e.message}`.slice(0, 300);
  }
  return finish();
}
