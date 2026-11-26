// F11: l'extraction d'une section dense passe par des tranches; l'eleve n'a jamais a redecouper. Faux modele, aucun cout.
import { describe, expect, it, vi } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import * as api from './api.js';
import { jobKey } from './ctx.js';
import { guarded } from './http.js';
import { scansPrefix } from './job.js';
import { awaitConfirm, awaitUpload, failJob, MSG, scanCheck, scanStart, transcribe } from './steps.js';
import { anchorClaims, extract } from './steps-doc.js';
import { sliceRanges, thinEvenly } from './text.js';
import { classifyJson, event, goodScript, JPEG, makeCtx, readJson } from './testkit.js';

const scansCreate = guarded(api.scansCreate);
const jobsConfirm = guarded(api.jobsConfirm);
type K = Awaited<ReturnType<typeof makeCtx>>;

/** Section de `n` phrases denses sur une page; mots distincts par phrase (pas de faux doublon). */
const denseLines = (n: number) => Array.from({ length: n }, (_, k) => `Le fait numero ${k + 1} concerne le theme alpha${k + 1} et la mesure beta${k + 1}.`);

/**
 * Faux modele d'extraction: une affirmation par phrase listee (contexte compris, pour verifier que le code l'ecarte), au plus `max` demandees,
 * sortie coupee en plein objet au-dela de `cutAt` caracteres (comme la limite de jetons).
 */
const denseModel = (opts: { cutAt?: number; garbageFirst?: number } = {}) => {
  let n = 0;
  return (prompt: string): string => {
    if (n++ < (opts.garbageFirst ?? 0)) return 'je ne peux pas repondre';
    const max = Number(/Maximum (\d+) affirmations/.exec(prompt)![1]);
    const lines = [...prompt.matchAll(/^\[(p\d+-s\d+)\] (.+)$/gm)];
    const claims = lines.slice(0, max + 2).map((m) => ({ phraseId: m[1], extrait: m[2].split(' ').slice(0, 4).join(' '), texte: `Affirmation: ${m[2]}`, type: 'factuelle', aRisque: false }));
    const json = JSON.stringify({ titre: 'Cours dense', matiere: 'svt', affirmations: claims });
    return opts.cutAt && json.length > opts.cutAt ? json.slice(0, opts.cutAt) : json;
  };
};

async function setup(lines: string[], extraction: (p: string) => string) {
  const k = await makeCtx(goodScript({ transcription: (pages) => readJson(pages.map((page) => ({ page, lines }))), classify: classifyJson(), extraction }));
  const created = JSON.parse((await scansCreate(k.ctx, event({ body: { pages: 1, contentType: 'image/jpeg' } }))).body ?? '{}');
  const i = { jobId: created.jobId as string, sid: 's1' };
  const key = `${scansPrefix('s1', i.jobId)}0`;
  k.s3.objects.set(key, JPEG);
  await scanStart(k.ctx, { detail: { object: { key } } });
  await awaitUpload(k.ctx, { ...i, token: 'tok-up' });
  await scanCheck(k.ctx, i);
  await transcribe(k.ctx, i);
  await awaitConfirm(k.ctx, { ...i, token: 'tok-conf' });
  await jobsConfirm(k.ctx, event({ params: { jobId: i.jobId }, body: { corrections: [] } }));
  return { k, i };
}
const claimsOf = async (k: K, docId: string) => (await k.db.query(`DOC#${docId}`, 'CLAIM#')).map((c) => (c.origine as { phraseId: string }).phraseId);
const num = (id: string) => Number(/-s(\d+)$/.exec(id)![1]);

