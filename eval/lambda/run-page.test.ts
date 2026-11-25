import { describe, expect, it } from 'vitest';
import type { ModelPort } from '../../shared/bedrock.js';
import { goodScript, JPEG, memoryCost, scriptedPort } from '../../api/src/pipeline/testkit.js';
import { heuristicModel } from '../../api/src/verify/testkit.js';
import { passageId, type SearchPort } from '../../api/src/verify/search.js';
import { bytesFromBase64, PAGE_ID, runPage } from './run-page.js';

const ARN = 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/qcm-dev-haiku';
const SONNET = 'arn:aws:bedrock:eu-west-3:123456789012:application-inference-profile/qcm-dev-sonnet';
process.env.QCM_ENV = 'dev';

/** Juge heuristique pour la verification, faux modele par etape pour le reste. */
const port = (): ModelPort => {
  const pipeline = scriptedPort(goodScript());
  const judge = heuristicModel();
  return { converse: (req) => (req.prompt.includes('<affirmation id=') ? judge.converse(req) : pipeline.converse(req)) };
};
/** Un passage identique a l'affirmation (verifiee) pour chaque recherche. */
const search: SearchPort = {
  async search(text) {
    const url = 'https://fr.wikipedia.org/wiki/Test';
    return [{ id: passageId(url, text), texte: text, url, site: 'fr.wikipedia.org', titre: 'Test', niveau: 1 }];
  },
};

describe('runPage (pipeline reel, base en memoire)', () => {
  it('execute toutes les etapes, mesure le cout par etape et ajoute exactement ce cout au compteur', async () => {
    const costStore = memoryCost();
    const r = await runPage({ models: { haiku: ARN, sonnet: SONNET }, port: port(), costStore, search }, { pageId: 'synth-svt-01', image: JPEG });
    expect(r.errorClass).toBeUndefined();
    expect(r.state).toBe('termine');
    expect(r.refused).toBe(false);
    expect(r.steps.map((s) => s.step).sort()).toEqual(['controle-qcm', 'extraction', 'generation', 'transcription', 'verification']);
    expect(r.costEur).toBeGreaterThan(0);
    expect(costStore.totals.totalEur).toBeCloseTo(r.costEur, 9);
    expect(r.costAfter.totalEur - r.costBefore.totalEur).toBeCloseTo(r.costEur, 9);
    expect(r.claims.length).toBeGreaterThan(0);
    expect(r.claims.some((c) => c.status === 'verifiee')).toBe(true);
    expect(r.transcript).toContain('photosynthese');
    expect(r.uncounted).toBe(0);
    expect(r.judge.length).toBeGreaterThan(0); // une trace par appel de jugement, nombres seulement
    expect(r.judge[0]).toMatchObject({ step: 'verify-judge', readable: true, retried: false });
    expect(r.claims.every((c) => typeof c.excerpt === 'string' && r.transcript.includes(c.excerpt.slice(0, 20)))).toBe(true);
  });
  it('page refusee (document non scolaire): refused, aucune fiche', async () => {
    const script = goodScript({ transcription: () => JSON.stringify({ docType: 'autre', text: 'Bulletin de notes de quelqu un.' }) });
    const r = await runPage({ models: { haiku: ARN, sonnet: SONNET }, port: scriptedPort(script), costStore: memoryCost(), search }, { pageId: 'neg-bulletin', image: JPEG });
    expect(r.refused).toBe(true);
    expect(r.state).toBe('rejete');
    expect(r.claims).toEqual([]);
  });
  it('une erreur du pipeline est rapportee par sa classe, sans message', async () => {
    const failing: ModelPort = { converse: async () => { throw new Error('contenu secret du cours'); } };
    const r = await runPage({ models: { haiku: ARN, sonnet: SONNET }, port: failing, costStore: memoryCost(), search }, { pageId: 'synth-svt-01', image: JPEG });
    expect(r.errorClass).toBe('Error');
    expect(JSON.stringify(r)).not.toContain('secret');
  });
  it('erreur de service AWS: son message est rendu (diagnostic), pas celui d\'une erreur ordinaire', async () => {
    const aws = Object.assign(new Error('The provided model identifier is invalid.'), { name: 'ValidationException', $metadata: { httpStatusCode: 400 } });
    const failing: ModelPort = { converse: async () => { throw aws; } };
    const r = await runPage({ models: { haiku: ARN, sonnet: SONNET }, port: failing, costStore: memoryCost(), search }, { pageId: 'synth-svt-01', image: JPEG });
    expect(r.errorDetail).toBe('ValidationException: The provided model identifier is invalid.');
  });
  it('plafond de dev atteint: le modele n\'est pas appele', async () => {
    let called = 0;
    const counting: ModelPort = { converse: async (q) => { called++; return port().converse(q); } };
    const r = await runPage({ models: { haiku: ARN, sonnet: SONNET }, port: counting, costStore: memoryCost({ totalEur: 50, monthEur: 0 }), search }, { pageId: 'synth-svt-01', image: JPEG });
    expect(called).toBe(0);
    expect(r.errorClass).toBe('CostBlockedError');
  });
});

describe('entrees', () => {
  it('seules les pages synthetiques de reglage et les negatifs sont permis (ni cachees, ni reelles)', () => {
    for (const ok of ['synth-fr-01', 'synth-maths-06', 'synth-svt-02.clean', 'neg-blank', 'neg-bulletin']) expect(PAGE_ID.test(ok)).toBe(true);
    for (const bad of ['synth-h-01', 'real-hist-01', 'real-math-02', '../synth-fr-01', 'synth-fr-01/../x', '']) expect(PAGE_ID.test(bad)).toBe(false);
  });
  it('image: refuse les chaines non base64 et celles trop grandes; page: refuse un fichier qui n\'est pas une image', async () => {
    expect(() => bytesFromBase64('pas du base64 !')).toThrow();
    expect(() => bytesFromBase64('A'.repeat(6 * 1024 * 1024))).toThrow();
    await expect(runPage({ models: { haiku: ARN, sonnet: SONNET }, port: port(), costStore: memoryCost(), search }, { pageId: 'synth-fr-01', image: new Uint8Array([1, 2, 3]) })).rejects.toThrow(/image invalide/);
    await expect(runPage({ models: { haiku: ARN, sonnet: SONNET }, port: port(), costStore: memoryCost(), search }, { pageId: 'real-hist-01', image: JPEG })).rejects.toThrow(/non autorisee/);
  });
});
