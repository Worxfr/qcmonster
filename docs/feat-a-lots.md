# FEAT-A: decoupage en lots (back, infra, front), sans fichier partage

Prerequis: cette PR (contrat 1.3, `shared/**`, `docs/data-model.md`) fusionnee. Seul B1 modifie `shared/bedrock.ts`, `shared/cost.ts` et `shared/names.ts` (lot « B1 bis » et plafond de cout); aucun des lots ne modifie le reste de `shared/**`, `shared/contract/openapi.yaml` ni `docs/data-model.md`: une demande de changement revient au proprietaire du contrat. Un fichier n'apparait que dans un seul lot.

Regles communes: aucun texte de cours dans les journaux; aucun appel reel a Bedrock (modele simule); pas de PNG dans le depot; compte factice `123456789012`; commits `Worxfr <worx@pouf.org>`.

## Lot B1 (back, pipeline): envoi multi-pages, statut, suggestions

Possede:
- `api/src/pipeline/api.ts` (`scansCreate`, `jobView`, `jobsGet`, `jobsTranscription`, `jobsConfirm`)
- `api/src/pipeline/ports.ts` (`presignPost` pour une cle donnee, adaptateur memoire compris)
- `api/src/pipeline/steps.ts`, `steps-doc.ts`, `prompts.ts`, `job.ts`, `ctx.ts`
- `api/src/pipeline/testkit.ts`, `pipeline.test.ts`, `review.test.ts`, `units.test.ts`, `presign.test.ts`, `dynamo.test.ts` (ajouts de tests)

