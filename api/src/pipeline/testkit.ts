// Outils de test du pipeline L2a: contexte en memoire, faux modele par etape, faux evenements API. Aucun reseau, aucun cout.
import type { APIGatewayProxyEventV2 } from 'aws-lambda';
import type { CostStore, ModelPort, ModelRequest } from '../../../shared/bedrock.js';
import type { CostTotals } from '../../../shared/cost.js';
import { memoryQuotaDb } from '../../../shared/quota.js';
import { ulid, type Ctx } from './ctx.js';
import { memoryCrop, memoryDb, memoryFigureStore, memoryScanStore, memorySfn } from './ports.js';
import { finalize, generate } from './steps-doc.js';

export const JPEG = new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
export const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5, 6, 7, 8]);

/** Reponses du faux modele, par etape reconnue dans le prompt. */
export interface Script {
  /** Lecture des photos: reçoit les pages NOUVELLES de l'appel (hors page de contexte) et le nombre d'images jointes. */
  transcription: (pages: number[], images: number) => string;
  /** Appel de texte seul: type du document, matiere, sujet, decoupage propose. */
  classify: string;
  extraction: string | ((prompt: string) => string);
  generation: string;
  solve: string;
  /** Q1: second tour (banque). Absent: aucune question de plus. */
  variantes?: string | (() => string);
}

