import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Annotation } from './golden.js';
import type { PageRun, Status } from './metrics.js';

export interface Runner {
  mode: 'oracle' | 'mock' | 'real';
  /** Dépense cumulée du lancement (voie `lambda`), pour l'arrêt de sécurité. */
  spent?: () => number;
  lastTotals?: () => { monthEur: number; totalEur: number } | undefined;
  /** Vrai si le runner peut rejouer une page avec des passages sans injection (test A7). L'API publique ne le permet pas. */
  passageTwin: boolean;
  run(input: { id: string; image: Buffer; ann: Annotation; expectedRefused?: boolean; cleanPassages?: boolean }): Promise<PageRun>;
}

/** Pipeline imaginaire pour les tests de l'outil: lit les annotations, rate une erreur sur `missEvery`. Ne mesure rien du vrai pipeline. */
export function oracleRunner(opts: { missEvery?: number } = {}): Runner {
  let n = 0;
  return {
    mode: 'oracle',
    passageTwin: true,
    async run({ ann, expectedRefused }) {
      if (expectedRefused) return { refused: true, transcript: '', claims: [] };
      const claims = ann.sentences
        .filter((s) => s.kind === 'correct' || s.kind === 'error')
        .map((s) => {
          const miss = s.kind === 'error' && opts.missEvery && ++n % opts.missEvery === 0;
          return { text: s.text, status: (s.kind === 'error' && !miss ? 'erreur' : 'verifiee') as Status };
        });
      return { refused: false, transcript: ann.transcription, claims, durationSec: 30, costEur: 0.05 };
    },
  };
}

interface Job { state: string; durationSeconds?: number; docId?: string }
interface ApiDoc { claims: { text: string; status: Status }[] }

/**
 * Client du contrat OpenAPI. Contre l'API simulée (Prism), les réponses sont des exemples fixes:
 * on parcourt les routes sans envoi ni attente (mode 'mock'), les mesures n'ont aucun sens.
 * Contre un vrai déploiement (mode 'real'): envoi par POST pré-signé, attente de chaque état.
 * shortcut: chemin 'real' non exécuté faute de pipeline; le coût n'est pas exposé par le contrat (costEur reste vide), à demander au lot 2a.
 */
