# Modele de donnees DynamoDB

Source de verite: `docs/design-v2.md` section 5 (copie dans le depot par le lot 0) et `shared/ddb/keys.ts`.
Seul le lot 1 modifie ce fichier et `shared/ddb/keys.ts`. Une table par environnement: `qcm-dev`, `qcm-prod` (a la demande).
Cle de partition `PK`, cle de tri `SK`. **Chaque type d'element a un seul lot qui ecrit**; les autres lots lisent.

| Type | PK | SK | Attributs principaux | Ecrit par |
|---|---|---|---|---|
| Famille | `FAMILY#<fid>` | `META` | plafond pages famille, date de creation | L3 |
| Eleve | `FAMILY#<fid>` | `STUDENT#<sid>` | pseudo, niveau scolaire, `moins15`, statut (`actif`, `suspendu`), `cognitoSub`, `quotaPages` (L2a le lit pour `reservePages`; defaut `quotaDefaults(env)`) | L3 |
| Quota mensuel (eleve) | `FAMILY#<fid>` | `QUOTA#<aaaa-mm>#<sid>` | `limite`, `utilise`, `reserve`, `bonus`, `restant` | `shared/quota.ts` (L1); lu par L2a, L3 |
| Quota mensuel (famille) | `FAMILY#<fid>` | `QUOTA#<aaaa-mm>#FAMILY` | memes attributs, `limite` = plafond famille | `shared/quota.ts` (L1) |
| Job | `STUDENT#<sid>` | `JOB#<jobId>` | etat, `stage` fin (`fiche`, `verification`), `pagesRead`, `contentTypes`, `folderId`, choix et suggestions de matiere/sujet (voir FEAT-A), nb de pages, `coutCentimes` (somme mesuree L2a + L2b, expose par le contrat), horodatages, erreur. TTL 7 jours | L2a |
| Transcription | `JOB#<jobId>` | `TEXT#<page>` | phrases numerotees. TTL 7 jours | L2a |
| Fiche | `STUDENT#<sid>` | `DOC#<docId>` | titre, matiere, `sujet`, `dossierId`, `pages` (FEAT-A), `empreinteMinHash` (64 entiers), `pagesConsommees`, `doublon`, date, GSI1 | L2a |
| Dossier (FEAT-A) | `STUDENT#<sid>` | `FOLDER#<folderId>` | `nom`, `nomCle` (`labelKey(nom)`), `createdAt`. Aucune liste de fiches: l'appartenance est portee par `DOC#.dossierId` | `api/src/folders/` (lot back B2) seul |
| Affirmation | `DOC#<docId>` | `CLAIM#<nn>` | texte, origine (page, `phrase_id`, extrait), type, `a_risque`. Jamais modifiee ensuite | L2a (seul) |
| QCM | `DOC#<docId>` | `QCM#<nn>` | `questionId` (`<docId>:qcm:<nn>`), enonce, 4 choix, `claimId`, cle (reservee au serveur) | L2a |
| Trou | `DOC#<docId>` | `GAP#<nn>` | `questionId` (`<docId>:gap:<nn>`), phrase a trous, mot attendu, `claimId` | L2a |
| Verdict | `DOC#<docId>` | `VERDICT#<nn>` | `statut`, `niveau`, `secondeLecture`, `sources[]` (`passageId`, `url`, `site`, `titre`, `extrait`, `niveau`), `coutMicros` (facultatif: cout en micro-euros des appels du lot, porte par le premier verdict du lot, pour cumuler le plafond du job entre tentatives; non expose par `docs-read`) | L2b (seul) |
| Signalement | `FAMILY#<fid>` | `REPORT#<reportId>` | `docId`, `claimId`, `commentaire`, `statut` (`ouvert`, `valide`, `rejete`) | L2a (creation par `docs-report`); L3 change `statut` |
| Compteur de transcriptions | `STUDENT#<sid>` | `TRANSCR#<aaaa-mm-jj>` | nombre du jour (plafond 10). TTL 2 jours | L2a |
| Passage | `PASSAGE#<hash>` | `META` | `texte` (brut, nettoye), `url`, `site`, `titre`, `niveau`, `date`, `ttl`. `<hash>` = 24 premiers caracteres hex de SHA-256(`url` + saut de ligne + `texte`). TTL 30 jours | L2b |
| Verdict en cache | `CLAIMCACHE#<empreinte>` | `META` | `statut` (`verifiee` ou `erreur` seulement), `niveau`, `secondeLecture`, `passageIds`, `sources[]` (memes champs que le verdict), `date`, `ttl`. `<empreinte>` = SHA-256 du texte normalise (minuscules, sans accents ni ponctuation). Reutilise seulement si les passages cites existent encore. TTL 30 jours | L2b |
| Profil de jeu | `STUDENT#<sid>` | `PROFILE` | XP total, niveau, serie, gels, badges, stade | L3 |
| XP du jour | `STUDENT#<sid>` | `DAY#<aaaa-mm-jj>` | XP gagne, pages payees, jour valide | L3 |
| Tentative | `STUDENT#<sid>` | `ATT#<questionId>#<aaaa-mm-jj>` | `attempts` (essais du jour), `done` (plus de recompense possible ce jour), `rewarded` (cette tentative a gagne la recompense unique). **Une recompense par question pour toujours**: L3 lit les `ATT#<questionId>#` des autres jours (prefixe) et ne paie que si aucun n'a `rewarded`. Le moment d'affichage n'est pas stocke ici (voir `PROFILE.tick`) | L3 |
| Classement | `FAMILY#<fid>` | `WEEK#<aaaa-Www>#<sid>` | XP de la semaine, jours actifs | L3 |
| Compteur de cout | `COST#<env>` | `MONTH#<aaaa-mm>` et `TOTAL` | `micros` (micro-euros entiers), `pages`. `TOTAL` = cumul depuis le debut de la phase dev (plafond d'essais 50 EUR) | `shared/cost.ts` (L1); lu par L2a, L2b |
| Invitation | `INVITE#<hache>` | `META` | `utilisee`, `utiliseeLe`, `creeLe` | `scripts/create-invite.ts`, `api/src/admin/invitations.ts` (A1) + `api/src/auth/pre-signup.ts` (L1) |
| Audit d'invitation (A1) | `INVITE#AUDIT#<auteur>#<aaaa-mm-jj>` | `N#01`..`N#20` | `evenement`, `actor`, `creeLe`, `ttl` | `api/src/admin/invitations.ts` (compteur quotidien et audit, sans code) |
| Activation | `ACTIVATION#<hache>` | `META` | `sid`, expiration. TTL 24 h | L3 |

Index secondaire `GSI1`: `GSI1PK = FAMILY#<fid>`, `GSI1SK = DOC#<date>` pour lister les fiches de la famille cote parent (sans le texte du cours). Pas d'autre index en v1. Pas de PITR (suppression effective immediatement). Facturation a la demande. Attribut TTL: `ttl` (secondes epoch), pose sur Job, Transcription, Passage, Verdict en cache et Activation.

## Buckets S3 (stack Data)

Noms generes par CDK, publies dans SSM: `/qcm/<env>/data/scansBucket`, `/qcm/<env>/data/vaultBucket`, `/qcm/<env>/data/tableName`.

- **Scans**: photos de cours envoyees par POST pre-signe. Expiration par cycle de vie: S3 arrondit au minuit UTC suivant, donc 1 a 2 jours en pratique; la garantie reelle est la suppression par le workflow (30 min, lot L2a). Chiffre, acces public bloque, TLS exige, CORS limite a l'origine du front (`-c webOrigin=...`).
- **Coffre**: pages cachees du jeu dore. Conserve a la suppression de la stack. Lecture refusee a toute identite sauf le role `qcm-<env>-eval-role`.

## Ecart par rapport au design

- **Element `QUOTA#<aaaa-mm>#FAMILY`** (ajout du lot 1): DynamoDB n'autorise pas d'arithmetique dans une condition, et le plafond famille doit etre tenu atomiquement avec le quota de l'eleve. `shared/quota.ts` met a jour les deux elements dans **une** transaction. `restant = limite + bonus - utilise - reserve`; la reservation exige `restant >= pages`.
- Les hachés (`INVITE#`, `ACTIVATION#`) sont des SHA-256 hexadecimaux (`sha256()` dans `keys.ts`); le code en clair n'est jamais stocke.

## Regles

- Mois des quotas: `monthParis()` (fuseau Europe/Paris, remise a zero le 1er).
- Aucun texte de cours dans les journaux ni dans l'etat Step Functions (design 4.1, 4.9).
- Pour changer une cle ou un type: PR sur `shared/ddb/keys.ts` et ce fichier, relue par le proprietaire du lot 1.

## Ajouts L1c

- **Un type, un ecrivain.** Affirmation (`CLAIM#`, L2a) et Verdict (`VERDICT#`, L2b) sont deux elements: plus de mise a jour croisee. `docs-read` (L2a) assemble les deux pour la reponse `Doc`.
- **Schemas Zod** de ces elements et de l'interface L2a -> L2b (`verify-run`: entree `{ jobId, docId, budgetRestantCentimes }`, sortie `{ coutCentimes, nbVerifiees, nbErreurs, nbNonVerifiables }`, aucun texte dans l'etat Step Functions): `shared/items.ts`.
- **Suppression en cascade**: `shared/delete-tree.ts` (`deleteDocTree`, `deleteStudentTree`, `deleteFamilyTree`). « Effacer » est permis a travers les proprietaires; chaque nouveau type d'element doit etre ajoute a ces fonctions (leur test compte les elements avant et apres).
- **Couts**: tout appel Bedrock passe par `shared/bedrock.ts` (garde de cout, plafond du job, compteur). Voir `docs/cost-guard.md`.
- **Evenement de depot**: le bucket des scans envoie ses evenements a EventBridge; la regle qui demarre le workflow (prefixe `scans/`) est creee par `pipeline-stack.ts` (L2a).
- **Nommage**: le contrat expose `Job.costCents`; l'element DynamoDB porte `coutCentimes`. Le handler L2a fait le mapping explicitement (`costCents = coutCentimes`). Le compteur applicatif est en micro-euros (`micros`), le job en centimes.

