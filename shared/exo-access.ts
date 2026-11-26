// Acces DynamoDB et S3 de chaque handler E1 (docs/E1-design.md section 11). SOURCE UNIQUE lue par deux tests:
//  - api/src/exo/access.test.ts: chaque handler, exerce avec un magasin enregistreur, ne touche QUE ce qui est declare ici;
//  - infra/test/e1-access.test.ts: ce qui est declare ici est couvert par les `dynamodb:LeadingKeys` du role synthetise de ce handler.
// Un acces non declare fait echouer le premier test; un acces non accorde fait echouer le second. Les deux erreurs de #95 et #96 (droit oublie).
// Partitions: prefixe de la cle de partition (STUDENT#, DOC#, FAMILY#, COST#).
export type Partition = 'STUDENT#' | 'DOC#' | 'FAMILY#' | 'COST#';
export interface HandlerAccess {
  /** GetItem. */
  get: Partition[];
  /** Query. */
  query: Partition[];
  /** PutItem, UpdateItem et ConditionCheckItem (transactions comprises). */
  write: Partition[];
  /** DeleteItem. */
  delete: Partition[];
  /** Droits S3 sur le bucket des scans, prefixe `copies/` seulement. `list` = ListBucket avec condition de prefixe, jamais GetObject sans `get`. */
  s3?: { get?: true; put?: true; delete?: true; list?: true };
}

const A = (a: Partial<HandlerAccess>): HandlerAccess => ({ get: [], query: [], write: [], delete: [], ...a });

/**
 * Entree de la machine `copie` (identifiants et nombre de pages, JAMAIS de contenu). SOURCE UNIQUE: `copies-submit` l'envoie, `exo-stack.ts` en
 * construit les `Parameters` des taches (une cle oubliee y arrivait `undefined`: revue #100 B1, `fid` perdu, quota famille jamais rembourse).
 */
export interface CopieInput {
  copieId: string;
  sid: string;
  fid: string;
  exoRef: string;
  pages: number;
}
export const COPIE_INPUT_KEYS = { copieId: 'string', sid: 'string', fid: 'string', exoRef: 'string', pages: 'number' } as const satisfies Record<keyof CopieInput, 'string' | 'number'>;
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Entree recue par `copie-correct` et `copie-fail`: toute cle absente ou mal formee leve une erreur (jamais la chaine `undefined` comme partition). */
export function parseCopieInput(raw: unknown): CopieInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  for (const [k, t] of Object.entries(COPIE_INPUT_KEYS)) {
    const v = o[k];
    if (t === 'number' ? !(Number.isInteger(v) && (v as number) >= 1 && (v as number) <= 3) : !(typeof v === 'string' && ID.test(v))) throw new TypeError(`entree de la machine copie: ${k} invalide`);
  }
  return throughMachine(o);
}
/** Ce que la machine transmet a ses taches: exactement les cles de COPIE_INPUT_KEYS (simulation de `Parameters`, pour les tests d'API). */
export const throughMachine = (input: Record<string, unknown>): CopieInput => Object.fromEntries(Object.keys(COPIE_INPUT_KEYS).map((k) => [k, input[k]])) as unknown as CopieInput;

/** Roles E1. `exoRole` et `copieRole` appellent Bedrock; `copieStart` n'y touche pas; `play` et `copieDelete` sont des roles de la pile Game. */
export type E1Role = 'exoRole' | 'copieRole' | 'copieStart' | 'play' | 'copieDelete';

export const E1_HANDLERS: Record<string, { role: E1Role; access: HandlerAccess }> = {
  // Generation (Bedrock Haiku). Ecrit EXO# dans DOC#, met EXOP# et COPIEJ# a jour (STUDENT#), compteur de cout (COST#).
  'exo-gen': { role: 'exoRole', access: A({ get: ['DOC#', 'STUDENT#', 'COST#'], query: ['DOC#', 'STUDENT#'], write: ['DOC#', 'STUDENT#', 'COST#'] }) },
  // Correction (Bedrock Haiku et Sonnet). Lit la copie en S3 puis la supprime. N'ecrit NI PROFILE NI TEST# (code: jamais ces cles).
  'copie-correct': { role: 'copieRole', access: A({ get: ['STUDENT#', 'FAMILY#', 'DOC#', 'COST#'], write: ['STUDENT#', 'FAMILY#', 'COST#'], s3: { get: true, delete: true } }) },
  'copie-fail': { role: 'copieRole', access: A({ get: ['STUDENT#', 'FAMILY#'], write: ['STUDENT#', 'FAMILY#'], s3: { delete: true } }) },
  // Creation et envoi: sans Bedrock. COST# en lecture seule (garde mensuel). ListBucket: controle « une page manque ».
  'copies-create': { role: 'copieStart', access: A({ get: ['STUDENT#', 'DOC#', 'FAMILY#', 'COST#'], query: ['STUDENT#'], write: ['STUDENT#', 'FAMILY#'], s3: { put: true, delete: true, list: true } }) },
  'copies-submit': { role: 'copieStart', access: A({ get: ['STUDENT#', 'DOC#', 'FAMILY#', 'COST#'], query: ['STUDENT#'], write: ['STUDENT#', 'FAMILY#'], s3: { list: true } }) },
  // Role `play` (comme session-get): lit DOC#, ecrit STUDENT# et FAMILY#. Aucun GetObject.
  'exo-post': { role: 'play', access: A({ get: ['DOC#', 'STUDENT#', 'FAMILY#'], query: ['DOC#', 'STUDENT#'], write: ['STUDENT#'] }) },
  'exo-list': { role: 'play', access: A({ get: ['DOC#', 'STUDENT#', 'FAMILY#'], query: ['DOC#', 'STUDENT#'] }) },
  'exo-get': { role: 'play', access: A({ get: ['DOC#', 'STUDENT#', 'FAMILY#'], query: ['STUDENT#'], write: ['STUDENT#'] }) },
  'exo-hint-post': { role: 'play', access: A({ get: ['DOC#', 'STUDENT#', 'FAMILY#'], write: ['STUDENT#'] }) },
  'exo-solution-post': { role: 'play', access: A({ get: ['DOC#', 'STUDENT#', 'FAMILY#'], write: ['STUDENT#'] }) },
  // Credit a la premiere lecture d'une copie corrigee: PROFILE, DAY (STUDENT#), WEEK (FAMILY#), EXOP#, COPIE#, TEST#.
  'copie-get': { role: 'play', access: A({ get: ['DOC#', 'STUDENT#', 'FAMILY#'], query: ['STUDENT#'], write: ['STUDENT#', 'FAMILY#'] }) },
  // Role dedie: `play` n'a pas DeleteItem. DeleteObject sur copies/* (cles exactes), aucun GetObject, aucun ListBucket.
  'copie-delete': { role: 'copieDelete', access: A({ get: ['STUDENT#', 'FAMILY#'], delete: ['STUDENT#'], s3: { delete: true } }) },
};

/** Handlers a ajouter a `GAME_HANDLERS` (fonctions de la pile Game); `exo-gen`, `copie-correct` et `copie-fail` sont dans la pile E1. */
export const E1_GAME_HANDLERS = Object.entries(E1_HANDLERS)
  .filter(([, h]) => h.role === 'play' || h.role === 'copieStart' || h.role === 'copieDelete')
  .map(([name]) => name);