A faire:
1. `scansCreate`: valider `contentTypes` (longueur = `pages`, sinon 400 avant toute reservation), `folderId` (cle `FOLDER#` de l'eleve, sinon 404 avant reservation). Ecrire `contentTypes`, `folderId` sur le job. Une URL pre-signee **par page**: B1 appelle `presignPost` **N fois** (signature actuelle de `entry.ts` et de `ports.ts`, inchangee), avec `firstKey` = cle de la page p (`scans/<sid>/<job>/<p-1>`) et `contentType` = `contentTypes[p-1]` (a defaut `contentType`); aucun changement d'`entry.ts`, qui reste a B2 pour ses seuls exports. Resultat dans `uploads` ( cle `scans/<sid>/<job>/<p-1>`, type fige par page, 5 Mo), `upload = uploads[0]`. Reservation tout ou rien deja en place (`reservePages(pages)`); rendue en cas d'echec (inchange). Le bug actuel: `pages > 1` ne donne qu'une URL, le job n'est jamais complet et expire.
2. `scanCheck`: comparer le contenu de chaque page a son type (`contentTypes[n]`, a defaut `contentType`), pas au type du job entier.
3. `transcribe`: ecrire la page lue dans l'ensemble `readPages` (`ADD` d'un ensemble de nombres, idempotent: une reprise de l'etape ne la compte pas deux fois; jamais un compteur `ADD 1`). Demander dans le meme appel `matiere` et `sujet` (liste fermee, 80 caracteres), garder la 1re page qui en fournit un, ecrire `suggestedSubject`, `suggestedTopic` (via `cleanTopic`), Pas d'appel de modele supplementaire.
4. `jobView`: ajouter `status` (`statusOfJob` de `shared/scans.ts`). `jobsTranscription`: ajouter `suggestedSubject`, `suggestedTopic`. Les URLs de photos restent triees par index (10 pages au plus: un seul chiffre; au-dela le tri lexical serait faux, voir risques).
5. `jobsConfirm`: **refuser (400 `requete_invalide`) un `topic` vide apres `cleanTopic`** (le schema Zod laisse passer « <> » ou des espaces: le serveur nettoie puis controle), puis accepter `subject`, `topic`, `folderId` (404 si dossier inconnu); les ecrire sur le job (`subjectChoice`, `topicChoice`, `folderId`) dans la meme transition que `a_confirmer -> verification`.
6. **Regle `message`**: ne jamais ecrire dans `job.message` le texte d'une erreur de service (AWS, Bedrock, Step Functions, exception JS): seulement les constantes `MSG` ou `MESSAGES` (la liste les renvoie telles quelles a l'eleve et au parent).
6 bis. `extract`: ecrire `stage: 'fiche'` au debut, `stage: 'verification'` a la fin (avant `verify-run`). `generate`: copier sur la fiche `sujet` (`topicChoice ?? suggestedTopic`), `matiere` (`subjectChoice ?? draftSubject`), `dossierId` (`folderId` s'il existe encore), `pages`.
7. **Delai de confirmation 12 h** (cote code): `api/src/pipeline/steps.ts` importe `CONFIRM_TIMEOUT_S` de `shared/scans.ts` (supprimer la constante locale de 30 min), `awaitConfirm` ecrit `confirmExpiresAt = awaitingSince + CONFIRM_TIMEOUT_S` (a la meme transition que `a_confirmer`, une relance de l'etape ne le change pas), `MSG.expiredConfirm` devient « Pas de confirmation apres 12 heures, la photo est supprimee » (en dur dans le message: le deriver de la constante si facile). Test: l'echeance est ecrite; une relance garde la premiere; l'expiration rend le quota et supprime la photo.
8. **Plafond de cout proportionnel** (decision du 2026-11-25): `jobCapEur(pages) = max(0,25 ; 0,15 x pages)` EUR (1,50 EUR a 10 pages), documente dans `docs/cost-guard.md`. **La fonction pure `jobCapEur` et ses tests sont deja dans cette PR (`shared/names.ts`, `shared/scans.test.ts`)**; B1 n'a qu'a l'**utiliser**. **B1 est proprietaire de l'usage dans `shared/names.ts` et dans `api/src/verify/run.ts` ligne 71** (le plafond y est code en dur: `Math.min(input.budgetRestantCentimes / 100, JOB_COST_CAP_EUR)`; `pages` n'y est pas connu: le passer par l'entree de `verify-run` ou calculer `budgetRestantCentimes` a partir de `jobCapEur(pages)` dans `extract`, a B1 de choisir, sans changer le schema d'entree de L2b sans accord). L'utiliser dans `budgetLeftCents` (`steps-doc.ts`), dans `callModel` (`ctx.ts`, option `jobCapEur` qui existe deja dans `shared/bedrock.ts`) et a la ligne du `Math.min(..., JOB_COST_CAP_EUR)` de `api/src/verify/run.ts` (une ligne, L2b: derogation B1). Les `pages` viennent du job. Tests: 1 page = 0,25; 3 pages = 0,45; 10 pages = 1,50; le refus a lieu avant l'appel; le plafond d'essais de 50 EUR prime. Sans ce point, un scan de 3 pages ou plus finit en `non_verifiable`.

Tests (a ecrire par B1): **fiche creee avec `sujet`, `dossierId` et `pages`** (le `FicheItemSchema.parse` de `generate` supprime les cles inconnues: sans ce test la copie passe inapercue), dossier supprime avant `generate` (pas de `dossierId` fantome), reprise de `transcribe` (`readPages` idempotent), evenement S3 redelivre apres liberation (erreur du jeton absorbee), plafond `jobCapEur` a 1, 3 et 10 pages dans `extract` ET `verify-run`, `topic` « <> » = 400, scan 1 page (comme avant), 3 pages (3 URLs, ordre), types mixtes jpeg+png, `contentTypes` de mauvaise longueur, dossier inconnu sans reservation, echec en cours (pages rendues), statut a chaque etat, confirmation avec choix, ancien job sans champs 1.3.

## Lot B2 (back, lecture et ecriture des listes): liste, fiches, dossiers, export

Possede (fichiers nouveaux sauf mention):
- `api/src/scans/list.ts` (+ `list.test.ts`): handler `scans-list`
- `api/src/folders/folders.ts` (+ `folders.test.ts`): handler `folders-api` (5 routes)
- `api/src/docs/docs.ts` (existant, + `docs.test.ts` s'il existe): `docs-read` renvoie `topic`, `folderId` dans `DocSummary`; nouveau `docsPatch`
- `api/src/pipeline/entry.ts`: exports `scansListHandler`, `docsPatchHandler`, `foldersHandler` (seul changement du fichier; B1 n'y touche pas)
- `api/src/family/family.ts` (+ `family.test.ts`): export `folders` par eleve, `topic`/`folderId` par fiche

A faire:
1. `scans-list` (**B2 en est proprietaire**: `api/src/scans/list.ts`): passer `now` a `listScans` (heure du serveur); identite (`callerOf`); ordre des controles: **role d'abord (403 pour qui n'a pas le droit), puis existence (404)**, jamais l'inverse (sinon un parent apprend qu'un identifiant existe); un eleve qui passe un `studentId` etranger: 404; eleve: sa partition; parent: eleves de sa famille (lus dans `FAMILY#<fid>`), `studentId` hors famille = 404, eleve avec `studentId` d'un autre = 403. Deux `Query` par eleve (`JOB#`, `DOC#`) et `FOLDER#`, **chacune paginee jusqu'au bout** (`LastEvaluatedKey`: une `Query` s'arrete a 1 Mo, soit ~400 fiches entieres, et renverrait sinon une liste tronquee sans erreur), avec une `ProjectionExpression` qui **exclut `empreinteMinHash` et `resume`** (garder seulement les champs lus par `shared/scans.ts`: cles, `titre`, `matiere`, `sujet`, `dossierId`, `pages`, `pagesConsommees`, `jobId`, `createdAt`; pour les jobs: etat, `stage`, `pages`, `uploadedKeys`, `readPages`, `createdAt`, `finishedAt`, `message`, `docId`, `draftTitle`, `draftSubject`, `suggested*`, `*Choice`, `folderId`, `confirmExpiresAt`). La projection ne reduit pas les unites de lecture (facturees sur la taille de l'element) mais allege la memoire et la reponse. Puis `listScans` (`shared/scans.ts`). `UnknownFolderError` = 404, `BadCursorError` et parametres invalides = 400 (`requete_invalide`). Ne jamais lire ni renvoyer `resume`, `empreinteMinHash`, texte.
2. `docs-patch`: eleve seulement (parent 403 avant toute recherche de la fiche), `{}` = 400 (`minProperties` n'est pas dans le Zod genere), **`topic` vide apres `cleanTopic` (par exemple « <> » ou des espaces) = 400 `requete_invalide`**, `topic: null` retire `sujet`, `cleanTopic` sur la valeur; mise a jour conditionnelle sur la fiche de l'eleve (`attribute_exists`), 404 sinon.
3. `folders-api`: creation (50 au plus: **400 code `dossiers_limite`**; `nomCle` deja pris: **409 code `dossier_nom_pris`**; `cleanFolderName` vide apres nettoyage = 400 `requete_invalide`; role d'abord (403 parent), puis existence (404)), meme code `dossier_nom_pris` au renommage, renommage (409 si `nomCle` pris par un autre dossier, le meme nom que lui-meme est permis), suppression (retire `dossierId` des fiches, puis supprime le dossier; ordre: fiches d'abord, pour qu'une interruption laisse un dossier a re-supprimer plutot que des fiches rangees dans un dossier fantome), `POST .../scans` (valide tout avant d'ecrire; `docId` inconnu = 404 pour l'ensemble; deplace une fiche rangee ailleurs), `DELETE .../scans/{docId}` (404 si la fiche n'est pas dans ce dossier). `scanCount` calcule a la lecture (une `Query` des fiches par `GET /folders`, paginee comme la liste; 50 dossiers au plus). Suppression d'un dossier de 1000 fiches: mises a jour par lots de 25 en parallele, de l'ordre de 2 s; la fonction a un delai de 30 s (lot I); interrompue, elle se reprend par un second `DELETE`. Parent: `GET` seulement, tout le reste 403.
4. Export famille: `folders` par eleve, `topic` et `folderId` par fiche.

Tests (a ecrire par B2): voir « entrees voisines » dans le rapport: scan 1 page existant, scan sans matiere, dossier vide, dossier d'un autre eleve (via les handlers, avec deux eleves et deux familles), parent d'une autre famille, parent qui tente d'ecrire, suppression de dossier interrompue.

## Lot B1 bis: alarme de cout 10 EUR (proprietaire: B1)

Probleme: l'alarme `qcm-<env>-cout-mensuel-10` ne s'est jamais declenchee (voir `docs/cost-guard.md`, `FEAT-D-report.md` section 4). Proprietaire: **B1**, avec le role infra pour les droits (lot I, ci-dessous). Fichiers de B1 en plus de sa liste, sans autre lot qui les touche: `shared/bedrock.ts` (`costStoreFromDynamo`), `shared/cost.ts` (`publishCostMetric`), `shared/names.ts` (`jobCapEur`), leurs tests, et `api/src/verify/run.ts` (une ligne, plafond). Apres la fusion de cette PR, B1 est donc le seul a toucher `shared/bedrock.ts`, `shared/cost.ts`, `shared/names.ts`.

A faire:
1. `costStoreFromDynamo(client, table, now?, cw?)` publie par defaut: apres `addCost`, il appelle `publishCostMetric(cw, env, monthEur)` (client CloudWatch cree a la demande, region de la Lambda); erreur capturee, journalisee (`status: 'metric-error'`, aucun texte de cours), jamais propagee. Ainsi **`api/src/pipeline/entry.ts` (B2) et `api/src/verify/handler.ts` ne changent pas**: aucun fichier partage avec un autre lot.
2. Tests: une metrique par ecriture du compteur, valeur = total du mois, une erreur CloudWatch ne fait pas echouer l'appel de modele ni ne double le cout, aucune metrique si l'ecriture du compteur echoue.
3. Verification apres deploiement dev: la metrique `QCMonster` / `CostMonth` / `Env=dev` existe dans CloudWatch apres un scan (CLI en lecture), et l'alarme quitte `INSUFFICIENT_DATA`.
Variante sans code (non retenue): remplacer l'alarme par un budget AWS de 10 EUR filtre sur le tag; elle reste possible si on prefere ne pas publier de metrique.

## Lot I (infra): un seul proprietaire

Possede: `infra/lib/api-stack.ts`, `infra/lib/pipeline-stack.ts`, `infra/lib/verify-stack.ts` (droit CloudWatch seulement), `infra/test/**`.

A faire, apres B2 (les exports d'`entry.ts` doivent exister):
0. **`CONFIRM_TIMEOUT` (`infra/lib/pipeline-stack.ts`, ligne `Duration.minutes(30)`): ce lot en est proprietaire.** Remplacer par `Duration.seconds(CONFIRM_TIMEOUT_S)` importee de `shared/scans.ts` (12 h). Un seul changement dans ce fichier pour cette constante. Verifier dans le test d'infra que le delai de la tache `AttenteConfirmation` vaut 43200 s et que le cycle de vie S3 (1 jour) reste en place. Cout: une attente `waitForTaskToken` ne coute que les transitions d'etat (aucun frais par heure d'attente). Ne pas monter au-dela de 20 h (promesse « 1 jour »).
1. `api-stack.ts`: passer `owner: 'pipeline'` aux 8 lignes de FEAT-A deja presentes (ajoutees en squelettes par cette PR, avec leurs limitations).
2. `pipeline-stack.ts`: 3 fonctions (`scans-list`, `docs-patch`, `folders-api`) dans `API_FUNCTIONS`, avec ces roles:
   - `scans-list`: `readRole` existant (`GetItem`, `Query`). Rien a ajouter.
   - `docs-patch`: **role etroit** `pipeline-api-patch-role`: `GetItem` et `UpdateItem` seulement, condition `LeadingKeys` `STUDENT#*` (pas `FAMILY#*`: le parent n'a pas ce droit), pas de `PutItem` (qui permettrait de creer ou d'ecraser une fiche), pas de `Query`, pas de S3. Le handler fait un `UpdateItem` conditionnel `attribute_exists(PK)`. `writeRole` n'est pas utilise ici.
   - `folders-api`: **nouveau role** `pipeline-api-folders-role`: `GetItem`, `Query`, `PutItem`, `UpdateItem`, `DeleteItem`, avec la meme condition `dynamodb:LeadingKeys` (`FAMILY#*`, `STUDENT#*`). Pas de S3, pas de Bedrock, pas de Step Functions. Journal 14 jours comme les autres. Delai de la fonction: 30 s (suppression d'un grand dossier). Reserve: trois fonctions au lieu d'une permettraient de retirer `DeleteItem` a `GET /folders` et `POST .../scans`; une seule fonction retenue, `DeleteItem` limite a `STUDENT#*`/`FAMILY#*`. `scans-create` et `jobs-confirm` (B1) lisent `FOLDER#` pour le 404: `writeRole` a deja `GetItem` sur `STUDENT#*`, rien a ajouter (test d'infra a ecrire).
3. Index DynamoDB: **aucun**. Table, TTL, S3, EventBridge, Step Functions: inchanges.
4. Verifier que le role de `family-admin` (export) lit `FOLDER#` (partition `STUDENT#*`): normalement deja le cas.
5. Tests d'infra: les 8 routes ont une fonction, `folders-api` n'a pas `s3:*`, `bedrock:*`, `states:*`; la liste des fonctions Bedrock (`processingRoleNames`) est inchangee.
6. **Alarme 10 EUR (pour B1 bis)**: ajouter a `pipeline-role` (`pipeline-stack.ts`) et au role de `verify-run` (`verify-stack.ts`, `verifyRoleName`) `cloudwatch:PutMetricData` sur `*` (l'action n'accepte pas de ressource) avec la condition `StringEquals: { 'cloudwatch:namespace': 'QCMonster' }` (constante `METRIC_NAMESPACE`). Rien pour les roles de lecture, d'ecriture, de suppression ni de dossiers. Test: aucun autre role n'a `cloudwatch:*`. `budget-stack.ts` (l'alarme elle-meme) ne change pas. A deployer avant ou avec B1 bis.
7. Hors FEAT-A: tag de cout `project` (lot infra separe).

## Lot F (front): un seul proprietaire

Possede: tout `web/src/**` (`api.ts`, `types.ts`, `router.ts`, `game.ts`, `App.tsx`, `style.css`, `screens/Scan.tsx`, `screens/Home.tsx`, `screens/Parent.tsx`, `screens/Doc.tsx`, nouveaux `screens/Docs.tsx`, `screens/Folders.tsx`, composants et tests) et `e2e/**`.

A faire: `docs/scan-screens.md`. Types depuis `shared/contract/generated/types.ts` (`web/src/types.ts` reexporte). Peut etre developpe en parallele de B1/B2 contre le simulateur (`npm run mock`, Prism, exemples du contrat) et teste en vrai apres leur fusion.

## Ordre

1. Cette PR (contrat). 2. B1 et B2 en parallele (aucun fichier commun; B2 touche `entry.ts`, B1 non). F se developpe en parallele mais **ne se fusionne ni ne se deploie avant I** (sinon `GET /scans` repond 501 et l'ecran « Mes cours » est vide). Ordre de fusion: **B1, B2, I, F**. 3. I apres B2. 4. Deploiement dev par la CI, puis test de bout en bout avec comptes de test (scan de 3 pages, filtres, dossier, parent).

## Fichiers communs a surveiller

- `api/src/pipeline/entry.ts`: B2 seul. `api/src/pipeline/ctx.ts`: B1 seul; B2 le lit.
- `infra/lib/api-stack.ts` et `pipeline-stack.ts`: I seul.
- `shared/**`: personne apres cette PR, sauf B1 pour `bedrock.ts`, `cost.ts`, `names.ts` (plafond proportionnel et alarme). Contrat et modele de donnees: demande au proprietaire du contrat.