## FEAT-A: scans multi-pages, matiere et sujet, dossiers, statut (contrat 1.3)

Aucune donnee existante n'est modifiee ni migree: tous les attributs ci-dessous sont **facultatifs** et les schemas Zod (`shared/items.ts`) acceptent les elements d'avant. Logique de liste, de filtre et de tri: `shared/scans.ts` (`listScans`, pure, testee).

### Attributs ajoutes

| Element | Attribut | Sens | Ecrit par |
|---|---|---|---|
| Job | `contentTypes` | type de chaque page (jpeg ou png), dans l'ordre. Absent = `contentType` pour toutes | `scans-create` |
| Job | `folderId` | dossier choisi a la creation ou a la confirmation (copie sur la fiche a la generation) | `scans-create`, `jobs-confirm` |
| Job | `suggestedSubject`, `suggestedTopic` | proposes par l'appel de transcription (meme appel, quelques tokens en plus, pas d'appel de plus) | `transcribe` |
| Job | `subjectChoice`, `topicChoice` | choix de l'eleve a la confirmation; priment sur la suggestion et sur `draftSubject` | `jobs-confirm` |
| Job | `confirmExpiresAt` | echeance de la confirmation (ISO), `awaitingSince` + `CONFIRM_TIMEOUT_S` (12 h, `shared/scans.ts`). Absent: pas d'echeance affichee | `awaitConfirm` |
| Job | `pagesRead` | pages lues (compteur, `ADD 1` par page transcrite) | `transcribe` |
| Job | `stage` | `fiche` (extraction) puis `verification`; `generation` vient de l'etat. Absent: deduit de l'etat | `extract` |
| Fiche | `sujet`, `dossierId`, `pages` | sujet (80 car. max), dossier, nombre de pages. `pages` absent: `max(1, pagesConsommees)` | `generate` (copie du job), `docs-patch`, `folders-api` |
| Dossier | `nom`, `nomCle`, `createdAt` | voir tableau | `folders-api` |

