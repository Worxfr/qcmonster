import { describe, expect, it } from 'vitest';
import { dataFormula, parseEnonce } from './enonce';

const CHIMIE = 'Une solution colorée est placée dans une cuve de trajet optique $l = 1{,}0\\ \\mathrm{cm}$. Sa concentration vaut $c = 2{,}0\\times10^{-5}\\ \\mathrm{mol\\cdot L^{-1}}$.\nLe coefficient d\'absorption molaire vaut $\\varepsilon_{450} = 1{,}2\\times10^{4}\\ \\mathrm{L\\cdot mol^{-1}\\cdot cm^{-1}}$ à 450 nm et $\\varepsilon_{650} = 3{,}0\\times10^{3}\\ \\mathrm{L\\cdot mol^{-1}\\cdot cm^{-1}}$ à 650 nm. On rappelle la loi de Beer-Lambert $A = \\varepsilon\\, l\\, c$. Quel pourcentage de la lumière incidente à 650 nm est absorbé ?';
const plain = (s: { text?: string; math?: string }[]) => s.map((x) => x.text ?? `$${x.math}$`).join('');

describe('dataFormula', () => {
  it('reconnaît symbole = valeur unité', () => {
    expect(dataFormula('l = 1{,}0\\ \\mathrm{cm}')).toBe(true);
    expect(dataFormula('c = 2{,}0\\times10^{-5}\\ \\mathrm{mol\\cdot L^{-1}}')).toBe(true);
    expect(dataFormula('m = 0{,}2\\ \\mathrm{kg}')).toBe(true);
  });
  it('refuse une relation ou une définition', () => {
    expect(dataFormula('E_c = \\dfrac{1}{2} m v^2')).toBe(false);
    expect(dataFormula('f(x) = 3x - 5')).toBe(false);
    expect(dataFormula('A = \\varepsilon l c')).toBe(false);
    expect(dataFormula('x')).toBe(false);
    expect(dataFormula('a = b = 2')).toBe(false);
  });
});

describe('parseEnonce', () => {
  it('sépare contexte, données et question (exemple de chimie)', () => {
    const e = parseEnonce(CHIMIE)!;
    expect(e).not.toBeNull();
    expect(e.questions).toHaveLength(1);
    expect(plain(e.questions[0])).toBe('Quel pourcentage de la lumière incidente à 650 nm est absorbé ?');
    expect(e.donnees.map((d) => d.tex.split('=')[0].trim())).toEqual(['l', 'c', '\\varepsilon_{450}', '\\varepsilon_{650}']);
    expect(e.donnees.map((d) => d.label)).toEqual(['Trajet optique', 'Concentration', "Coefficient d'absorption molaire (à 450 nm)", "Coefficient d'absorption molaire (à 650 nm)"]);
    expect(e.contexte.map(plain)[0]).toBe('Une solution colorée est placée dans une cuve.');
    // la phrase de contexte garde son texte, la loi de Beer-Lambert n'est pas une donnée
    expect(e.contexte.map(plain).join(' ')).toContain('Beer-Lambert');
    expect(e.donnees.some((d) => d.tex.startsWith('A '))).toBe(false);
  });
  it('énoncé de maths court: contexte, données, question', () => {
    const e = parseEnonce('Un triangle $ABC$ est rectangle en $A$ avec $AB = 6$ et $AC = 8$.\nCalcule $BC$.')!;
    expect(e.donnees.map((d) => d.tex)).toEqual(['AB = 6', 'AC = 8']);
    expect(e.questions.map(plain)).toEqual(['Calcule $BC$.']);
  });
  it('sans verbe clair devant la valeur: pas de nom inventé, la phrase reste en contexte', () => {
    const e = parseEnonce('Une balle de masse $m = 0{,}2\\ \\mathrm{kg}$ roule à $v = 3\\ \\mathrm{m/s}$.\nCalcule son énergie.')!;
    expect(e.donnees.every((d) => d.label === undefined)).toBe(true);
    expect(plain(e.contexte[0])).toContain('roule à');
  });
  it('plusieurs questions, numérotation retirée du texte', () => {
    const e = parseEnonce('Soit $f(x) = 3x - 5$.\n1. Calcule $f(4)$.\n2) Trouve le nombre $x$ tel que $f(x) = 7$.')!;
    expect(e.questions.map(plain)).toEqual(['Calcule $f(4)$.', 'Trouve le nombre $x$ tel que $f(x) = 7$.']);
  });
  it('repli: pas de question ni de donnée, ou $ impair, ou texte vide', () => {
    expect(parseEnonce('Une phrase simple sans consigne ni valeur chiffrée dans ce texte.')).toBeNull();
    expect(parseEnonce('')).toBeNull();
  });
  it('un $ impair est nettoyé par le filtre partagé, sans plantage', () => {
    expect(() => parseEnonce('Il paie 5 $ pour un livre. Combien reste-t-il ?')).not.toThrow();
  });
  it('une formule dangereuse perd ses délimiteurs (filtre partagé) et ne devient jamais une donnée', () => {
    const e = parseEnonce('Soit $\\input{x} = 3$. Calcule la valeur de la grandeur demandée.')!;
    expect(e.donnees).toHaveLength(0);
  });
  it('plus de 12 valeurs: repli sur un seul bloc', () => {
    const many = Array.from({ length: 13 }, (_, i) => `$a_{${i}} = ${i + 1}$`).join(' ; ') + '. Calcule la somme.';
    expect(parseEnonce(many)).toBeNull();
  });
});
