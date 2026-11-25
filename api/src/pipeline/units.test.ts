import { describe, expect, it } from 'vitest';
import { DUPLICATE_THRESHOLD, jaccard, minhash, shingles, similarity } from './fingerprint.js';
import { anchorClaims, questionCap, shuffleChoices, validGap, validQcm } from './steps-doc.js';
import { imageFormat } from './steps.js';
import { normalize, parseModelJson, splitSentences } from './text.js';
import { z } from 'zod';

const lorem = (n: number, seed = 0) => Array.from({ length: n }, (_, i) => `mot${(Math.imul(i + 1 + seed * 1000, 2654435761) >>> 0) % 100000}x`).join(' ');

describe('empreinte anti-doublon', () => {
  it('texte identique: 1; accents, casse et ponctuation ignores', () => {
    const t = 'La photosynthèse se déroule dans les chloroplastes des cellules végétales vertes.';
    expect(similarity(minhash(t), minhash(t.toUpperCase().replace(/,/g, '')))).toBe(1);
    expect(minhash(t)).toHaveLength(64);
  });
  it('quelques mots changes dans un long texte restent au-dessus du seuil, un autre cours en dessous', () => {
    const a = lorem(400);
    const b = a.split(' ').map((w, i) => (i === 200 ? 'different' : w)).join(' ');
    expect(jaccard(a, b)).toBeGreaterThan(0.95);
    expect(similarity(minhash(a), minhash(b))).toBeGreaterThanOrEqual(DUPLICATE_THRESHOLD);
    expect(similarity(minhash(a), minhash(lorem(400, 3)))).toBeLessThan(0.3);
  });
  it('mots de moins de 3 lettres retires; texte court = un groupe', () => {
    expect([...shingles('le la un de photosynthese')]).toEqual(['photosynthese']);
    expect(shingles('').size).toBe(0);
  });
});

describe('texte', () => {
  it('normalisation et phrases', () => {
    expect(normalize('  Été, À-bientôt !')).toBe('ete a bientot');
    expect(splitSentences('Une phrase. Une autre phrase ? Oui.\nLigne deux')).toEqual(['Une phrase.', 'Une autre phrase ?', 'Oui.', 'Ligne deux']);
  });
  it('JSON du modele: texte autour ignore, schema impose', () => {
    const s = z.object({ a: z.number() });
    expect(parseModelJson('Voici ```json {"a": 1} ```', s)).toEqual({ a: 1 });
    expect(() => parseModelJson('rien', s)).toThrow();
    expect(() => parseModelJson('{"a":"x"}', s)).toThrow();
  });
  it('type de fichier lu sur les octets', () => {
    expect(imageFormat(new Uint8Array([0xff, 0xd8, 0xff, 0]))).toBe('jpeg');
    expect(imageFormat(new Uint8Array([0x47, 0x49, 0x46]))).toBeUndefined();
  });
});

describe('controles par code', () => {
  const sentences = new Map([['p1-s1', 'Mendel a mené ses expériences au XIXe siècle.']]);
  const base = { texte: 'Mendel a travaille au XIXe siecle.', type: 'factuelle' as const, aRisque: true };
  it('une consigne d exercice n est jamais une affirmation (T3 B2)', () => {
    const r = anchorClaims([{ ...base, phraseId: 'p1-s1', extrait: 'expériences au XIXe', type: 'consigne' }], sentences);
    expect(r.kept).toHaveLength(0);
  });
  it('nombre de questions: une pour deux faits, de 1 a 5 (T3 B3)', () => {
    expect([1, 2, 3, 4, 8, 14, 60].map(questionCap)).toEqual([1, 1, 2, 2, 4, 5, 5]);
  });
  it('ancrage: phrase inconnue, extrait absent, extrait d un mot, doublon: supprimes', () => {
    const r = anchorClaims(
      [
        { ...base, phraseId: 'p1-s1', extrait: 'expériences au XIXe' },
        { ...base, phraseId: 'p1-s1', extrait: 'expériences au XIXe', texte: 'mendel a travaille au xixe siecle' },
        { ...base, phraseId: 'p1-s1', extrait: 'au XVIIIe siècle', texte: 'Autre texte valide ici.' },
        { ...base, phraseId: 'p2-s1', extrait: 'expériences au XIXe', texte: 'Phrase inconnue ici.' },
        { ...base, phraseId: 'p1-s1', extrait: 'Mendel', texte: 'Un seul mot ancre ici.' },
      ],
      sentences,
    );
    expect(r.kept).toHaveLength(1);
    expect(r.kept[0].page).toBe(1);
    expect(r.dropped).toBe(4);
  });
  const elig = new Map([['01', { id: '01', texte: 'La chlorophylle donne sa couleur verte aux feuilles.' }]]);
  it('QCM: 4 choix distincts, affirmation eligible', () => {
    const q = { claimId: '01', enonce: 'Quelle couleur ?', choix: ['Verte', 'Rouge', 'Bleue', 'Jaune'], cle: 0 };
    expect(validQcm(q, elig)).toBe(true);
    expect(validQcm({ ...q, claimId: '02' }, elig)).toBe(false);
    expect(validQcm({ ...q, choix: ['Verte', 'verte', 'Bleue', 'Jaune'] }, elig)).toBe(false);
    expect(validQcm({ ...q, cle: 4 }, elig)).toBe(false);
  });
  it('trou: mot dans l affirmation, absent de la phrase, un seul blanc', () => {
    const g = { claimId: '01', phrase: 'La chlorophylle donne sa couleur ____ aux feuilles.', attendu: 'verte' };
    expect(validGap(g, elig)).toBe(true);
    expect(validGap({ ...g, attendu: 'rouge' }, elig)).toBe(false);
    expect(validGap({ ...g, phrase: 'La ____ donne sa ____ verte.' }, elig)).toBe(false);
    expect(validGap({ ...g, phrase: 'Elle est verte et ____ vraiment.' }, elig)).toBe(false);
  });
  it('melange: bonne reponse conservee, resultat stable', () => {
    const c = ['a', 'b', 'c', 'd'];
    for (let cle = 0; cle < 4; cle++) {
      const s = shuffleChoices(c, cle, `q:qcm:0${cle}`);
      expect(s.choix[s.cle]).toBe(c[cle]);
      expect([...s.choix].sort()).toEqual(c);
      expect(shuffleChoices(c, cle, `q:qcm:0${cle}`)).toEqual(s);
    }
  });
});

describe('F6: le faux modele ne produit pas de transcription', () => {
  it('sa reponse {} est refusee par le schema de transcription (cause du B1 quand QCM_BEDROCK=mock sur dev)', async () => {
    const { mockModelPort } = await import('../../../shared/bedrock.js');
    const { z } = await import('zod');
    const out = await mockModelPort().converse({ modelArn: 'x', prompt: 'p', maxTokens: 1 } as never);
    expect(() => parseModelJson(out.text, z.object({ docType: z.enum(['cours', 'exercice', 'autre']), text: z.string() }))).toThrow(/schema invalide/);
  });
});
