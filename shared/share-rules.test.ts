// Regles pures du partage (S1 #34, docs/S1-design.md sections 2, 9 et 14).
import { describe, expect, it } from 'vitest';
import { checkTitle, loginBase, personalData, questionClean, shareableReason, SHARE_TOKEN_RE, ttlDaysOk } from './share-rules.js';

const ctx = { names: ['Lila', 'lila-k7x2p', 'Léo', 'Marie-Rose', 'Al'] };
const pd = (s: string, postal = false) => personalData(s, ctx, { postal });

describe('filtre de donnees personnelles', () => {
  it('e-mail: arobase, (at), pleine largeur', () => {
    expect(pd('ecris a jean@exemple.org')).toBe('email');
    expect(pd('jean (at) exemple')).toBe('email');
    expect(pd('jean＠exemple')).toBe('email'); // pleine largeur: NFKC
  });
  it('adresse web: http, www., domaine courant, pleine largeur', () => {
    expect(pd('va sur www.site')).toBe('web');
    expect(pd('mon-site.fr')).toBe('web');
    expect(pd('ｈｔｔｐｓ site')).toBe('web');
  });
  it('telephone: separateurs, pleine largeur, chiffres d\'une autre ecriture; une annee et un nombre de 5 chiffres restent permis', () => {
    expect(pd('appelle le 06 12 34 56 78')).toBe('telephone');
    expect(pd('appelle le 06.12.34.56.78')).toBe('telephone');
    expect(pd('appelle le 06-12-34-56-78')).toBe('telephone');
    expect(pd('appelle le (06) 12 34 56 78')).toBe('telephone');
    expect(pd('０６１２３４５６７８')).toBe('telephone');
    expect(pd('٠٦ ١٢ ٣٤ ٥٦ ٧٨')).toBe('telephone');
    // B1 (relecture #111): separateurs de 1 a 3 caracteres non alphanumeriques
    for (const s of ['06. 12. 34. 56. 78', '06 . 12 . 34 . 56 . 78', '06/12/34/56/78', '06_12_34_56_78', '06,12,34,56,78', '06, 12, 34, 56, 78', '06 / 12 / 34', '06. 12. 34', '06 - 12 - 34', '(06) 12 34 56 78', '+33 6.12.34.56.78']) expect(pd(s), s).toBe('telephone');
    expect(pd('numero 06 12 34')).toBe('telephone'); // 6 chiffres: seuil
    expect(pd('numero 06 12 3')).toBeNull(); // 5 chiffres
    expect(pd('en 1789 puis en 1815')).toBeNull();
    expect(pd('la ville compte 12345 habitants')).toBeNull();
    expect(pd('le 14 juillet 1789, 3 morts')).toBeNull(); // « 1789, 3 »: la virgule coupe la suite
  });
  it('signes invisibles retires avant le test', () => {
    expect(pd('j\u200Bean@x')).toBe('email');
    expect(pd('0\u200B6 12 34 56 78')).toBe('telephone');
    expect(pd('06\u200B12\u200B34\u200B56\u200B78')).toBe('telephone'); // retirer les signes invisibles recolle les groupes
    expect(pd('Li\u200Bla et \u2060Léo')).toBe('nom');
  });
  it('pseudo, identifiant et surnom en MOT ENTIER (leo ne refuse pas leopard), accents et casse ignores', () => {
    expect(pd('Lila adore ca')).toBe('nom');
    expect(pd('LÎLA')).toBe('nom'); // accents et casse ignores
    expect(pd('lilas en fleur')).toBeNull(); // autre mot
    expect(pd('lila-k7x2p')).toBe('nom');
    expect(pd('Ｌｉｌａ')).toBe('nom');
    expect(pd('Leo aime')).toBe('nom');
    expect(pd('le leopard court')).toBeNull();
    expect(pd('marie rose')).toBe('nom');
    expect(pd('Marie seule')).toBeNull();
  });
  it('un pseudo de moins de 3 lettres n\'est pas compare', () => {
    expect(pd('Al est la')).toBeNull();
  });
  it('adresse postale: seulement pour le titre', () => {
    expect(pd('12 rue des Lilas', true)).toBe('adresse');
    expect(pd('75001 Paris', true)).toBe('adresse');
    expect(pd('12 rue des Lilas', false)).toBeNull();
  });
});

