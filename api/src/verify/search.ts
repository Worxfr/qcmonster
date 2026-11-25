// Outil de recherche (etape 7, design-v2 4.3). C'EST LE CODE qui construit la requete, l'adresse, l'URL, le site, le titre et l'extrait.
// Sources: API MediaWiki (Wikipedia fr, puis en/wikibooks/wikiversity/vikidia seulement si fr ne donne rien) et index figes
// (Eduscol, NIST) empaquetes avec la Lambda, sans requete reseau.
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { guardedGetJson, FetchRefused, type FetchOptions } from './fetch.js';
import { EXCERPT_CHARS, FULL_ARTICLES_PER_CLAIM, FULL_ARTICLE_MAX_BYTES, MAX_PASSAGES_PER_CLAIM } from './limits.js';
import { buildQuery, buildWikiQuery, cleanPassage, normalize, relevantExcerpt } from './text.js';
import eduscol from '../../../data/indexes/eduscol.json' with { type: 'json' };
import nist from '../../../data/indexes/nist.json' with { type: 'json' };

export type Niveau = 1 | 2 | 3;
/** Passage stocke dans `PASSAGE#<id>`. Seule source des url, site, titre et extraits d'une fiche. */
export interface Passage {
  id: string;
  texte: string;
  url: string;
  site: string;
  titre: string;
  niveau: Niveau;
}
/** Port injectable: vrai outil, ou passages simules (jeu dore, `passageTwin`). Ne recoit que le texte de l'affirmation. */
export interface SearchPort {
  search(claimText: string): Promise<Passage[]>;
}

export const passageId = (url: string, texte: string): string => createHash('sha256').update(`${url}\n${texte}`).digest('hex').slice(0, 24);

interface WikiSource {
  host: string;
  site: string;
  niveau: Niveau;
}
const PRIMARY: WikiSource = { host: 'fr.wikipedia.org', site: 'Wikipédia', niveau: 2 };
/** Interroges seulement si la source principale ne renvoie aucun passage. [Non verifie en reel: meme API supposee, design 4.3.] */
const SECONDARY: WikiSource[] = [
  { host: 'en.wikipedia.org', site: 'Wikipedia (en)', niveau: 2 },
  { host: 'fr.wikibooks.org', site: 'Wikilivres', niveau: 2 },
  { host: 'fr.wikiversity.org', site: 'Wikiversité', niveau: 2 },
  { host: 'fr.vikidia.org', site: 'Vikidia', niveau: 3 },
];
export const WIKI_HOSTS = [PRIMARY, ...SECONDARY].map((s) => s.host);

const WikiResponse = z.object({
  query: z
    .object({ pages: z.array(z.object({ title: z.string().max(300), extract: z.string().max(5000).optional(), index: z.number().optional() })).max(10) })
    .optional(),
});

/** URL de l'API: construite ici, jamais fournie par un modele ni par une reponse distante. */
export function mediaWikiUrl(host: string, query: string): string {
  const u = new URL(`https://${host}/w/api.php`);
  for (const [k, v] of Object.entries({
    action: 'query', format: 'json', formatversion: '2', generator: 'search', gsrsearch: query, gsrnamespace: '0', gsrlimit: '3',
    prop: 'extracts', exintro: '1', explaintext: '1', exlimit: '3', exchars: '1000',
  })) u.searchParams.set(k, v);
  return u.toString();
}

const FullResponse = z.object({ query: z.object({ pages: z.array(z.object({ extract: z.string().max(2_000_000).optional() })).max(2) }).optional() });

/** URL de lecture d'UN article entier en texte brut (titre venu de la reponse de recherche, encode par URLSearchParams). */
export function fullArticleUrl(host: string, title: string): string {
  const u = new URL(`https://${host}/w/api.php`);
  for (const [k, v] of Object.entries({ action: 'query', format: 'json', formatversion: '2', prop: 'extracts', explaintext: '1', titles: title })) u.searchParams.set(k, v);
  return u.toString();
}

const pageUrl = (host: string, title: string): string => `https://${host}/wiki/${encodeURIComponent(title.replace(/ /g, '_'))}`;

/**
 * V2: l'introduction seule ne contient pas toujours le fait (dates et chiffres absents dans 26 a 37 % des cas, E1). Pour l'article le mieux
 * classe, on lit l'article entier et on garde les phrases les plus proches de l'affirmation (relevantExcerpt). Echec (taille, reseau): on garde l'introduction.
 */
async function topArticleExcerpt(src: WikiSource, title: string, query: string, wantNumbers: boolean, o: FetchOptions, note: (e: unknown) => void, cache: Map<string, string | undefined>): Promise<string | undefined> {
  try {
    const key = `${src.host}/${title}`;
    if (!cache.has(key)) {
      const parsed = FullResponse.safeParse(await guardedGetJson(fullArticleUrl(src.host, title), { ...o, maxBytes: FULL_ARTICLE_MAX_BYTES }));
      cache.set(key, parsed.success ? parsed.data.query?.pages[0]?.extract : undefined);
    }
    const article = cache.get(key);
    if (!article) return undefined;
    const text = cleanPassage(relevantExcerpt(article, query, EXCERPT_CHARS, wantNumbers), EXCERPT_CHARS).text;
    return text.length >= 40 ? text : undefined;
  } catch (e) {
    note(e);
    return undefined;
  }
}

