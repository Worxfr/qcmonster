// Texte: normalisation, nettoyage des passages (anti-injection), comparaison de citations. Fonctions pures.

/** Minuscules, sans accents ni ponctuation, espaces uniques. Sert aux comparaisons (citation dans passage, empreinte). */
export const normalize = (s: string): string =>
  s
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();

/**
 * Une citation de moins de 10 caracteres normalises ne prouve rien (V4: 15 avant; une citation courte mais exacte, comme un groupe de mots
 * decisif, est acceptee). Une citation avec des points de suspension est acceptee si chaque morceau est exact, et un morceau au moins atteint le minimum.
 */
export const MIN_CITATION_CHARS = 10;
export const MAX_PASSAGE_CHARS = 1200;

export const isCitationOf = (citation: string, passageText: string): boolean => {
  const hay = normalize(passageText);
  const parts = citation.split(/\s*(?:\.{3}|…|\[\.\.\.\])\s*/u).map(normalize).filter(Boolean);
  return parts.length > 0 && parts.some((c) => c.length >= MIN_CITATION_CHARS) && parts.every((c) => hay.includes(c));
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
export function cleanPassage(raw: string, maxChars = MAX_PASSAGE_CHARS): { text: string; dropped: number } {
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
    if ((text + ' ' + s).trim().length > maxChars) break;
    text = (text + ' ' + s).trim();
  }
  if (!text && kept[0]) text = kept[0].slice(0, maxChars);
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

/**
 * V3: requete pour Wikipédia. Les nombres en sont exclus: une erreur inseree porte un MAUVAIS nombre, qui oriente la recherche vers un article
 * ou le fait n'est pas (mesure hors ligne: le passage contenait la bonne valeur pour 16 erreurs sur 30). Les noms propres (majuscule hors debut de phrase)
 * passent d'abord, puis les autres mots dans l'ordre. `buildQuery` reste utilise pour les index figes (les nombres y aident).
 * shortcut: heuristique de majuscule, sans lexique; a remplacer par un classement lexical si le rappel de la recherche stagne.
 */
export function buildWikiQuery(claimText: string, maxWords = 6): string {
  const proper: string[] = [];
  const rest: string[] = [];
  const tokens = claimText.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
  tokens.forEach((raw, i) => {
    const w = normalize(raw);
    if (w.length <= 2 || STOP.has(w) || /^\d+$/.test(w) || proper.includes(w) || rest.includes(w)) return;
    (i > 0 && /^\p{Lu}/u.test(raw) ? proper : rest).push(w);
  });
  return [...proper, ...rest].slice(0, maxWords).join(' ');
}

/** Empreinte de cache: texte normalise (meme affirmation, meme verdict). */
export const claimFingerprintText = (claimText: string): string => normalize(claimText);

/**
 * Extrait d'un article entier (texte brut) pour une requete: les deux premieres phrases (le sujet), puis les phrases qui contiennent le
 * plus de mots de la requete (les nombres comptent un peu plus), dans l'ordre de l'article, jusqu'a `maxChars`. Les titres de section
 * ("== X ==") sont ignores. Le resultat passe ensuite par cleanPassage (anti-injection, bornes).
 * shortcut: score par mots communs, sans lemmatisation; a remplacer par un classement lexical si le rappel stagne.
 */
export function relevantExcerpt(article: string, query: string, maxChars: number, wantNumbers = false): string {
  const sentences = article
    .split(/\n+/)
    .filter((l) => l.trim() && !/^\s*=+.*=+\s*$/.test(l))
    .flatMap((l) => splitSentences(l));
  const words = new Set(query.split(' ').filter(Boolean));
  const score = (sent: string): number => {
    const have = new Set(normalize(sent).split(' '));
    let n = 0;
    for (const w of words) if (have.has(w)) n += /^\d+$/.test(w) ? 1.5 : 1;
    // V3: la requete n'a plus de nombres (celui de l'affirmation peut etre faux); une phrase qui en porte un est preferee a mots communs egaux.
    return n > 0 && wantNumbers && /\d/.test(sent) ? n + 0.75 : n;
  };
  const picked = new Set<number>([0].filter((i) => i < sentences.length));
  let used = [...picked].reduce((n, i) => n + sentences[i].length + 1, 0);
  const ranked = sentences.map((t, i) => ({ i, sc: score(t) })).filter((x) => x.sc >= Math.min(2, words.size) && !picked.has(x.i)).sort((a, b) => b.sc - a.sc || a.i - b.i);
  for (const { i } of ranked) {
    if (used + sentences[i].length + 1 > maxChars) continue;
    picked.add(i);
    used += sentences[i].length + 1;
  }
  return [...picked].sort((a, b) => a - b).map((i) => sentences[i]).join(' ');
}