export function scriptedPort(script: Script, calls: string[] = [], prompts: string[] = []): ModelPort {
  return {
    async converse(req: ModelRequest) {
      let text: string;
      if (req.images?.length) {
        calls.push('transcription');
        prompts.push(req.prompt);
        const pages = [...req.prompt.matchAll(/image \d+ = page (\d+)( \(contexte)?/g)].filter((m) => !m[2]).map((m) => Number(m[1]));
        text = script.transcription(pages, req.images.length);
      } else if (req.prompt.includes('<texte>')) {
        calls.push('classement');
        text = script.classify;
      } else if (req.prompt.includes('<cours>')) {
        calls.push('extraction');
        prompts.push(req.prompt);
        text = typeof script.extraction === 'function' ? script.extraction(req.prompt) : script.extraction;
      } else if (req.prompt.includes('<deja>')) {
        calls.push('variantes');
        text = typeof script.variantes === 'function' ? script.variantes() : (script.variantes ?? '{"qcm":[],"trous":[]}');
      } else if (req.prompt.includes('<affirmations>')) {
        calls.push('generation');
        text = script.generation;
      } else {
        calls.push('solve');
        text = script.solve;
      }
      return { text, usage: { inputTokens: 2000, outputTokens: 500 } };
    },
  };
}

export function memoryCost(initial: Partial<CostTotals> = {}): CostStore & { totals: CostTotals } {
  const totals: CostTotals = { monthEur: initial.monthEur ?? 0, totalEur: initial.totalEur ?? 0 };
  return {
    totals,
    async read() {
      return { ...totals };
    },
    async add(eur) {
      totals.monthEur += eur;
      totals.totalEur += eur;
      return { ...totals };
    },
  };
}

export const MODEL_ARN = 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/qcm-dev-haiku';

export async function makeCtx(script: Script, opts: { cost?: Partial<CostTotals>; now?: () => Date } = {}) {
  process.env.QCM_ENV = 'dev';
  const calls: string[] = [];
  const prompts: string[] = []; // invites des appels de lecture et d'extraction (pour verifier ce que le modele voit)
  const quota = memoryQuotaDb();
  const db = memoryDb(quota.items); // une seule table, comme en production (le quota et le marqueur QUOTAOP# sont dans la meme transaction)
  const s3 = memoryScanStore();
  const sfn = memorySfn();
  const figures = memoryFigureStore(s3);
  const crop = memoryCrop();
  const costStore = memoryCost(opts.cost);
  let n = 0;
  const ctx: Ctx = {
    env: 'dev',
    db,
    quota,
    s3,
    sfn,
    figures,
    crop,
    models: { haiku: MODEL_ARN, sonnet: MODEL_ARN },
    port: scriptedPort(script, calls, prompts),
    costStore,
    now: opts.now ?? (() => new Date('2026-12-01T10:00:00Z')),
    newId: () => `DOC${String(++n).padStart(23, '0')}`,
  };
  await db.put({ PK: 'FAMILY#f1', SK: 'META' });
  await db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s1', cognitoSub: 'sub-s1', statut: 'actif' });
  await db.put({ PK: 'FAMILY#f1', SK: 'STUDENT#s2', cognitoSub: 'sub-s2', statut: 'suspendu' });
  return { ctx, db, quota, s3, sfn, figures, crop, costStore, calls, prompts };
}

export function event(o: { sub?: string; family?: string; groups?: string; params?: Record<string, string>; body?: unknown } = {}): APIGatewayProxyEventV2 {
  return {
    pathParameters: o.params,
    body: o.body === undefined ? undefined : JSON.stringify(o.body),
    isBase64Encoded: false,
    requestContext: { authorizer: { jwt: { claims: { sub: o.sub ?? 'sub-s1', 'custom:famille_id': o.family ?? 'f1', 'cognito:groups': o.groups ?? '[eleve]' } } } },
  } as unknown as APIGatewayProxyEventV2;
}
export const parent = (o: { params?: Record<string, string>; body?: unknown } = {}) => event({ sub: 'sub-p', groups: '[parent]', ...o });

export { ulid };

/** Cours de test: texte neutre de plus de 40 mots, une phrase par ligne. */
export const COURSE_LINES = [
  'La photosynthese est le processus par lequel les plantes vertes fabriquent leur matiere.',
  'Elle se deroule dans les chloroplastes des cellules vegetales.',
  'La plante absorbe du dioxyde de carbone par ses feuilles.',
  'Elle utilise l energie lumineuse pour produire du glucose.',
  'Le dioxygene est rejete dans l atmosphere pendant la photosynthese.',
  'La chlorophylle donne sa couleur verte aux feuilles et capte la lumiere.',
  'Les racines absorbent l eau et les sels mineraux du sol.',
  'Ce phenomene a lieu surtout pendant la journee quand il y a de la lumiere.',
];
export const COURSE_TEXT = COURSE_LINES.join('\n');

/** Sortie de lecture: une entree par page, avec ses lignes et son indicateur `suite`. */
export const readJson = (pages: { page: number; lines: string[]; suite?: boolean }[]) => JSON.stringify({ pages: pages.map((p) => ({ suite: false, ...p })) });
export const classifyJson = (o: Record<string, unknown> = {}) => JSON.stringify({ docType: 'cours', matiere: 'svt', sujet: 'La photosynthese', sections: [], ...o });

export const goodScript = (over: Partial<Script> = {}): Script => ({
  transcription: (pages) => readJson(pages.map((page) => ({ page, lines: COURSE_LINES }))),
  classify: classifyJson(),
  extraction: JSON.stringify({
    titre: 'La photosynthese',
    matiere: 'svt',
    affirmations: [
      { phraseId: 'p1-s2', extrait: 'dans les chloroplastes', texte: 'La photosynthese se deroule dans les chloroplastes.', type: 'factuelle', aRisque: false },
      { phraseId: 'p1-s3', extrait: 'dioxyde de carbone', texte: 'La plante absorbe du dioxyde de carbone par ses feuilles.', type: 'factuelle', aRisque: false },
      { phraseId: 'p1-s5', extrait: 'rejete dans l atmosphere', texte: 'Le dioxygene est rejete dans l atmosphere.', type: 'factuelle', aRisque: false },
      { phraseId: 'p1-s6', extrait: 'donne sa couleur verte', texte: 'La chlorophylle donne sa couleur verte aux feuilles.', type: 'factuelle', aRisque: false },
      { phraseId: 'p1-s4', extrait: 'ce texte est invente', texte: 'Une affirmation dont l extrait ne vient pas du cours.', type: 'factuelle', aRisque: false },
      { phraseId: 'p9-s9', extrait: 'phrase inexistante ici', texte: 'Une affirmation sur une phrase qui n existe pas.', type: 'factuelle', aRisque: false },
    ],
  }),
  generation: JSON.stringify({
    resume: 'Les plantes vertes fabriquent leur matiere avec la lumiere.',
    qcm: [
      { claimId: '01', enonce: 'Ou se deroule la photosynthese ?', choix: ['Dans les chloroplastes', 'Dans les racines', 'Dans le noyau', 'Dans le sol'], cle: 0 },
      { claimId: '02', enonce: 'Que absorbe la plante par ses feuilles ?', choix: ['Du dioxyde de carbone', 'De l azote', 'Du sable', 'Du fer'], cle: 0 },
      { claimId: '03', enonce: 'Quel gaz est rejete ?', choix: ['Le dioxygene', 'Le methane', 'Le dioxyde de carbone', 'Le dihydrogene'], cle: 0 },
      { claimId: '99', enonce: 'Question sur une affirmation inconnue ?', choix: ['a', 'b', 'c', 'd'], cle: 1 },
    ],
    trous: [
      { claimId: '04', phrase: 'La chlorophylle donne sa couleur ____ aux feuilles.', attendu: 'verte' },
      { claimId: '01', phrase: 'La photosynthese se deroule dans les ____.', attendu: 'racines' },
    ],
  }),
  // reponses a l'aveugle: la question 2 est jugee differente de la cle, elle sera rejetee
  solve: JSON.stringify({ reponses: [{ n: 1, choix: 0 }, { n: 2, choix: 3 }, { n: 3, choix: 0 }] }),
  ...over,
});

/** `generate` puis `finalize` (le dernier pas de la machine), pour les tests qui regardent le scan termine. */
export async function genFin(ctx: Ctx, i: { jobId: string; sid: string; index?: number }) {
  const r = await generate(ctx, i);
  await finalize(ctx, i);
  return r;
}
