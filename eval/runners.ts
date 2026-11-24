import type { Annotation } from './golden.js';
import type { PageRun, Status } from './metrics.js';

export interface Runner {
  mode: 'oracle' | 'mock' | 'real';
  run(input: { id: string; image: Buffer; ann: Annotation; expectedRefused?: boolean }): Promise<PageRun>;
}

/** Pipeline imaginaire pour les tests de l'outil: lit les annotations, rate une erreur sur `missEvery`. Ne mesure rien du vrai pipeline. */
export function oracleRunner(opts: { missEvery?: number } = {}): Runner {
  let n = 0;
  return {
    mode: 'oracle',
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
