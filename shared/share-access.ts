// Acces DynamoDB de chaque handler du PARTAGE DE QCM (S1 #34, docs/S1-design.md section 11). SOURCE UNIQUE lue par trois endroits (modele: shared/revise-access.ts):
//  - infra/lib/share-access.ts construit les droits des TROIS roles nouveaux a partir d'ici (une ligne oubliee ne peut plus etre « accordee a la main »);
//  - infra/test/s1-access.test.ts compare le gabarit SYNTHETISE a cette source, dans les deux sens (droit declare absent, droit accorde non declare);
//  - le lot S1-A rejouera chaque handler avec un enregistreur d'acces (api/src/shares/access.test.ts) et verifiera qu'il ne touche que ce qui est declare.
// Lecon de #95, #96 et #99: les droits sont ecrits d'apres ce que la fonction fait en cas d'ECHEC et de nettoyage, pas seulement d'apres ce qu'elle cree.
// Aucun S3, aucun Bedrock, aucune Step Functions, aucun COST#, aucun JOB#, aucun EXO# dans ces roles.
export type Partition = 'STUDENT#' | 'FAMILY#' | 'DOC#' | 'SHARE#';
export interface ShareAccess {
  get: Partition[];
  query: Partition[];
  /** PutItem (une transaction avec un `put` le demande aussi). */
  put: Partition[];
  /** UpdateItem (une transaction avec une mise a jour le demande aussi). */
  update: Partition[];
  /** ConditionCheckItem d'une transaction (verification sans ecriture). */
  check: Partition[];
  /** BatchWriteItem: seule voie de suppression (`TreeDb.remove`), jamais DeleteItem. */
  batch: Partition[];
}
const A = (a: Partial<ShareAccess>): ShareAccess => ({ get: [], query: [], put: [], update: [], check: [], batch: [], ...a });

/** Les cinq roles NOUVEAUX (game-stack.ts). S1-A (relecture #111 m5): `shareRead` (shares-shareable) et `shareView` (listes) sont en LECTURE SEULE (GetItem, Query), separes de `shareMake` et `shareManage` qui ecrivent.
 * Les trois premiers viennent de S1-D. Les roles existants ne recoivent qu'une instruction `SHARE#*` separee (voir SHARE_DELETE_CALLERS). */
export type ShareRole = 'shareMake' | 'shareManage' | 'sharePublic' | 'shareRead' | 'shareView';

export const SHARE_HANDLERS: Record<string, { role: ShareRole; access: ShareAccess }> = {
  // Choix des questions: lit l'eleve et la famille (`activeStudent`, `callerOf`), la fiche et ses questions (cles de reponse) et les `ATT#` (ce que l'eleve connait). N'ecrit rien.
  'shares-shareable': { role: 'shareRead', access: A({ get: ['STUDENT#', 'FAMILY#', 'DOC#'], query: ['STUDENT#', 'FAMILY#', 'DOC#'] }) },
  // Creation: une transaction de six elements. `put`: copie SHARE#<hache>/META, SHAREREF# (STUDENT#), SHARESLOT# (FAMILY#); `update`: SHAREJ# (STUDENT#);
  // ConditionCheckItem: element eleve (FAMILY#: `sharing`, statut) et fiche (STUDENT#). Un echec ne laisse rien (une seule transaction).
  'shares-create': { role: 'shareMake', access: A({ get: ['STUDENT#', 'FAMILY#', 'DOC#'], query: ['STUDENT#', 'FAMILY#', 'DOC#'], put: ['SHARE#', 'STUDENT#', 'FAMILY#'], update: ['STUDENT#'], check: ['FAMILY#', 'STUDENT#'] }) },
  // Liste de l'eleve: ses references (STUDENT#), `rev` de la fiche (STUDENT#), lectures et signalements de chaque lien (SHARE#: Query). Jamais DOC#.
  'shares-list': { role: 'shareView', access: A({ get: ['STUDENT#', 'FAMILY#', 'SHARE#'], query: ['STUDENT#', 'FAMILY#', 'SHARE#'] }) },
  // Revocation d'un lien: la copie d'abord (SHARE#), puis la reference (STUDENT#) et l'emplacement famille (FAMILY#). BatchWriteItem seulement.
  'shares-delete': { role: 'shareManage', access: A({ get: ['STUDENT#', 'FAMILY#', 'SHARE#'], query: ['STUDENT#', 'FAMILY#', 'SHARE#'], batch: ['SHARE#', 'STUDENT#', 'FAMILY#'] }) },
  'shares-parent-list': { role: 'shareView', access: A({ get: ['STUDENT#', 'FAMILY#', 'SHARE#'], query: ['STUDENT#', 'FAMILY#', 'SHARE#'] }) },
  // Purge parent, rejouable: `deleteSharesOf` (liste les references et les emplacements, supprime copies puis references puis emplacements).
  'shares-parent-delete': { role: 'shareManage', access: A({ get: ['STUDENT#', 'FAMILY#', 'SHARE#'], query: ['STUDENT#', 'FAMILY#', 'SHARE#'], batch: ['SHARE#', 'STUDENT#', 'FAMILY#'] }) },
  // Route PUBLIQUE: lit META (GetItem), met a jour `META.reports`, `META.state` et le compteur `DAY#` (UpdateItem conditionnel), ecrit `REPORT#` (PutItem). Aucun Query, aucune autre partition.
  'shares-open': { role: 'sharePublic', access: A({ get: ['SHARE#'], update: ['SHARE#'] }) },
  'shares-report': { role: 'sharePublic', access: A({ get: ['SHARE#'], update: ['SHARE#'], put: ['SHARE#'] }) },
};