Regles:
- **Un scan = un job** (`scanId` = `jobId`). Le job vit 7 jours (TTL), la fiche sans limite: la liste fusionne les deux (`shared/scans.ts`); un scan termine dont le job a expire reste liste, un job termine dont la fiche a ete supprimee est masque; un echec ou un rejet disparait de la liste avec son job, apres 7 jours.
- **0 ou 1 dossier par fiche**: `DOC#.dossierId` est la seule source. Supprimer un dossier retire `dossierId` des fiches concernees (une ecriture par fiche; interrompu, une fiche qui cite un dossier absent est vue hors dossier: la liste ignore les dossiers inconnus). Les fiches ne sont jamais supprimees avec le dossier.
- **Dossier par eleve**: la cle contient `<sid>` pris dans le jeton, jamais dans la requete. Un `folderId` ou `docId` d'un autre eleve n'existe pas dans la partition lue: 404. Un parent lit les partitions de ses eleves (verifiees dans `FAMILY#<fid>`), sans rien ecrire.
- **Unicite du nom**: `nomCle` compare a ceux de l'eleve (50 au plus) avant l'ecriture. shortcut: deux creations simultanees du meme nom peuvent passer; sans consequence (deux dossiers homonymes), a corriger par un element `FOLDERNAME#` conditionnel si cela gene.
- **Quota par page**: `scans-create` reserve `pages` en une transaction (`reservePages`, regles existantes), la rend si le job echoue, est annule ou expire (`releaseQuotaOnce`). Inchange.
- **Suppression** (`shared/delete-tree.ts`): `deleteStudentTree` supprime deja tout ce qui n'est pas `DOC#` dans `STUDENT#<sid>`, donc `FOLDER#` est couvert (test dans `shared/scans.test.ts`). `deleteDocTree` n'a rien a nettoyer (pas de liste dans le dossier).
- **Export** (`GET /family/export`): `StudentExport.folders` (nom, date) et `DocExport.topic`, `folderId`. Le lot back B2 les ajoute.

