# FEAT-A: decoupage en lots (back, infra, front), sans fichier partage

Prerequis: cette PR (contrat 1.3, `shared/**`, `docs/data-model.md`) fusionnee. Aucun des lots ci-dessous ne modifie `shared/**`, `shared/contract/openapi.yaml` ni `docs/data-model.md`: une demande de changement revient au proprietaire du contrat. Un fichier n'apparait que dans un seul lot.

Regles communes: aucun texte de cours dans les journaux; aucun appel reel a Bedrock (modele simule); pas de PNG dans le depot; compte factice `123456789012`; commits `Worxfr <worx@pouf.org>`.

## Lot B1 (back, pipeline): envoi multi-pages, statut, suggestions

Possede:
- `api/src/pipeline/api.ts` (`scansCreate`, `jobView`, `jobsGet`, `jobsTranscription`, `jobsConfirm`)
- `api/src/pipeline/ports.ts` (`presignPost` pour une cle donnee, adaptateur memoire compris)
- `api/src/pipeline/steps.ts`, `steps-doc.ts`, `prompts.ts`, `job.ts`, `ctx.ts`
- `api/src/pipeline/testkit.ts`, `pipeline.test.ts`, `review.test.ts`, `units.test.ts`, `presign.test.ts`, `dynamo.test.ts` (ajouts de tests)