describe('F11: tranches', () => {
  it('sliceRanges couvre tout, sans trou ni recouvrement, et respecte 30 phrases / 6000 caracteres', () => {
    const r = sliceRanges(Array.from({ length: 200 }, () => 50));
    expect(r[0].start).toBe(0);
    expect(r.at(-1)!.end).toBe(200);
    r.forEach((x, n) => {
      expect(x.end - x.start).toBeLessThanOrEqual(30);
      if (n > 0) expect(x.start).toBe(r[n - 1].end);
    });
    expect(sliceRanges([5000, 5000, 100]).map((x) => x.end - x.start)).toEqual([1, 2]);
    expect(sliceRanges([])).toEqual([]);
  });

  it('thinEvenly garde l ordre et couvre toute la liste', () => {
    const t = thinEvenly(Array.from({ length: 200 }, (_, n) => n), 60);
    expect(t).toHaveLength(60);
    expect(t[0]).toBe(0);
    expect(t.at(-1)!).toBeGreaterThan(190);
    expect([...t].sort((a, b) => a - b)).toEqual(t);
    expect(thinEvenly([1, 2], 60)).toEqual([1, 2]);
  });

  it('anchorClaims: le plafond est un parametre', () => {
    const s = new Map([['p1-s1', 'un deux trois quatre'], ['p1-s2', 'cinq six sept huit']]);
    const mk = (id: string, t: string) => ({ phraseId: id, extrait: s.get(id)!.split(' ').slice(0, 2).join(' '), texte: t, type: 'factuelle' as const, aRisque: false });
    const raw = [mk('p1-s1', 'Premiere affirmation'), mk('p1-s2', 'Seconde affirmation')];
    expect(anchorClaims(raw, s, 1).kept).toHaveLength(1);
    expect(anchorClaims(raw, s).kept).toHaveLength(2);
  });
});

describe('F11: extraction d une section dense', () => {
  it('200 phrases denses, sortie coupee au milieu: toute la section est couverte, dans l ordre, sans doublon', async () => {
    const { k, i } = await setup(denseLines(200), denseModel({ cutAt: 1500 })); // ~8 affirmations entieres par appel (quota 9 + 2 de contexte)
    const ex = await extract(k.ctx, i);
    expect(ex.ok).toBe(true);
    const ids = await claimsOf(k, ex.docId!);
    const nums = ids.map(num);
    expect(ids.length).toBeGreaterThanOrEqual(45);
    expect(ids.length).toBeLessThanOrEqual(60);
    expect(new Set(ids).size).toBe(ids.length); // une seule affirmation par phrase: pas de double comptage entre tranches
    expect([...nums].sort((a, b) => a - b)).toEqual(nums); // ordre du cours
    expect(nums[0]).toBeLessThan(20);
    expect(nums.at(-1)!).toBeGreaterThan(180); // la fin de la section n'est pas perdue
    expect(k.calls.filter((c) => c === 'extraction').length).toBeLessThanOrEqual(3 * 7 + 6);
  });

  it('tranches chevauchantes: les phrases de contexte sont envoyees mais leurs affirmations ecartees', async () => {
    const { k, i } = await setup(denseLines(65), denseModel());
    const ex = await extract(k.ctx, i);
    const ids = await claimsOf(k, ex.docId!);
    expect(new Set(ids).size).toBe(ids.length);
    // 3 tranches (30+30+5): la 2e prompt commence par les 2 phrases de contexte p1-s29 et p1-s30
    const second = k.prompts.filter((p) => p.includes('<cours>'))[1];
    expect(/^\[p1-s29\]/m.test(second)).toBe(true);
    expect(second).toContain('premieres phrases ne sont la que pour le contexte');
    expect(ids).not.toContain('p1-s29-x');
    expect(ids.length).toBe(new Set(ids).size);
  });

  it('dedoublonnage: un meme texte repete sur deux phrases n est garde qu une fois', async () => {
    const lines = Array.from({ length: 40 }, (_, k) => `La regle commune du theme gamma${k + 1} reste vraie.`);
    const same = (p: string) => JSON.stringify({ titre: 'x', matiere: 'svt', affirmations: [...p.matchAll(/^\[(p1-s\d+)\] (.+)$/gm)].map((m) => ({ phraseId: m[1], extrait: 'La regle commune', texte: 'La regle commune reste vraie.', type: 'factuelle', aRisque: false })) });
    const { k, i } = await setup(lines, same);
    const ex = await extract(k.ctx, i);
    expect(await claimsOf(k, ex.docId!)).toHaveLength(1);
  });

  it('sortie illisible sur une grande tranche: elle est coupee en deux et rejouee', async () => {
    const { k, i } = await setup(denseLines(30), denseModel({ garbageFirst: 1 }));
    const ex = await extract(k.ctx, i);
    expect(ex.ok).toBe(true);
    const nums = (await claimsOf(k, ex.docId!)).map(num);
    expect(nums.at(-1)!).toBeGreaterThan(25);
    expect(k.calls.filter((c) => c === 'extraction')).toHaveLength(3); // 1 illisible + 2 moities
  });

  it('echec persistant: erreur de sortie, message neutre sans decoupage demande, pages rendues', async () => {
    const { k, i } = await setup(denseLines(30), () => 'rien de lisible');
    await expect(extract(k.ctx, i)).rejects.toThrow('sortie du modele');
    await failJob(k.ctx, { ...i, error: { Error: 'ModelOutputError' } });
    const j = (await k.db.get(jobKey('s1', i.jobId)))!;
    expect(j.state).toBe('echec');
    expect(j.message).toBe(MSG.unreadable);
    expect(MSG.unreadable).toBe('Ce cours n’a pas pu être lu cette fois. Tes pages ne sont pas décomptées, tu peux réessayer');
    expect(j.message).not.toMatch(/deux parties|trop dense|decoup|découp/);
    expect(j.quotaState).toBe('released'); // reservation levee avant consommation (apres consommation: 'refunded', PR #62)
    expect(((await k.quota.get(keys.quota('f1', '2026-12', 's1'))) as Record<string, number>).utilise ?? 0).toBe(0);
  });

  it('cout: une section de 200 phrases reste tres sous le plafond du scan, et un rejeu ne double rien', async () => {
    const { k, i } = await setup(denseLines(200), denseModel({ cutAt: 1500 }));
    const ex = await extract(k.ctx, i);
    const cost1 = ((await k.db.get(jobKey('s1', i.jobId)))!.coutMicros as number) / 1e6;
    expect(cost1).toBeLessThan(0.1); // plafond d'une page: 0,25 EUR
    await extract(k.ctx, i); // rejeu de l'etape
    expect(await claimsOf(k, ex.docId!)).toHaveLength((await claimsOf(k, ex.docId!)).length);
    expect((await k.db.query(`DOC#${ex.docId}`, 'CLAIM#')).length).toBeLessThanOrEqual(60);
  });
});

