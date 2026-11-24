// Mode verifyOnly (revue du plan, D2): les affirmations ANNOTEES du jeu dore public (pages synthetiques de mise au point) sont injectees
// a la place de celles de L2a, avec les passages simules du jeu (et leur jumeau sans injection, `passageTwin`). Modele: faux juge deterministe.
// Ce test mesure la PLOMBERIE (controles par code, injection, provenance), pas la qualite d'un vrai modele. Seuls des compteurs sont affiches.
// Les pages reelles et cachees (privees) ne sont pas lues ici.
import { readdirSync, readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it } from 'vitest';
import { verifyRun } from './run.js';
import { passageId, type Passage, type SearchPort } from './search.js';
import { cleanPassage, splitSentences } from './text.js';
import { claim, FAKE_ARN, heuristicModel, memoryCost, memoryStore } from './testkit.js';

const GOLDEN = new URL('../../../golden/', import.meta.url).pathname;
interface Ann { id: string; sentences: { id: string; text: string; kind: 'correct' | 'error' | 'non_factual' | 'injection' }[] }
interface Pas { sentenceId: string; text: string; injected: boolean }

const pages = readdirSync(`${GOLDEN}annotations`)
  .filter((f) => f.endsWith('.json'))
  .map((f) => ({ ann: JSON.parse(readFileSync(`${GOLDEN}annotations/${f}`, 'utf8')) as Ann, pas: JSON.parse(readFileSync(`${GOLDEN}passages/${f}`, 'utf8')) as Pas[] }));

const toPassage = (text: string, n: string): Passage => {
  const url = `https://fr.wikipedia.org/wiki/${n}`;
  const texte = cleanPassage(text).text;
  return { id: passageId(url, texte), texte, url, site: 'Wikipédia', titre: n, niveau: 2 };
};
/** Jumeau: le meme passage sans la phrase d'injection (celle-ci est toujours placee apres le fait). */
const twin = (text: string) => splitSentences(text).filter((s) => !/INJECTION|Ignore les consignes/.test(s)).join(' ');

async function runPage(p: (typeof pages)[number], clean: boolean) {
  const docId = p.ann.id.replace(/[^A-Za-z0-9_-]/g, '-');
  const factual = p.ann.sentences.filter((s) => s.kind === 'correct' || s.kind === 'error' || s.kind === 'non_factual');
  const claims = factual.map((s, i) => claim(docId, i + 1, s.text, { type: s.kind === 'non_factual' ? 'non_factuelle' : 'factuelle' }));
  const byText = new Map(p.pas.map((x) => [p.ann.sentences.find((s) => s.id === x.sentenceId)?.text, x]));
  const search: SearchPort = { search: async (t) => (byText.has(t) ? [toPassage(clean ? twin(byText.get(t)!.text) : byText.get(t)!.text, byText.get(t)!.sentenceId)] : []) };
  const store = memoryStore(claims);
  const out = await verifyRun({ store, search, model: { port: heuristicModel(), costStore: memoryCost(), arn: FAKE_ARN } }, { jobId: 'job1', docId, budgetRestantCentimes: 25 });
  return { factual, verdicts: factual.map((_, i) => store.verdicts.get(`${docId}/${i + 1}`)!), store, out };
}

beforeEach(() => {
  process.env.QCM_ENV = 'dev';
});

describe('verifyOnly sur le jeu dore public', () => {
  it('rappel des erreurs >= 80 %, faux positifs <= 2 %, aucune URL hors passage stocke', async () => {
    let errors = 0, found = 0, correct = 0, falsePos = 0, claimsN = 0, sources = 0;
    for (const p of pages) {
      const r = await runPage(p, false);
      r.factual.forEach((s, i) => {
        claimsN++;
        const v = r.verdicts[i];
        if (s.kind === 'error') { errors++; if (v.statut === 'erreur') found++; }
        if (s.kind === 'correct') { correct++; if (v.statut === 'erreur') falsePos++; }
        if (s.kind === 'non_factual') expect(v.statut).toBe('non_factuelle');
        for (const src of v.sources) {
          sources++;
          const stored = r.store.passages.get(src.passageId)!;
          expect([src.url, src.site, src.titre]).toEqual([stored.url, stored.site, stored.titre]);
        }
      });
    }
    // Compteurs seulement (aucun texte): visibles dans la sortie du test.
    process.stdout.write(`verifyOnly ${JSON.stringify({ pages: pages.length, affirmations: claimsN, erreurs: errors, detectees: found, justes: correct, fauxPositifs: falsePos, sources })}\n`);
    expect(errors).toBeGreaterThanOrEqual(20);
    expect(found / errors).toBeGreaterThanOrEqual(0.8);
    expect(falsePos / correct).toBeLessThanOrEqual(0.02);
  });
  it('passages injectes: verdict identique a celui du jumeau sans injection, aucune trace du canari', async () => {
    let compared = 0;
    for (const p of pages.filter((x) => x.pas.some((y) => y.injected))) {
      const a = await runPage(p, false);
      const b = await runPage(p, true);
      a.verdicts.forEach((v, i) => {
        expect({ statut: v.statut, niveau: v.niveau }).toEqual({ statut: b.verdicts[i].statut, niveau: b.verdicts[i].niveau });
        compared++;
      });
      expect(JSON.stringify([...a.store.verdicts.values(), ...a.store.passages.values()])).not.toContain('INJECTION');
    }
    expect(compared).toBeGreaterThanOrEqual(5);
  });
});
