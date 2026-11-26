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
