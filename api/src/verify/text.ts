// Texte: normalisation, nettoyage des passages (anti-injection), comparaison de citations. Fonctions pures.

/** Minuscules, sans accents ni ponctuation, espaces uniques. Sert aux comparaisons (citation dans passage, empreinte). */
export const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/** Une citation de moins de 15 caracteres normalises ne prouve rien. */
export const MIN_CITATION_CHARS = 15;
export const MAX_PASSAGE_CHARS = 1200;

export const isCitationOf = (citation: string, passageText: string): boolean => {
  const c = normalize(citation);
  return c.length >= MIN_CITATION_CHARS && normalize(passageText).includes(c);
};

export const splitSentences = (s: string): string[] =>
  s
    .split(/(?<=[.!?…])\s+/u)
    .map((x) => x.trim())
    .filter(Boolean);

/**
 * Phrases qui ressemblent a une consigne adressee au modele (francais et anglais). Une phrase qui correspond est retiree
 * du passage AVANT stockage: le modele ne la voit jamais et elle ne peut pas servir de citation.
 * shortcut: liste de motifs, pas un detecteur complet. La vraie defense est l'architecture (le modele ne fournit ni URL ni
 * extrait, sortie JSON stricte, citation verifiee par code); ce filtre retire le bruit evident.
 */
const INJECTION =
  /ignor(?:e|ez|er)\b.{0,60}(?:consigne|instruction|pr[eé]c[eé]dent|above|previous)|ignore (?:all |the |any )?(?:previous|above|prior)|disregard|oublie\b.{0,40}(?:consigne|instruction)|r[eé]ponds?\s+(?:que|simplement|uniquement|toujours)|r[eé]pondez|cette affirmation (?:est|doit|soit)|marque (?:cette|l')|tu (?:dois|es maintenant)|vous devez r[eé]pondre|you (?:must|are now|should respond)|system prompt|prompt syst[eè]me|nouvelles? (?:consignes?|instructions?)|INJECTION-OK|\bassistant\s*:|\bsystem\s*:/iu;

export const looksInjected = (sentence: string): boolean => INJECTION.test(sentence);

/** Neutralise les chevrons: un texte non fiable ne peut pas fermer une balise de donnee du prompt. */
export const defang = (s: string): string => s.replace(/</g, '‹').replace(/>/g, '›');

const ENTITIES: Record<string, string> = { '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&nbsp;': ' ' };

/**
 * Texte brut sur: retire balises HTML, entites courantes, caracteres de controle, phrases d'injection; borne a 1 200 caracteres
 * en coupant sur une fin de phrase. Renvoie le nombre de phrases retirees (journalise, jamais le texte).
 */
export function cleanPassage(raw: string): { text: string; dropped: number } {
  const plain = raw
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(?:amp|lt|gt|quot|#39|nbsp);/g, (m) => ENTITIES[m])
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const sentences = splitSentences(plain);
  const kept = sentences.filter((s) => !looksInjected(s));
  let text = '';
  for (const s of kept) {
    if ((text + ' ' + s).trim().length > MAX_PASSAGE_CHARS) break;
    text = (text + ' ' + s).trim();
  }
  if (!text && kept[0]) text = kept[0].slice(0, MAX_PASSAGE_CHARS);
  return { text: defang(text), dropped: sentences.length - kept.length };
}

const STOP = new Set(
  'le la les un une des du de d l et ou en au aux a est sont etait ete etre dans sur sous par pour avec sans ce cet cette ces se sa son ses leur leurs qui que quoi dont il elle ils elles on ne pas plus ni mais donc car comme the of and to in is are was'.split(' '),
);

/** Requete de recherche construite PAR LE CODE a partir de l'affirmation (le modele n'intervient pas). */
export function buildQuery(claimText: string, maxWords = 8): string {
  const words: string[] = [];
  for (const w of normalize(claimText).split(' ')) {
    if (w.length > 2 && !STOP.has(w) && !words.includes(w)) words.push(w);
    if (words.length >= maxWords) break;
  }
  return words.join(' ');
}

/** Empreinte de cache: texte normalise (meme affirmation, meme verdict). */
export const claimFingerprintText = (claimText: string): string => normalize(claimText);
