/**
 * Lance l'évaluation et écrit eval/report.json.
 *   npm run eval                  API simulée (EVAL_API_URL, défaut http://localhost:4010), pages publiques seulement
 *   npm run eval -- --oracle      pipeline imaginaire (sans réseau) pour essayer l'outil
 *   EVAL_MODE=lambda npm run eval   vrai pipeline en dev via la Lambda eval-run (CLI AWS, rôle OIDC); pages publiques seulement
 *   --pages=a,b  --limit=N        sélection de pages (ids du manifeste / N premières pages de réglage); --negatives ajoute les 2 pages à refuser
 *   --hidden                      ajoute les pages cachées (compte les lancements, 3 au plus avant ouverture)
 * Variables (voie lambda): EVAL_LAMBDA_FUNCTION (défaut qcm-dev-eval-run), EVAL_MAX_EUR (dépense maximale du lancement, défaut 1), EVAL_STOP_AT_TOTAL_EUR (cumul dev, défaut 40).
 * Variables: GOLDEN_PRIVATE_DIR (vraies photos, pages cachées), EVAL_API_TOKEN, EVAL_REVIEW_FILE (relectures QCM et fidélité).
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadAnnotation, loadImage, loadManifest, totals, verifyCounters, type Golden } from './golden.js';
import { computeReport, type PageInput, type Review } from './metrics.js';
import { apiRunner, lambdaCost, lambdaRunner, oracleRunner, type Runner } from './runners.js';
import { drawSample, SAMPLE_SEED } from './sample.js';

const MAX_HIDDEN_RUNS = 3;

async function main() {
  const args = process.argv.slice(2);
  const withHidden = args.includes('--hidden');
  const privateDir = process.env.GOLDEN_PRIVATE_DIR;
  const g: Golden = { manifest: loadManifest(), privateDir };
  const viaLambda = process.env.EVAL_MODE === 'lambda' && !args.includes('--oracle');
  if (viaLambda && (withHidden || privateDir)) throw new Error('voie lambda: pages publiques seulement (ni --hidden ni GOLDEN_PRIVATE_DIR)');
  const fnName = process.env.EVAL_LAMBDA_FUNCTION ?? 'qcm-dev-eval-run';
  const maxEur = Number(process.env.EVAL_MAX_EUR ?? 1);
  const stopAt = Number(process.env.EVAL_STOP_AT_TOTAL_EUR ?? 40);
  if (viaLambda && !(maxEur > 0 && maxEur <= 25 && stopAt > 0 && stopAt <= 50)) throw new Error('EVAL_MAX_EUR doit être dans ]0, 25] et EVAL_STOP_AT_TOTAL_EUR dans ]0, 50]');
  const only = args.find((a) => a.startsWith('--pages='))?.slice(8).split(',').filter(Boolean);
  const limit = Number(args.find((a) => a.startsWith('--limit='))?.slice(8) ?? Infinity);
  const selected = Boolean(only) || Number.isFinite(limit);
  const runner: Runner = args.includes('--oracle')
    ? oracleRunner({ missEvery: 5 })
    : viaLambda
    ? lambdaRunner(fnName, { maxEur, stopAtTotalEur: stopAt })
    : apiRunner(process.env.EVAL_API_URL ?? 'http://localhost:4010', process.env.EVAL_API_TOKEN ?? 'x', process.env.EVAL_MODE === 'real' ? 'real' : 'mock');

  if (privateDir) {
    const bad = verifyCounters(g);
    if (bad.length) throw new Error(`compteurs du manifeste différents des annotations:\n${bad.join('\n')}`);
  }

  let hiddenRuns: number | null = null;
  if (withHidden && !args.includes('--oracle')) {
    if (!privateDir) throw new Error('--hidden demande GOLDEN_PRIVATE_DIR');
    const f = join(privateDir, 'annotations', 'hidden-runs.json');
    hiddenRuns = (existsSync(f) ? (JSON.parse(readFileSync(f, 'utf8')).runs as number) : 0) + 1;
    if (hiddenRuns > MAX_HIDDEN_RUNS && !args.includes('--opened')) throw new Error(`pages cachées: ${MAX_HIDDEN_RUNS} lancements déjà faits`);
    writeFileSync(f, JSON.stringify({ runs: hiddenRuns, last: new Date().toISOString() }), { mode: 0o600 });
  }

  const startTotals = viaLambda ? lambdaCost(fnName) : undefined;
  if (startTotals) console.log(`compteur dev au départ: ${startTotals.totalEur.toFixed(4)} EUR (mois ${startTotals.monthEur.toFixed(4)} EUR)`);
  const inputs: PageInput[] = [];
  const skipped: string[] = [];
  let taken = 0;
  for (const page of g.manifest.pages) {
    if (page.hidden && !withHidden) { skipped.push(page.id); continue; }
    if (!page.image && !privateDir) { skipped.push(page.id); continue; }
    if ((only && !only.includes(page.id)) || taken >= limit) { skipped.push(page.id); continue; }
    taken++;
    const ann = loadAnnotation(g, page);
    const input: PageInput = { page, ann, run: await runner.run({ id: page.id, image: loadImage(g, page), ann }) };
    if (page.twinImage) input.twin = await runner.run({ id: page.id, image: loadImage(g, { id: page.id, image: page.twinImage }), ann });
    if (page.injectionPassage && runner.passageTwin) input.passageTwin = await runner.run({ id: page.id, image: loadImage(g, page), ann, cleanPassages: true });
    inputs.push(input);
  }
  const negatives: { refused: boolean }[] = [];
  for (const n of selected && !args.includes('--negatives') ? [] : g.manifest.negatives) {
    const r = await runner.run({ id: n.id, image: loadImage(g, n), ann: { id: n.id, transcription: '', sentences: [] }, expectedRefused: true });
    negatives.push({ refused: r.refused });
  }
  const reviewFile = process.env.EVAL_REVIEW_FILE;
  const review: Review = reviewFile ? JSON.parse(readFileSync(reviewFile, 'utf8')) : {};

  // Tirage des 50 affirmations produites à relire, graine fixe. Le fichier peut contenir du texte de cours: dossier privé, sinon fichier ignoré par git.
  const produced = inputs.flatMap((i) => i.run.claims.map((c, k) => ({ page: i.page.id, n: k + 1, text: c.text, status: c.status })));
  const sample = drawSample(produced, 50);
  const sampleFile = privateDir ? join(privateDir, 'annotations', 'fidelity-sample.json') : join(dirname(fileURLToPath(import.meta.url)), 'fidelity-sample.json');
  writeFileSync(sampleFile, JSON.stringify({ seed: SAMPLE_SEED, claims: sample.map((c) => ({ ...c, faithful: null })) }, null, 1), { mode: 0o600 });

  // Détail sans aucun texte de cours (le rapport est publié en artefact): comptes, coûts, délais, erreurs par page.
  const perPage = inputs.map((i) => ({
    id: i.page.id, state: i.run.state, refused: i.run.refused, errorClass: i.run.errorClass, errorDetail: i.run.errorDetail, costEur: i.run.costEur, durationSec: i.run.durationSec,
    claims: i.run.claims.length, byStatus: Object.fromEntries(['verifiee', 'erreur', 'non_verifiable', 'non_factuelle'].map((st) => [st, i.run.claims.filter((c) => c.status === st).length])),
    insertedErrors: i.page.errors, steps: i.run.steps, judge: i.run.judge,
  }));
  const stepTotals = new Map<string, { calls: number; durationMs: number; inputTokens: number; outputTokens: number; costEur: number }>();
  for (const i of inputs) for (const st of i.run.steps ?? []) {
    const t = stepTotals.get(st.step) ?? { calls: 0, durationMs: 0, inputTokens: 0, outputTokens: 0, costEur: 0 };
    for (const k of Object.keys(t) as (keyof typeof t)[]) t[k] += st[k];
    stepTotals.set(st.step, t);
  }
  const lambdaInfo = viaLambda
    ? {
        counters: { before: startTotals, after: runner.lastTotals?.() },
        spentEur: runner.spent?.(),
        uncountedCalls: inputs.reduce((n, i) => n + (i.run.uncounted ?? 0), 0),
        perStep: Object.fromEntries([...stepTotals].map(([k, t]) => [k, { ...t, costPerPageEur: inputs.length ? t.costEur / inputs.length : null }])),
        perPage,
      }
    : undefined;
  const report = {
    lambda: lambdaInfo,
    generatedAt: new Date().toISOString(),
    mode: runner.mode,
    valid: runner.mode === 'real',
    warning: runner.mode === 'real' ? undefined : "Mesures sans valeur: le pipeline réel n'est pas appelé (mode " + runner.mode + ').',
    hiddenRuns,
    skipped,
    fidelitySample: { n: sample.length, seed: SAMPLE_SEED, privateFile: Boolean(privateDir) },
    goldenTotals: totals(g.manifest),
    ...computeReport(inputs, negatives, review),
  };
  writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'report.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(`eval: mode=${report.mode}, ${inputs.length} pages, ${skipped.length} ignorées -> eval/report.json`);
}

main().catch((e) => { console.error(e instanceof Error ? e.message : e); process.exit(1); });