### Index: aucun nouveau

La liste d'un eleve fait deux `Query` sur sa partition (`SK begins_with JOB#` et `DOC#`), sans index. Filtre, tri et pagination se font en memoire (`listScans`): aucun des filtres (matiere, sujet, dossier, statut) ne fait un acces par cle utile avec moins de 1000 fiches par eleve. Parent: une paire de `Query` par eleve (cinq eleves au plus), `GSI1` n'est pas utilise (il ne porte que les fiches, pas les jobs en cours).

Cout (DynamoDB a la demande, lecture eventuellement coherente, 0,5 unite par 4 Ko): une fiche pese environ 2,5 Ko (empreinte de 64 entiers et resume), une liste de 200 fiches lit environ 500 Ko, soit 63 unites de lecture, de l'ordre de 0,00001 EUR. Un polling toutes les 3 s pendant 3 minutes avec 5 scans en cours et 200 fiches: 60 listes, environ 0,0006 EUR.
shortcut: le polling relit les fiches a chaque tour. Si le cout ou la latence gene (plus de 500 fiches), le front interroge `GET /jobs/{jobId}` (une lecture d'element) tant qu'un scan est en cours et ne relit la liste qu'a la fin.

Seuils de reprise: au-dela de 1000 fiches par eleve ou 300 ms de liste, passer a un index local `LSI` (matiere, date) ou a un `GSI` `STUDENT#<sid>` / `SUBJECT#<matiere>#<date>`; ce serait une decision d'infra separee.

### Droits IAM necessaires (resume, detail dans docs/feat-a-lots.md)

Les nouvelles fonctions n'utilisent que `STUDENT#*` et `FAMILY#*` (deja autorises par `dynamodb:LeadingKeys`). Seul `folders-api` demande un role neuf (`GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem` sur ces deux partitions): `writeRole` n'a pas `DeleteItem`, `deleteRole` n'a pas `PutItem` ni `UpdateItem`. Aucun acces S3, Bedrock ni Step Functions de plus.

### Delai de confirmation: 12 h (etait 30 min)

`CONFIRM_TIMEOUT_S = 12 * 3600` dans `shared/scans.ts` est la source unique. Promesse tenue: photo supprimee au plus tard 1 jour apres l'envoi (`docs/decisions.md` D10) = 20 min d'attente d'envoi, 5 min de lecture au plus, 12 h de confirmation (environ 12,5 h); le cycle de vie S3 (1 a 2 jours) reste le filet. Les elements `TEXT#` (7 jours) et le job (7 jours) couvrent deja ce delai; aucun TTL a changer. Une execution deja en cours au deploiement garde ses 30 min (definition figee a son demarrage): son job n'a pas `confirmExpiresAt`, donc aucune echeance n'est affichee pour lui.
