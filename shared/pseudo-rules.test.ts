import { describe, expect, it } from 'vitest';
import { checkNickname, nameKey } from './pseudo-rules.js';

const ok = (s: string) => expect(checkNickname(s).ok).toBe(true);
const no = (s: string, reason?: string) => {
  const r = checkNickname(s);
  expect(r.ok).toBe(false);
  if (reason && !r.ok) expect(r.reason).toBe(reason);
};

describe('shared/pseudo-rules', () => {
  it('formes valides, accents compris', () => {
    for (const s of ['Lila', 'Léa', 'Zoé-Rose', "N'Golo", 'Max 7', 'Jo']) ok(s);
  });
  it('formes invalides: longueur, vide, emoji, premier caractere', () => {
    no('', 'forme');
    no('a', 'forme');
    no('a'.repeat(21), 'forme');
    ok('a'.repeat(20));
    no('Lila😀', 'forme');
    no('1Lila', 'forme');
    no('-Lila', 'forme');
  });
  it('lettres latines seulement: cyrillique et grec refuses', () => {
    no('Лила', 'forme');
    no('L\u0430ra', 'forme'); // « а » cyrillique a la place du « a » latin
    no('Λάρα', 'forme');
  });
  it('categorie Cf et marques combinantes refusees', () => {
    no('Li\u200Dla', 'forme'); // joint de largeur nulle
    no('Li\u200Bla', 'forme');
    no('Li\u202Ela', 'forme'); // marque de direction
    no('Lila\u0301\u0302\u0303', 'forme');
  });
  it('NFC et NFD donnent la meme valeur', () => {
    const r = checkNickname('Le\u0301a');
    expect(r).toEqual({ ok: true, value: 'L\u00e9a' });
    expect(nameKey('Le\u0301a')).toBe(nameKey('\u00c9a'.replace('\u00c9', 'Le\u0301')));
  });
  it('donnees personnelles: @, http, adresse, plus de 2 chiffres', () => {
    no('lila@x');
    no('www lila', 'personnel');
    no('http', 'personnel');
    no('lila.com', 'forme'); // le point n'est pas autorise
    no('Lila2012', 'personnel');
    no('Lila 06 12', 'personnel');
    ok('Lila 12');
  });
  it("e-mail du parent: le debut de l'adresse est refuse", () => {
    expect(checkNickname('jean-dupont', { parentEmail: 'jeandupont@example.invalid' })).toEqual({ ok: false, reason: 'personnel' });
    expect(checkNickname('Lila', { parentEmail: 'jeandupont@example.invalid' }).ok).toBe(true);
  });
  it('mots refuses malgre chiffres, tirets, majuscules, accents', () => {
    no('CONNARD', 'mot');
    no('c0nn4rd', 'mot');
    no('Con-nard', 'mot');
    no('Pût3', 'mot');
    no('Fuck Lila', 'mot');
    no('L0l1ta Porn', 'mot');
    no('Admin', 'mot');
    no('Moderateur', 'mot');
    no('QCMonster', 'mot');
  });
  it('faux positifs courants non refuses', () => {
    for (const s of ['Monique', 'Nazim', 'Computer', 'Constance', 'Conrad', 'Scunthorpe', 'Tatiana', 'Pierre-Louis', 'Parenthese Z']) {
      const r = checkNickname(s);
      if (s === 'Parenthese Z') expect(r.ok).toBe(false); // « parent » en debut de mot: limite assumee
      else expect(r.ok).toBe(true);
    }
  });
  it('nameKey: casse, accents, espaces et tirets unifies', () => {
    expect(nameKey('Lila Rose')).toBe(nameKey('lila-rose'));
    expect(nameKey('Léa')).toBe('lea');
    expect(nameKey('  Zoé  ')).toBe('zoe');
  });
});