/** Roles EXISTANTS qui appellent la suppression en cascade AVEC l'option `deleteShares` (instruction `SHARE#*` separee, jamais dans une liste partagee). */
export type DeleteRole = 'delete' | 'cours' | 'admin';
/** `file`: source du handler (le test relit ces fichiers); `tree`: fonction de suppression appelee avec l'option. */
export const SHARE_DELETE_CALLERS: Record<string, { role: DeleteRole; file: string; tree: 'deleteDocTree' | 'deleteCoursTree' | 'deleteStudentTree' | 'deleteFamilyTree' }> = {
  'docs-delete': { role: 'delete', file: 'api/src/docs/docs.ts', tree: 'deleteDocTree' },
  'cours-delete': { role: 'cours', file: 'api/src/cours/cours.ts', tree: 'deleteDocTree' }, // `fiches=supprimer` seulement
  'students-delete': { role: 'admin', file: 'api/src/family/students.ts', tree: 'deleteStudentTree' },
  'family-admin': { role: 'admin', file: 'api/src/family/family.ts', tree: 'deleteFamilyTree' },
};
/**
 * Ce que `deleteSharesOf` fait pour ces appelants. `SHARE#`: Query (liste des elements d'un lien) et BatchWriteItem; `STUDENT#` et `FAMILY#`: Query
 * (references, emplacements) et BatchWriteItem (suppression): ces deux partitions sont DEJA accordees aux trois roles, S1-D n'ajoute que `SHARE#*`.
 */
export const DELETE_SHARES_ACCESS = A({ query: ['SHARE#', 'STUDENT#', 'FAMILY#'], batch: ['SHARE#', 'STUDENT#', 'FAMILY#'] });
/** Seule partition ajoutee aux roles existants (instruction separee). */
export const DELETE_SHARES_ADDED: ShareAccess = A({ query: ['SHARE#'], batch: ['SHARE#'] });

/**
 * Appelants de la suppression en cascade qui NE DOIVENT PAS activer l'option (le test relit leur source): le pipeline (`failJob`, `append`, annulation d'un scan),
 * la modification d'un cours (M1), la mise a jour d'un eleve (`students-update`: ne pose que le drapeau `sharing`, voie dediee, design section 3).
 */
export const NO_SHARE_CALLER_FILES = ['api/src/pipeline/steps.ts', 'api/src/pipeline/append.ts', 'api/src/pipeline/api.ts', 'api/src/revise/machine.ts', 'api/src/revise/lock.ts'] as const;