A faire:
1. `scansCreate`: valider `contentTypes` (longueur = `pages`, sinon 400 avant toute reservation), `folderId` (cle `FOLDER#` de l'eleve, sinon 404 avant reservation). Ecrire `contentTypes`, `folderId` sur le job. Une URL pre-signee **par page** (`uploads`, cle `scans/<sid>/<job>/<p-1>`, type fige par page, 5 Mo), `upload = uploads[0]`. Reservation tout ou rien deja en place (`reservePages(pages)`); rendue en cas d'echec (inchange). Le bug actuel: `pages > 1` ne donne qu'une URL, le job n'est jamais complet et expire.
2. `scanCheck`: comparer le contenu de chaque page a son type (`contentTypes[n]`, a defaut `contentType`), pas au type du job entier.
3. `transcribe`: demander dans le meme appel `matiere` et `sujet` (liste fermee, 80 caracteres), garder la 1re page qui en fournit un, ecrire `suggestedSubject`, `suggestedTopic` (via `cleanTopic`), incrementer `pagesRead` apres chaque page. Pas d'appel de modele supplementaire.
4. `jobView`: ajouter `status` (`statusOfJob` de `shared/scans.ts`). `jobsTranscription`: ajouter `suggestedSubject`, `suggestedTopic`. Les URLs de photos restent triees par index (10 pages au plus: un seul chiffre; au-dela le tri lexical serait faux, voir risques).
5. `jobsConfirm`: accepter `subject`, `topic`, `folderId` (404 si dossier inconnu); les ecrire sur le job (`subjectChoice`, `topicChoice`, `folderId`) dans la meme transition que `a_confirmer -> verification`.
6. `extract`: ecrire `stage: 'fiche'` au debut, `stage: 'verification'` a la fin (avant `verify-run`). `generate`: copier sur la fiche `sujet` (`topicChoice ?? suggestedTopic`), `matiere` (`subjectChoice ?? draftSubject`), `dossierId` (`folderId` s'il existe encore), `pages`.
7. **Delai de confirmation 12 h** (cote code): `api/src/pipeline/steps.ts` importe `CONFIRM_TIMEOUT_S` de `shared/scans.ts` (supprimer la constante locale de 30 min), `awaitConfirm` ecrit `confirmExpiresAt = awaitingSince + CONFIRM_TIMEOUT_S` (a la meme transition que `a_confirmer`, une relance de l'etape ne le change pas), `MSG.expiredConfirm` devient « Pas de confirmation apres 12 heures, la photo est supprimee » (en dur dans le message: le deriver de la constante si facile). Test: l'echeance est ecrite; une relance garde la premiere; l'expiration rend le quota et supprime la photo.
8. Plafond de cout par traitement: voir le rapport (question ouverte Q1) avant de fusionner ce lot avec N > 2 pages.

Tests (a ecrire par B1): scan 1 page (comme avant), 3 pages (3 URLs, ordre), types mixtes jpeg+png, `contentTypes` de mauvaise longueur, dossier inconnu sans reservation, echec en cours (pages rendues), statut a chaque etat, confirmation avec choix, ancien job sans champs 1.3.

## Lot B2 (back, lecture et ecriture des listes): liste, fiches, dossiers, export

Possede (fichiers nouveaux sauf mention):
- `api/src/scans/list.ts` (+ `list.test.ts`): handler `scans-list`
- `api/src/folders/folders.ts` (+ `folders.test.ts`): handler `folders-api` (5 routes)
- `api/src/docs/docs.ts` (existant, + `docs.test.ts` s'il existe): `docs-read` renvoie `topic`, `folderId` dans `DocSummary`; nouveau `docsPatch`
- `api/src/pipeline/entry.ts`: exports `scansListHandler`, `docsPatchHandler`, `foldersHandler` (seul changement du fichier; B1 n'y touche pas)
- `api/src/family/family.ts` (+ `family.test.ts`): export `folders` par eleve, `topic`/`folderId` par fiche

A faire:
1. `scans-list` (**B2 en est proprietaire**: `api/src/scans/list.ts`): passer `now` a `listScans` (heure du serveur); identite (`callerOf`); eleve: sa partition; parent: eleves de sa famille (lus dans `FAMILY#<fid>`), `studentId` hors famille = 404, eleve avec `studentId` d'un autre = 403. Deux `Query` par eleve (`JOB#`, `DOC#`) et `FOLDER#`, puis `listScans` (`shared/scans.ts`). `UnknownFolderError` = 404, `BadCursorError` et parametres invalides = 400 (`requete_invalide`). Ne jamais lire ni renvoyer `resume`, `empreinteMinHash`, texte.
2. `docs-patch`: eleve seulement (parent 403), `{}` = 400 (`minProperties` n'est pas dans le Zod genere), `topic: null` retire `sujet`, `cleanTopic` sur la valeur; mise a jour conditionnelle sur la fiche de l'eleve (`attribute_exists`), 404 sinon.
3. `folders-api`: creation (50 au plus, `nomCle` unique: 409; `cleanFolderName` vide = 400), renommage (409 si `nomCle` pris par un autre dossier, le meme nom que lui-meme est permis), suppression (retire `dossierId` des fiches, puis supprime le dossier; ordre: fiches d'abord, pour qu'une interruption laisse un dossier a re-supprimer plutot que des fiches rangees dans un dossier fantome), `POST .../scans` (valide tout avant d'ecrire; `docId` inconnu = 404 pour l'ensemble; deplace une fiche rangee ailleurs), `DELETE .../scans/{docId}` (404 si la fiche n'est pas dans ce dossier). `scanCount` calcule a la lecture. Parent: `GET` seulement, tout le reste 403.
4. Export famille: `folders` par eleve, `topic` et `folderId` par fiche.

Tests (a ecrire par B2): voir « entrees voisines » dans le rapport: scan 1 page existant, scan sans matiere, dossier vide, dossier d'un autre eleve (via les handlers, avec deux eleves et deux familles), parent d'une autre famille, parent qui tente d'ecrire, suppression de dossier interrompue.

## Lot I (infra): un seul proprietaire

Possede: `infra/lib/api-stack.ts`, `infra/lib/pipeline-stack.ts`, `infra/test/**`.

A faire, apres B2 (les exports d'`entry.ts` doivent exister):
0. **`CONFIRM_TIMEOUT` (`infra/lib/pipeline-stack.ts`, ligne `Duration.minutes(30)`): ce lot en est proprietaire.** Remplacer par `Duration.seconds(CONFIRM_TIMEOUT_S)` importee de `shared/scans.ts` (12 h). Un seul changement dans ce fichier pour cette constante. Verifier dans le test d'infra que le delai de la tache `AttenteConfirmation` vaut 43200 s et que le cycle de vie S3 (1 jour) reste en place. Cout: une attente `waitForTaskToken` ne coute que les transitions d'etat (aucun frais par heure d'attente). Ne pas monter au-dela de 20 h (promesse « 1 jour »).
1. `api-stack.ts`: passer `owner: 'pipeline'` aux 8 lignes de FEAT-A deja presentes (ajoutees en squelettes par cette PR, avec leurs limitations).
2. `pipeline-stack.ts`: 3 fonctions (`scans-list`, `docs-patch`, `folders-api`) dans `API_FUNCTIONS`, avec ces roles:
   - `scans-list`: `readRole` existant (`GetItem`, `Query`). Rien a ajouter.
   - `docs-patch`: `writeRole` existant (`GetItem`, `Query`, `PutItem`, `UpdateItem`). Rien a ajouter.
   - `folders-api`: **nouveau role** `pipeline-api-folders-role`: `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, avec la meme condition `dynamodb:LeadingKeys` (`FAMILY#*`, `STUDENT#*`). Pas de S3, pas de Bedrock, pas de Step Functions. Journal 14 jours comme les autres.
3. Index DynamoDB: **aucun**. Table, TTL, S3, EventBridge, Step Functions: inchanges.
4. Verifier que le role de `family-admin` (export) lit `FOLDER#` (partition `STUDENT#*`): normalement deja le cas.
5. Tests d'infra: les 8 routes ont une fonction, `folders-api` n'a pas `s3:*`, `bedrock:*`, `states:*`; la liste des fonctions Bedrock (`processingRoleNames`) est inchangee.
6. Hors FEAT-A: tag de cout `project` (lot infra separe).

## Lot F (front): un seul proprietaire

Possede: tout `web/src/**` (`api.ts`, `types.ts`, `router.ts`, `game.ts`, `App.tsx`, `style.css`, `screens/Scan.tsx`, `screens/Home.tsx`, `screens/Parent.tsx`, `screens/Doc.tsx`, nouveaux `screens/Docs.tsx`, `screens/Folders.tsx`, composants et tests) et `e2e/**`.

A faire: `docs/scan-screens.md`. Types depuis `shared/contract/generated/types.ts` (`web/src/types.ts` reexporte). Peut etre developpe en parallele de B1/B2 contre le simulateur (`npm run mock`, Prism, exemples du contrat) et teste en vrai apres leur fusion.

## Ordre

1. Cette PR (contrat). 2. B1 et B2 en parallele (aucun fichier commun; B2 touche `entry.ts`, B1 non). F en parallele. 3. I apres B2. 4. Deploiement dev par la CI, puis test de bout en bout avec comptes de test (scan de 3 pages, filtres, dossier, parent).

## Fichiers communs a surveiller

- `api/src/pipeline/entry.ts`: B2 seul. `api/src/pipeline/ctx.ts`: B1 seul; B2 le lit.
- `infra/lib/api-stack.ts` et `pipeline-stack.ts`: I seul.
- `shared/**`: personne apres cette PR (demande au proprietaire du contrat).