/** Lignes `[id] texte` du prompt. */
const linesOf = (p: string) => [...p.matchAll(/^\[(p\d+-s\d+)\] (.+)$/gm)].map((m) => ({ id: m[1], text: m[2] }));
const claimJson = (id: string, text: string, src: string) => JSON.stringify({ phraseId: id, extrait: src.split(' ').slice(0, 4).join(' '), texte: text, type: 'factuelle', aRisque: false });
const head = '{"titre":"t","matiere":"svt","affirmations":[';
const logsOf = (spy: { mock: { calls: unknown[][] } }) => spy.mock.calls.map((c) => String(c[0])).filter((l) => l.includes('sentencesUncovered')).map((l) => JSON.parse(l) as Record<string, unknown>);

describe('F11: relecture PR 68 (C1 a C4)', () => {
  it('M1: une affirmation de la tranche 2 ancree sur une phrase de la tranche 1 (texte different) est ecartee', async () => {
    let call = 0;
    const model = (p: string) => (call++, head + linesOf(p).map((l) => claimJson(l.id, `Affirmation ${call} ${l.text}`, l.text)).join(',') + ']}');
    const { k, i } = await setup(denseLines(40), model);
    const ex = await extract(k.ctx, i);
    const ids = await claimsOf(k, ex.docId!);
    expect(ids).toHaveLength(40);
    expect(new Set(ids).size).toBe(40);
  });

  it('M4: des affirmations rendues dans le desordre sont triees dans l ordre du cours', async () => {
    const model = (p: string) => head + linesOf(p).reverse().map((l) => claimJson(l.id, `Fait ${l.text}`, l.text)).join(',') + ']}';
    const { k, i } = await setup(denseLines(40), model);
    const ex = await extract(k.ctx, i);
    const nums = (await claimsOf(k, ex.docId!)).map(num);
    expect(nums).toHaveLength(40);
    expect([...nums].sort((a, b) => a - b)).toEqual(nums);
  });

  it('M5: reprise ou la phrase atteinte porte une affirmation: elle n est gardee qu une fois', async () => {
    let call = 0;
    const model = (p: string) => {
      call++;
      const ls = linesOf(p);
      const mk = (l: { id: string; text: string }) => claimJson(l.id, `Fait ${call} ${l.text}`, l.text); // texte different a chaque appel: pas de dedoublonnage par texte
      if (call === 1) return head + ls.slice(0, 5).map(mk).join(',') + ',{"phraseId":"p1-s'; // coupe apres 5 affirmations entieres
      return head + ls.map(mk).join(',') + ']}';
    };
    const { k, i } = await setup(denseLines(30), model);
    const ex = await extract(k.ctx, i);
    const ids = await claimsOf(k, ex.docId!);
    expect(ids).toHaveLength(30);
    expect(new Set(ids).size).toBe(30);
  });

  it('M2: un modele qui coupe toujours sa sortie, avec un seul pas de progres, s arrete au garde-fou d appels', async () => {
    let call = 0;
    const model = (p: string) => {
      call++;
      const ls = linesOf(p);
      const ctxN = Number(/Les (\d+) premieres phrases/.exec(p)?.[1] ?? 0);
      return head + ls.slice(0, ctxN + 2).map((l) => claimJson(l.id, `Fait ${call} ${l.text}`, l.text)).join(',') + ',{"phraseId":"p1-s';
    };
    const { k, i } = await setup(denseLines(200), model);
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const ex = await extract(k.ctx, i);
      expect(ex.ok).toBe(true);
      expect(k.calls.filter((c) => c === 'extraction').length).toBe(3 * 7 + 6); // tranches x 3 + 6: sans garde-fou il en faudrait environ 200
      const l = logsOf(spy);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ stopReason: 'calls' });
      expect(l[0].sentencesUncovered as number).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  it('C1: la boucle s arrete en euros avant la reserve de generation, les affirmations lues sont gardees', async () => {
    const { k, i } = await setup(denseLines(200), denseModel());
    await k.db.update(jobKey('s1', i.jobId), { set: { coutMicros: 189_900 } }); // plafond 0,25 - reserve 0,06 = 0,19
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const ex = await extract(k.ctx, i);
      expect(ex.ok).toBe(true);
      expect(k.calls.filter((c) => c === 'extraction')).toHaveLength(1);
      expect((await claimsOf(k, ex.docId!)).length).toBeGreaterThan(0);
      const l = logsOf(spy);
      expect(l).toHaveLength(1);
      expect(l[0]).toMatchObject({ stopReason: 'budget', sentencesUncovered: 170, step: 'extraction' });
      expect(JSON.stringify(l[0])).not.toMatch(/Le fait numero/); // jamais de texte de cours
    } finally {
      spy.mockRestore();
    }
  });

  it('C2: au-dela de 12 tranches la fin de la section n est pas lue, et c est journalise', async () => {
    const { k, i } = await setup(denseLines(400), denseModel());
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      const ex = await extract(k.ctx, i);
      expect(ex.ok).toBe(true);
      expect(k.calls.filter((c) => c === 'extraction')).toHaveLength(12);
      expect(logsOf(spy)[0]).toMatchObject({ stopReason: 'size', sentencesUncovered: 40 });
    } finally {
      spy.mockRestore();
    }
  });

  it('C3: une tranche de 4 phrases illisible est sautee et journalisee', async () => {
    const { k, i } = await setup(denseLines(4), () => 'illisible');
    await expect(extract(k.ctx, i)).rejects.toThrow('sortie du modele');
    const model = denseModel();
    const { k: k2, i: i2 } = await setup(denseLines(40), (p) => (linesOf(p)[0].id === 'p1-s29' ? 'pas du json' : model(p))); // la 2e tranche (10 phrases) puis ses moities sont illisibles
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    try {
      await extract(k2.ctx, i2);
      expect(logsOf(spy)[0]).toMatchObject({ stopReason: 'skipped' });
    } finally {
      spy.mockRestore();
    }
  });
});