export function apiRunner(baseUrl: string, token: string, mode: 'mock' | 'real'): Runner {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const r = await fetch(baseUrl + path, {
      method,
      headers: { authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!r.ok) throw new Error(`${method} ${path}: ${r.status}`);
    return (await r.json()) as T;
  };
  const waitFor = async (jobId: string, states: string[]): Promise<Job> => {
    for (let i = 0; i < 120; i++) {
      const j = await call<Job>('GET', `/jobs/${jobId}`);
      if (states.includes(j.state)) return j;
      await new Promise((r) => setTimeout(r, 2000));
    }
    throw new Error(`job ${jobId}: délai dépassé`);
  };
  return {
    mode,
    passageTwin: false,
    async run({ image }) {
      const scan = await call<{ jobId: string; upload: { url: string; fields: Record<string, string> } }>('POST', '/scans', { pages: 1, contentType: 'image/jpeg' });
      if (mode === 'mock') {
        const j = await call<Job>('GET', `/jobs/${scan.jobId}`);
        const t = await call<{ pages: { sentences: { text: string }[] }[] }>('GET', `/jobs/${scan.jobId}/transcription`);
        await call('POST', `/jobs/${scan.jobId}/confirm`, { corrections: [] });
        const d = await call<ApiDoc>('GET', '/docs/01JEXAMPLE0DOC0000000000AA');
        return { refused: false, transcript: t.pages.flatMap((p) => p.sentences.map((s) => s.text)).join('\n'), claims: d.claims, durationSec: j.durationSeconds };
      }
      const form = new FormData();
      for (const [k, v] of Object.entries(scan.upload.fields)) form.append(k, v);
      form.append('file', new Blob([new Uint8Array(image)], { type: 'image/jpeg' }));
      const up = await fetch(scan.upload.url, { method: 'POST', body: form });
      if (!up.ok) throw new Error(`envoi: ${up.status}`);
      const first = await waitFor(scan.jobId, ['a_confirmer', 'rejete', 'echec', 'expire']);
      if (first.state !== 'a_confirmer') return { refused: true, transcript: '', claims: [] };
      const t = await call<{ pages: { sentences: { text: string }[] }[] }>('GET', `/jobs/${scan.jobId}/transcription`);
      await call('POST', `/jobs/${scan.jobId}/confirm`, { corrections: [] });
      const done = await waitFor(scan.jobId, ['termine', 'rejete', 'echec', 'expire']);
      if (done.state !== 'termine' || !done.docId) return { refused: true, transcript: '', claims: [] };
      const d = await call<ApiDoc>('GET', `/docs/${done.docId}`);
      return {
        refused: false,
        transcript: t.pages.flatMap((p) => p.sentences.map((s) => s.text)).join('\n'),
        claims: d.claims,
        outputText: JSON.stringify(d),
        durationSec: done.durationSeconds,
      };
    },
  };
}

/**
 * Voie `lambda` (dev seulement, stack eval-stack): invoque la Lambda `eval-run` avec la CLI AWS (identifiants OIDC du role QCMonster-Eval-dev).
 * Une page par appel; la Lambda exécute le vrai pipeline en mémoire et renvoie résultats, coût par étape et compteurs.
 * Sécurités: aucun nouvel essai de la CLI (un essai de plus = une facture de plus), arrêt dès que `maxEur` est atteint ou que le cumul dev
 * atteint `stopAtTotalEur`. Les journaux n'affichent jamais de contenu: seulement l'identifiant de page et des nombres.
 */
export function lambdaRunner(fnName: string, o: { maxEur: number; stopAtTotalEur: number }): Runner {
  let spent = 0;
  let totals: { monthEur: number; totalEur: number } | undefined;
  const invoke = (payload: unknown): Record<string, unknown> => {
    const dir = mkdtempSync(join(tmpdir(), 'eval-'));
    try {
      writeFileSync(join(dir, 'in.json'), JSON.stringify(payload), { mode: 0o600 });
      const meta = execFileSync(
        'aws',
        ['lambda', 'invoke', '--function-name', fnName, '--payload', `fileb://${join(dir, 'in.json')}`, '--cli-read-timeout', '0', '--cli-connect-timeout', '30', '--output', 'json', join(dir, 'out.json')],
        { env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 1 << 20 },
      );
      const out = JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as Record<string, unknown>;
      if ((JSON.parse(meta) as { FunctionError?: string }).FunctionError) throw new Error(`eval-run: ${String(out.errorType ?? 'erreur')}`);
      return out;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  };
  return {
    mode: 'real',
    passageTwin: false,
    spent: () => spent,
    lastTotals: () => totals,
    async run({ id, image }) {
      if (spent >= o.maxEur) throw new Error(`arrêt: dépense du lancement ${spent.toFixed(3)} EUR >= plafond ${o.maxEur} EUR`);
      if (totals && totals.totalEur >= o.stopAtTotalEur) throw new Error(`arrêt: cumul dev ${totals.totalEur.toFixed(2)} EUR >= ${o.stopAtTotalEur} EUR`);
      const r = invoke({ action: 'run', pageId: id, image: image.toString('base64') }) as {
        refused: boolean; state: string; transcript: string; claims: PageRun['claims']; outputText: string; steps: NonNullable<PageRun['steps']>;
        costEur: number; durationSec: number; costBefore: NonNullable<PageRun['costBefore']>; costAfter: NonNullable<PageRun['costAfter']>; uncounted: number; errorClass?: string; errorDetail?: string;
      };
      spent += r.costEur;
      totals = r.costAfter;
      console.log(`page ${id}: ${r.state}${r.errorClass ? ` (${r.errorClass})` : ''}${r.errorDetail ? ` [${r.errorDetail}]` : ''}, ${r.costEur.toFixed(4)} EUR, ${r.durationSec.toFixed(0)} s, cumul dev ${r.costAfter.totalEur.toFixed(4)} EUR`);
      return { refused: r.refused, transcript: r.transcript, claims: r.claims, outputText: r.outputText, durationSec: r.durationSec, costEur: r.costEur, steps: r.steps, state: r.state, errorClass: r.errorClass, errorDetail: r.errorDetail, uncounted: r.uncounted, costBefore: r.costBefore, costAfter: r.costAfter };
    },
  };
}

/** Compteurs de coût dev (action `cost` de la Lambda). */
export function lambdaCost(fnName: string): { monthEur: number; totalEur: number } {
  const dir = mkdtempSync(join(tmpdir(), 'eval-'));
  try {
    writeFileSync(join(dir, 'in.json'), JSON.stringify({ action: 'cost' }));
    execFileSync('aws', ['lambda', 'invoke', '--function-name', fnName, '--payload', `fileb://${join(dir, 'in.json')}`, '--cli-read-timeout', '60', '--output', 'json', join(dir, 'out.json')], { env: { ...process.env, AWS_MAX_ATTEMPTS: '1', AWS_PAGER: '' }, stdio: ['ignore', 'pipe', 'pipe'] });
    return (JSON.parse(readFileSync(join(dir, 'out.json'), 'utf8')) as { costBefore: { monthEur: number; totalEur: number } }).costBefore;
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