describe('non-regression: dates et textes normaux restent permis', () => {
  it('dates, annees, calculs, numeros de page', () => {
    for (const s of ['Le 14 juillet 1789', 'Le 14/07/1789', 'Le 14.07.1789', 'le 1-12-1905', 'en 1789 puis en 1815', 'de 1914 a 1918', 'La page 12, question 3', 'Calcule 12 + 34 = 46', '3 x 4 = 12', '25 % de 80', 'x = 5, y = 12', 'Le resultat est 1,5 puis 2,25', 'Il y a 4 jeux de 52 cartes', 'La vitesse vaut 340 m/s']) expect(pd(s), s).toBeNull();
  });
  it('titres normaux', () => {
    for (const s of ['La cellule', 'Revision 3eme: les fractions', 'Chapitre 4, partie 2', 'La Revolution de 1789']) expect(checkTitle(s, ctx).ok, s).toBe(true);
  });
  it('dans le titre: les memes separateurs sont refuses', () => {
    for (const s of ['Appelle 06/12/34/56/78', 'Appelle 06, 12, 34, 56, 78', 'Appelle 06. 12. 34. 56. 78']) expect(checkTitle(s, ctx).ok, s).toBe(false);
  });
});

describe('titre', () => {
  it('forme: 3 a 60 caracteres, lettres latines, pas d\'emoji ni de signe invisible', () => {
    expect(checkTitle('  La   cellule ', ctx)).toEqual({ ok: true, value: 'La cellule' });
    expect(checkTitle('ab', ctx).ok).toBe(false);
    expect(checkTitle('a'.repeat(61), ctx).ok).toBe(false);
    expect(checkTitle('Les 😀 cellules', ctx).ok).toBe(false);
    expect(checkTitle('Les\u200B cellules', ctx).ok).toBe(false); // signe invisible: refuse
    expect(checkTitle('3 cellules', ctx).ok).toBe(false); // doit commencer par une lettre
  });
  it('donnees personnelles et mots refuses', () => {
    expect(checkTitle('Appelle 06 12 34 56 78', ctx).ok).toBe(false);
    expect(checkTitle('Le QCM de Lila', ctx).ok).toBe(false);
    expect(checkTitle('Chez moi 12 rue des Lilas', ctx).ok).toBe(false);
    expect(checkTitle('mon.mail@truc.fr', ctx).ok).toBe(false);
    expect(checkTitle('Putain de cellule', ctx).ok).toBe(false);
  });
});

describe('question et partageabilite', () => {
  it('un seul champ refuse suffit: enonce, un choix ou le mot attendu', () => {
    expect(questionClean({ prompt: 'ok', choices: ['a', 'b', 'c', 'd'] }, ctx)).toBe(true);
    expect(questionClean({ prompt: 'ok', choices: ['a', 'b', 'c', 'mail@x.fr'] }, ctx)).toBe(false);
    expect(questionClean({ prompt: 'ok ___', expected: 'Lila' }, ctx)).toBe(false);
    expect(questionClean({ prompt: 'appelle 0612345678' }, ctx)).toBe(false);
  });
  it('partageable: payee ou fiche pleine, jamais retiree', () => {
    expect(shareableReason({}, true, false)).toBeNull();
    expect(shareableReason({}, false, true)).toBeNull();
    expect(shareableReason({}, false, false)).toBe('a_jouer');
    expect(shareableReason({ retiree: true }, true, true)).toBe('retiree');
  });
});

describe('jeton et divers', () => {
  it('forme du jeton: 22 caracteres base64url', () => {
    expect(SHARE_TOKEN_RE.test('A'.repeat(22))).toBe(true);
    expect(SHARE_TOKEN_RE.test('A'.repeat(21))).toBe(false);
    expect(SHARE_TOKEN_RE.test('A'.repeat(23))).toBe(false);
    expect(SHARE_TOKEN_RE.test(`${'A'.repeat(21)}+`)).toBe(false);
    expect(SHARE_TOKEN_RE.test(`${'A'.repeat(21)}\n`)).toBe(false);
  });
  it('duree 1, 7 ou 30 jours; base d\'un identifiant', () => {
    expect([1, 7, 30].every(ttlDaysOk)).toBe(true);
    expect(ttlDaysOk(2)).toBe(false);
    expect(loginBase('lila-k7x2p')).toBe('lila');
    expect(loginBase('lila')).toBe('lila');
  });
});