async function searchWiki(src: WikiSource, query: string, excerptQuery: string, wantNumbers: boolean, fullCount: number, full: Set<string>, o: FetchOptions, note: (e: unknown) => void, cache: Map<string, string | undefined>): Promise<Passage[]> {
  const raw = await guardedGetJson(mediaWikiUrl(src.host, query), o);
  const parsed = WikiResponse.safeParse(raw);
  if (!parsed.success) return [];
  const out: Passage[] = [];
  const titles: string[] = [];
  for (const p of [...(parsed.data.query?.pages ?? [])].sort((a, b) => (a.index ?? 0) - (b.index ?? 0))) {
    const texte = cleanPassage(p.extract ?? '').text;
    if (texte.length < 40) continue;
    const url = pageUrl(src.host, p.title);
    titles.push(p.title);
    out.push({ id: passageId(url, texte), texte, url, site: src.site, titre: cleanPassage(p.title).text.slice(0, 200), niveau: src.niveau });
  }
  if (src === PRIMARY) {
    for (let i = 0; i < Math.min(fullCount, out.length); i++) {
      const ex = await topArticleExcerpt(src, titles[i], excerptQuery, wantNumbers, o, note, cache);
      if (ex) {
        out[i] = { ...out[i], texte: ex, id: passageId(out[i].url, ex) };
        full.add(out[i].id);
      }
    }
  }
  return out;
}

// ---- Index figes (empaquetes, sans reseau) ----
const IndexSchema = z.object({
  site: z.string(),
  niveau: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  entrees: z.array(z.object({ titre: z.string(), url: z.string().url(), motsCles: z.array(z.string()), texte: z.string() })),
});
const INDEXES = [IndexSchema.parse(eduscol), IndexSchema.parse(nist)];

/** Classement par mots-cles en memoire: au moins 2 mots de la requete (1 si la requete n'en a qu'un) doivent figurer dans l'entree. */
export function searchIndexes(query: string, indexes = INDEXES): Passage[] {
  const words = query.split(' ').filter(Boolean);
  if (!words.length) return [];
  const need = Math.min(2, words.length);
  const scored: { score: number; p: Passage }[] = [];
  for (const idx of indexes) {
    for (const e of idx.entrees) {
      const hay = new Set(normalize(`${e.motsCles.join(' ')} ${e.titre} ${e.texte}`).split(' '));
      const score = words.filter((w) => hay.has(w)).length;
      if (score < need) continue;
      const texte = cleanPassage(e.texte).text;
      scored.push({ score, p: { id: passageId(e.url, texte), texte, url: e.url, site: idx.site, titre: e.titre, niveau: idx.niveau } });
    }
  }
  return scored.sort((a, b) => b.score - a.score).slice(0, 2).map((s) => s.p);
}

export interface SearchToolOptions extends FetchOptions {
  indexes?: typeof INDEXES;
}

/** Outil reel. Une requete reseau echouee ou refusee n'arrete pas la verification: la source est ignoree (jamais d'URL a la place). */
export function createSearchTool(o: SearchToolOptions = {}): SearchPort & { refusals: Record<string, number> } {
  const refusals: Record<string, number> = {};
  const articles = new Map<string, string | undefined>(); // articles deja lus pendant cette verification (plusieurs affirmations partagent le meme article)
  const note = (e: unknown) => {
    const r = e instanceof FetchRefused ? e.reason : 'format';
    refusals[r] = (refusals[r] ?? 0) + 1;
  };
  return {
    refusals,
    async search(claimText) {
      const query = buildQuery(claimText);
      if (!query) return [];
      // V3: deux requetes (6 mots, puis les 3 premiers) pour ne pas dependre d'un seul classement; la 2e lit 1 article entier de plus.
      const wikiQueries = [...new Set([buildWikiQuery(claimText), buildWikiQuery(claimText, 3)].filter(Boolean))];
      if (!wikiQueries.length) wikiQueries.push(query);
      const full = new Set<string>();
      const found: Passage[] = [...searchIndexes(query, o.indexes)];
      const wiki: Passage[] = [];
      for (const src of [PRIMARY, ...SECONDARY]) {
        if (wiki.length) break; // sources secondaires seulement si la principale ne donne rien
        for (const [k, q] of wikiQueries.entries()) {
          if (k > 0 && src !== PRIMARY) break;
          try {
            wiki.push(...(await searchWiki(src, q, buildQuery(claimText, 12), /\d/.test(claimText), k === 0 ? FULL_ARTICLES_PER_CLAIM : 1, full, o, note, articles)));
          } catch (e) {
            note(e);
          }
        }
      }
      // Passages lus en entier d'abord (ils ont le plus de chances de porter le fait), puis introductions; une seule fois par page.
      const seenUrl = new Set<string>();
      const seen = new Set<string>();
      const ordered = [...wiki.filter((p) => full.has(p.id)), ...wiki.filter((p) => !full.has(p.id))].filter((p) => !seenUrl.has(p.url) && seenUrl.add(p.url));
      return [...found, ...ordered].filter((p) => !seen.has(p.id) && seen.add(p.id)).slice(0, MAX_PASSAGES_PER_CLAIM);
    },
  };
}
