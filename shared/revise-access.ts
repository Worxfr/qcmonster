// Acces DynamoDB et autres ports de chaque handler de la MODIFICATION D'UN COURS (M1 #90, docs/M1-design.md section 7). SOURCE UNIQUE lue par trois tests:
//  - api/src/revise/access.test.ts: chaque handler, exerce avec un enregistreur d'acces (api/src/pipeline/access-spy.ts), ne touche QUE ce qui est declare ici;
//  - infra/test/m1-roles.test.ts: ce qui est declare ici est accorde au role SYNTHETISE de la fonction (dev et prod), et les roles `revise-start` et `revise` n'ont rien de plus;
//  - infra/lib/revise-access.ts construit les droits des DEUX roles nouveaux a partir d'ici: une ligne oubliee ne peut plus etre « accordee a la main ».
// Lecon de #95, #96 et #100: un role sans le droit REEL (nettoyage, echec, reprise) ou un identifiant non transmis entre etapes de la machine, invisibles des tests en memoire.
export type Partition = 'STUDENT#' | 'FAMILY#' | 'JOB#' | 'DOC#' | 'COST#';
export interface ReviseAccess {
  get: Partition[];
  query: Partition[];
  /** PutItem (une transaction avec un `put` le demande aussi). */
  put: Partition[];
  /** UpdateItem (une transaction avec une mise a jour le demande aussi). Chaque ecriture nomme SON action: `put` n'est pas `update` (revue de la PR #99, m1). */
  update: Partition[];
  /** BatchWriteItem (suppression par lots: `Query` puis `BatchWriteItem` seulement, jamais `deleteDocTree` ni S3). */
  batch: Partition[];
  /** Appelle le modele (Bedrock) et le compteur de cout: seulement `rev-extract` et `rev-generate`, via `pipeline-role`. */
  model?: true;
  /** Demarre la machine `revise`. */
  sfn?: true;
}
const A = (a: Partial<ReviseAccess>): ReviseAccess => ({ get: [], query: [], put: [], update: [], batch: [], ...a });

/** Roles qui portent ces handlers: les deux premiers sont NOUVEAUX (sans Bedrock ni S3), les autres existent deja. */
export type ReviseRole = 'reviseStart' | 'revise' | 'pipeline' | 'coursRead' | 'cours' | 'delete' | 'write' | 'admin';

