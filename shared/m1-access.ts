// Acces de `jobs-confirm` (M1 #89: la confirmation avec phrases ajoutees n'ecrit que ce qu'elle ecrivait deja). SOURCE UNIQUE lue par deux tests,
// comme shared/exo-access.ts (lecon de #95, #96 et #100: un droit reel manquant que les tests en memoire ne voient pas):
//  - api/src/pipeline/m1-access.test.ts: la confirmation, exercee avec un magasin enregistreur, ne touche QUE ce qui est declare ici;
//  - infra/test/m1-access.test.ts: ce qui est declare ici est accorde au role SYNTHETISE de la fonction `jobs-confirm` (LeadingKeys compris).
// Partitions: prefixe de la cle de partition. `batch` = BatchWriteItem (suppression en cascade de la course perdue, `deleteCoursTree`).
export type Partition = 'STUDENT#' | 'FAMILY#' | 'JOB#' | 'DOC#';
export interface ConfirmAccess {
  get: Partition[];
  query: Partition[];
  /** PutItem, UpdateItem et ConditionCheckItem (transactions comprises). */
  write: Partition[];
  batch: Partition[];
  /** Bucket des scans (prefixe scans/): lecture du recadrage, liste, suppression des photos. */
  scans: ('get' | 'list' | 'delete')[];
  /** Bucket des figures: copie de la figure gardee, suppression si la confirmation echoue. */
  figures: ('put' | 'list' | 'delete')[];
  /** Reprise de la machine d'etats. */
  sfn: ('SendTaskSuccess' | 'SendTaskFailure')[];
}
export const JOBS_CONFIRM_ACCESS: ConfirmAccess = {
  get: ['STUDENT#', 'JOB#'],
  query: ['FAMILY#', 'JOB#', 'STUDENT#'],
  write: ['STUDENT#', 'JOB#'],
  batch: ['STUDENT#', 'JOB#'],
  scans: ['get', 'list', 'delete'],
  figures: ['put', 'list', 'delete'],
  sfn: ['SendTaskSuccess', 'SendTaskFailure'],
};
