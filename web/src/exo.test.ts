import { describe, expect, it } from 'vitest';
import { ApiError } from './api';
import { bilanOf, checkPhoto, copieEndMessage, exoError, exoLineLabel, finaleStatus, hasExercices, pointsLeft, stepStatus, triesText } from './exo';
import { KIND_LABEL, lineLabel, modeLabel, verdict } from './history';

const e409 = (code: string, resetDate?: string) => new ApiError(409, code, 'x', resetDate);

describe('points restants', () => {
  it('retire 20 % par indice, jamais sous 4', () => {
    expect([0, 1, 2, 3, 4, -1].map(pointsLeft)).toEqual([10, 8, 6, 4, 4, 10]);
  });
});

describe('libellés des étapes', () => {
  it('suit la liste de la mission', () => {
    expect(stepStatus('ok').label).toBe('Juste');
    expect(stepStatus('partiel').label).toBe('À compléter');
    expect(stepStatus('faux').label).toBe('Faux');
    expect(stepStatus('absent').label).toBe('Pas trouvé');
    expect(stepStatus('reporte').label).toBe("Cohérent avec ton erreur d'avant");
    expect(stepStatus('inconnu').label).toBe('À revoir');
    expect(finaleStatus('fausse').label).toBe('Faux');
  });
  it('bilan: celui du serveur, sinon calculé', () => {
    expect(bilanOf({ bilan: '3 étapes sur 5' })).toBe('3 étapes sur 5');
    expect(bilanOf({ etapes: [{ id: 'a', libelle: '', indice: '', statut: 'ok' }, { id: 'b', libelle: '', indice: '', statut: 'reporte' }, { id: 'c', libelle: '', indice: '', statut: 'faux' }] })).toBe('2 étapes sur 3');
  });
  it('corrections restantes', () => {
    expect(triesText(3)).toBe('Il te reste 3 corrections pour cet exercice.');
    expect(triesText(1)).toBe('Il te reste 1 correction pour cet exercice.');
    expect(triesText(0)).toMatch(/utilisé tes 3 corrections/);
  });
});

describe('messages d’erreur', () => {
  it('chaque code 409 a une phrase simple avec accents', () => {
    for (const c of ['matiere_non_prevue', 'plafond_exercices', 'fiche_trop_courte', 'pas_encore', 'solution_vue', 'trop_tot', 'deja_en_cours', 'quota_copies', 'plafond_copies', 'en_correction']) {
      const m = exoError(e409(c));
      expect(m.length, c).toBeGreaterThan(20);
      expect(m, c).not.toBe(exoError(e409('inconnu')));
    }
  });
  it('quota: date de remise à zéro', () => {
    expect(exoError(e409('quota_copies', '2026-12-01T00:00:00Z'))).toMatch(/1 décembre/);
    expect(exoError(e409('quota_copies'))).toMatch(/mois prochain/);
  });
  it('429, 403 et erreur réseau', () => {
    expect(exoError(new ApiError(429, 'erreur', 'x'))).toMatch(/un peu vite/);
    expect(exoError(new ApiError(403, 'interdit', 'x'))).toMatch(/élève/);
    expect(exoError(new Error('Envoi impossible (500)'), 'envoi')).toMatch(/photo/);
    expect(exoError(new ApiError(409, 'etat_invalide', 'x'), 'indice')).toMatch(/tous les indices/);
  });
});

describe('copie qui ne sera pas corrigée', () => {
  it('illisible: phrase imposée', () => {
    expect(copieEndMessage({ etat: 'illisible' })).toBe("Je n'arrive pas à lire, reprends en photo plus net. Ça ne compte pas dans tes essais.");
    expect(copieEndMessage({ etat: 'echec', motif: 'copie_deja_rendue' })).toMatch(/déjà été rendue/);
    expect(copieEndMessage({ etat: 'echec', motif: 'technique' })).toMatch(/pas marché/);
    expect(copieEndMessage({ etat: 'corrigee' })).toBeNull();
  });
});

describe('photos', () => {
  const jpg = { name: 'a.jpg', type: 'image/jpeg', size: 1000 };
  it('refuse le mauvais type, le poids, le 4e et un type mélangé', () => {
    expect(checkPhoto(jpg, [])).toBeNull();
    expect(checkPhoto({ ...jpg, type: 'image/gif' }, [])).toMatch(/JPEG ou PNG/);
    expect(checkPhoto({ ...jpg, size: 4 * 1024 * 1024 }, [])).toMatch(/trop lourde/);
    expect(checkPhoto(jpg, [jpg, jpg, jpg])).toMatch(/3 pages au maximum/);
    expect(checkPhoto({ ...jpg, type: 'image/png' }, [jpg])).toMatch(/même type/);
  });
});

describe('matières et historique', () => {
  it('exercices seulement en maths et physique', () => {
    expect(hasExercices('maths') && hasExercices('physique')).toBe(true);
    expect(hasExercices('svt') || hasExercices(undefined)).toBe(false);
  });
  it('lignes kind: exo', () => {
    expect(lineLabel({ kind: 'exo', rank: 1, questionId: 'D1:exo:01#e1' })).toBe('Étape 1');
    expect(lineLabel({ kind: 'exo', rank: 4, questionId: 'D1:exo:01#f' })).toBe('Résultat final');
    expect(exoLineLabel('D1:exo:01#zz', 2)).toBe('Étape 2');
    expect(lineLabel({ kind: 'qcm', rank: 3, questionId: 'q' })).toBe('Question 3');
    expect(modeLabel('exercice')).toBe('Exercice');
    expect(KIND_LABEL.exo).toBe('Exercice');
    expect(verdict({ kind: 'exo', correct: true, attempts: 1, firstTry: true }).text).toBe('Juste');
    expect(verdict({ kind: 'exo', correct: false, attempts: 1, firstTry: false }).text).toBe('À revoir');
  });
});