export const REVISE_HANDLERS: Record<string, { role: ReviseRole; access: ReviseAccess }> = {
  // Creation: callerOf (FAMILY# Query), cours + textes + blocs + fiches (STUDENT#, DOC#), compteurs REVJ#/REVM# (STUDENT#) et REVQ# (FAMILY#), COST# (garde, lecture).
  // Transaction (job + verrou + compteurs): PutItem du job (STUDENT#), UpdateItem du verrou et des compteurs (STUDENT#, FAMILY#). Requete `CHANGES` sous JOB# (PutItem).
  // Echec du lancement: UpdateItem (job, verrou, compteurs), BatchWriteItem de CHANGES.
  'revise-create': { role: 'reviseStart', access: A({ get: ['STUDENT#', 'FAMILY#', 'COST#'], query: ['STUDENT#', 'FAMILY#', 'DOC#'], put: ['STUDENT#', 'JOB#'], update: ['STUDENT#', 'FAMILY#'], batch: ['JOB#'], sfn: true }) },
  // Annulation: ne fait que marquer le job et liberer le verrou (UpdateItem). Jamais la partition de travail (elle expire par son ttl).
  'revise-cancel': { role: 'reviseStart', access: A({ get: ['STUDENT#'], query: ['FAMILY#'], update: ['STUDENT#'] }) },
  // Lecture de l'etat: un element STUDENT#<sid>/JOB#<revisionId>. Jamais la copie de travail (JOB#): ce role n'a pas JOB#.
  'revise-get': { role: 'coursRead', access: A({ get: ['STUDENT#'], query: ['FAMILY#'] }) },
  // Etapes de la machine. Aucun S3, aucun modele, aucun COST#.
  'rev-prepare': { role: 'revise', access: A({ get: ['STUDENT#'], query: ['DOC#'], update: ['STUDENT#'], batch: ['DOC#'] }) },
  // Validation: PutItem (nouveaux elements de la fiche, `attribute_not_exists`; texte et blocs du cours), UpdateItem (en-tete du cours et de la fiche, job, `retiree`, verrou, reglement du cout).
  'rev-commit': { role: 'revise', access: A({ get: ['STUDENT#', 'JOB#'], query: ['STUDENT#', 'DOC#', 'JOB#'], put: ['STUDENT#', 'DOC#'], update: ['STUDENT#', 'DOC#', 'FAMILY#'], batch: ['DOC#', 'JOB#'] }) },
  // Echec: rejoue la validation si elle a commence; sinon supprime la copie (Query puis BatchWriteItem), regle le cout (PutItem du marqueur COSTADDED# sous JOB#), libere le verrou.
  'rev-fail': { role: 'revise', access: A({ get: ['STUDENT#', 'DOC#', 'JOB#'], query: ['STUDENT#', 'DOC#', 'JOB#'], put: ['STUDENT#', 'DOC#', 'JOB#'], update: ['STUDENT#', 'DOC#', 'FAMILY#'], batch: ['DOC#', 'JOB#'] }) },
  // Etapes avec modele, dans `pipeline-role` (existant, Bedrock inchange: aucun modele de plus). La partition de travail est une partition DOC#. COST#: garde et compteur de cout.
  'rev-extract': { role: 'pipeline', access: A({ get: ['STUDENT#', 'JOB#', 'COST#'], query: ['STUDENT#', 'DOC#'], put: ['DOC#'], update: ['STUDENT#', 'COST#'], batch: ['DOC#'], model: true }) },
  'rev-generate': { role: 'pipeline', access: A({ get: ['STUDENT#', 'DOC#', 'COST#'], query: ['DOC#'], put: ['DOC#', 'JOB#'], update: ['STUDENT#', 'COST#'], model: true }) },
  // Fonctions existantes touchees: ce qu'elles font en plus pendant une modification. Les droits des roles existants suffisent (test).
  'cours-delete': { role: 'cours', access: A({ get: ['STUDENT#'], query: ['STUDENT#', 'DOC#', 'JOB#', 'FAMILY#'], update: ['STUDENT#'], batch: ['STUDENT#', 'DOC#', 'JOB#', 'FAMILY#'] }) },
  'docs-delete': { role: 'delete', access: A({ get: ['STUDENT#'], query: ['STUDENT#', 'FAMILY#'] }) },
  'scans-create': { role: 'write', access: A({ get: ['STUDENT#', 'COST#'], query: ['STUDENT#', 'FAMILY#'], put: ['STUDENT#'], update: ['STUDENT#', 'FAMILY#'], sfn: true }) },
  'students-delete': { role: 'admin', access: A({ query: ['STUDENT#', 'FAMILY#', 'DOC#', 'JOB#'], batch: ['STUDENT#', 'DOC#', 'JOB#', 'FAMILY#'] }) },
};

/**
 * Entree de la machine `revise`: identifiants SEULEMENT (jamais de texte du cours). SOURCE UNIQUE: `revise-create` l'envoie, `pipeline-stack.ts` en construit les
 * `Parameters` de CHAQUE tache (une cle oubliee y arrivait `undefined`: revue #100 B1, `fid` perdu), `parseReviseInput` la valide dans chaque etape.
 */
export interface ReviseInput {
  revisionId: string;
  sid: string;
  fid: string;
  coursId: string;
}
export const REVISE_INPUT_KEYS = { revisionId: 'string', sid: 'string', fid: 'string', coursId: 'string' } as const satisfies Record<keyof ReviseInput, 'string'>;
/** Les etapes d'une fiche (dans le `Map`) recoivent en plus le rang de la fiche. */
export interface ReviseStepInput extends ReviseInput {
  index: number;
}
const ID = /^[A-Za-z0-9_-]{1,64}$/;
/** Valide l'entree d'une etape: une cle absente ou mal formee leve une erreur (jamais la chaine `undefined` comme partition). */
export function parseReviseInput(raw: unknown): ReviseInput {
  const o = (raw ?? {}) as Record<string, unknown>;
  for (const k of Object.keys(REVISE_INPUT_KEYS)) {
    const v = o[k];
    if (!(typeof v === 'string' && ID.test(v))) throw new TypeError(`entree de la machine revise: ${k} invalide`);
  }
  return { revisionId: o.revisionId as string, sid: o.sid as string, fid: o.fid as string, coursId: o.coursId as string };
}
export function parseReviseStepInput(raw: unknown): ReviseStepInput {
  const base = parseReviseInput(raw);
  const index = (raw as Record<string, unknown>).index;
  if (!(Number.isInteger(index) && (index as number) >= 0 && (index as number) <= 2)) throw new TypeError('entree de la machine revise: index invalide');
  return { ...base, index: index as number };
}
/** Ce que la machine transmet a ses taches: exactement les cles de REVISE_INPUT_KEYS (simulation de `Parameters`, pour les tests d'API). */
export const throughMachine = (input: Record<string, unknown>): ReviseInput => Object.fromEntries(Object.keys(REVISE_INPUT_KEYS).map((k) => [k, input[k]])) as unknown as ReviseInput;
