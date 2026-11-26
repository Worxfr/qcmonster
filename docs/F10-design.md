# F10 : ajouter des pages à un cours existant

Demande du propriétaire : l'élève doit pouvoir ajouter des pages à un cours déjà scanné. Le cours reste complet, les nouvelles pages donnent des sections et des fiches par sujet, et le pipeline lit les nouvelles pages comme un seul document.

Cette PR ne contient que de la conception. Révision 2 : corrections de la relecture indépendante (5 bloquants, 8 corrections) et décisions du conducteur. Elle ne touche ni `shared/contract/openapi.yaml` ni `shared/contract/generated/` : la PR #82 (R1, contrat 1.5.0) en est seule propriétaire tant qu'elle n'est pas fusionnée. Les changements de contrat proposés sont décrits en section 9 (contrat 1.6.0, à écrire après la fusion de R1). Aucun appel Claude ni AWS n'a été fait pour l'écrire.

Base lue : `main` à `781e9c2` (contrat 1.4.1), en particulier `api/src/pipeline/{api,steps,steps-doc,job,quota-ops,text,entry}.ts`, `api/src/cours/*`, `api/src/scans/list.ts`, `shared/{items,scans,names,delete-tree}.ts`, `docs/H1-design.md` et `docs/R1-design.md` (PR #82).

## 0. Résumé des décisions

| # | Sujet | Décision par défaut |
|---|---|---|
| D1 | Effet sur l'existant | **Additif.** Les nouvelles pages créent de **nouvelles sections et de nouvelles fiches**. Les fiches, QCM et trous déjà créés ne sont ni refaits ni modifiés. |
| D2 | Mécanisme | Un ajout est **un job de scan ordinaire** (même machine d'états, mêmes étapes) avec `appendTo = <coursId>`. Aucune nouvelle Lambda ni nouvelle machine. |
| D3 | Place des pages | **À la fin du cours seulement.** Les nouvelles pages sont numérotées à la suite (`p<N+1>-s1`…). Pas d'insertion au milieu en v1. |
| D4 | Phrase à cheval | **Pas de recollage** avec la dernière phrase existante (elle n'est jamais réécrite). Les deux dernières phrases du cours servent de **contexte en lecture seule**, comme les tranches de F11. |
| D5 | Relecture | L'élève ne relit que les **nouvelles pages**. Le contexte est montré grisé, non modifiable. |
| D6 | Quota et coût | Quota **par page ajoutée**, réservé à la création, consommé une fois. Plafond de coût du job `max(0,25 ; 0,15 × pages ajoutées)` (`jobCapEur`, inchangé). |
| D7 | Limites du cours | 30 pages et 20 sections par cours au total (nouvelles constantes). Un ajout est borné à `20 − sectionsBefore` sections ; refus dès la création si le cours en a déjà 20. |
| D8 | Concurrence | **Un seul ajout ouvert par cours.** Le verrou (`appendJobId` sur l'en-tête) et le job sont créés dans **une seule transaction**. Le verrou est libéré **en dernier pas** de la restauration. Pas d'ajout tant que le scan d'origine n'est pas terminé. |
| D9 | Échec | **Tout ou rien pour l'ajout seulement** : le cours d'origine est restauré tel quel (texte, sections, fiches) à partir d'une base écrite **à la création**. Aujourd'hui `failJob` supprime tout le cours ; pour un ajout ce serait une perte de données (section 6). |
| D10 | Historique de tests (H1) | Inchangé : les `docId` existants ne bougent pas, donc aucun passage `TEST#` n'est touché. |
| D12 | Liste des scans | **Un ajout = un scan.** Ses fiches forment leur propre groupe dans « Mes fiches » (même `scanId` = job de l'ajout). `sectionCount` des fiches d'origine n'est **pas** réécrit. La vue d'ensemble d'un cours est l'écran `GET /cours/{id}`. |
| D11 | Confidentialité | Aucune donnée nouvelle ni durée nouvelle, mais un nouveau traitement du texte conservé (deux phrases renvoyées à Bedrock). Textes dans un commit séparé. **`POLICY_VERSION` : pas de hausse propre à F10, elle suit la hausse unique de R1** (décision du propriétaire, section 7). |

## 1. Ce qui existe (main `781e9c2`)

- **Cours** : en-tête `STUDENT#<sid> / COURS#<coursId>` (`pages` 1 à 10, `sections` 1 à 6, `jobId`, `nbPhrases`) et textes `COURS#<coursId>#T<nn>`. Sans TTL. `coursId` est égal à l'identifiant du job qui l'a créé (déterministe : une relance ne laisse pas d'orphelin).
- **Phrases** : identifiant `p<page>-s<n>`, ordre du texte = pages triées numériquement. Les sections sont des coupes par `fromSentenceId` (`planSections` : au plus 6, au plus `2 × pages`, première coupe à la première phrase, 40 mots au total).
- **Pipeline** (`transcribe` → `awaitConfirm` → `sectionsPlan` → `extract` / `verify-run` / `sectionCost` par section → `quotaConsume` → `generate` par section → `finalize`). Il lit **tout** le texte du job (`sortedTexts(ctx, jobId)`), jamais celui du cours.
- **Confirmation** (`jobsConfirm`) : écrit l'en-tête et les textes du cours, puis passe le job à `verification`. Si la course est perdue (annulation, expiration), elle supprime le cours avec `deleteCoursTree`.
- **Échec** (`failJob`, `purgeScan`) : supprime les fiches du job **et le cours entier** (`deleteCoursTree(job.coursId)`).
- **Quota** (`quota-ops.ts`) : pages réservées à `POST /scans`, consommées une fois (`QUOTAOP#<job>#consume`), rendues une fois sur échec. Idempotent par marqueurs.
- **Coût** : `jobCapEur(pages)` = `max(0,25 ; 0,15 × pages)`, `GEN_RESERVE_CENTS` = 6 gardés pour la génération.
- **Fiche** : porte `coursId`, `sectionIndex`, `sectionCount`, `pages`, `pagesConsommees` (sur la première fiche seulement).
- **Suppression d'un cours** (`DELETE /cours/{id}?fiches=garder|supprimer`) : retire `coursId` du seul job `head.jobId`.
- **Machine d'états** : les sections sont traitées **une à la fois** (`Map` avec `maxConcurrency: 1`, `pipeline-stack.ts`). Les écritures de l'en-tête du cours par la machine sont donc séquentielles.
- **Reprise de `transcribe`** : l'étape est finie quand `JOB#<job> / TEXT#1` existe (écrit en dernier, `steps.ts:185` et `:221`).
- **Bornes de schéma** : `FicheItemSchema.sectionIndex` max 5, `sectionCount` max 6 (`shared/items.ts`) ; contrat : `ScanSummary.sectionIndex` max 5, `sectionCount` max 6, `docIds` maxItems 6.
- **Liste** (`GET /scans`, `listScans` dans `shared/scans.ts`) : groupe les fiches **par `scanId`** (le job) ; un groupe affiche au plus 6 fiches (`MAX_SECTIONS`). `coursId` n'est pas une clé de groupe. `Docs.tsx` suit ce groupement.
- **Historique H1** : un `TEST#` par passage, relié à une fiche par `docId`, supprimé avec la fiche.

## 2. Parcours de l'élève

1. Dans **Cours** (écran d'un cours), bouton « Ajouter des pages ».
2. L'écran d'envoi existant s'ouvre avec le titre « Ajouter au cours : … ». Même sélection de photos (10 au plus par ajout), même envoi.
3. Lecture des nouvelles pages seulement. Relecture : les deux dernières phrases du cours apparaissent grisées en haut, puis les nouvelles pages, avec les mêmes outils (corrections, coupes en sections, matière, sujet, dossier).
4. Confirmation : le cours s'allonge (texte et sections), les nouvelles fiches sont créées, les anciennes ne bougent pas.
5. L'écran du cours (`GET /cours/{id}`) montre toutes ses sections, dans l'ordre. Dans la liste « Mes fiches », un ajout apparaît comme un scan à part (un groupe de fiches avec ses propres numéros « 1 sur 2 »), sans modifier le groupe du scan d'origine.

## 3. Questions tranchées (défaut et justification)

### 3.1 Refaire la fiche et le QCM, ou ajouter des sections ? (P1)

**Défaut : ajouter.** Les nouvelles pages donnent de nouvelles sections et fiches ; les fiches existantes restent telles quelles.

Pourquoi :
- Une fiche existante a des affirmations vérifiées (`CLAIM#`, `VERDICT#`) ancrées sur des `phraseId`, des QCM avec `questionId`, des signalements (`REPORT#`) et des passages d'historique (`TEST#.docId`). Régénérer la fiche invalide tout cela, ou oblige à des règles de fusion fragiles.
- Cela coûte deux fois les pages déjà payées (vérification et génération de la section d'origine).
- La fonction « Mes cours » et les sections par sujet fonctionnent déjà ainsi : une section = une fiche.

Contrepartie : si les nouvelles pages prolongent le même chapitre, l'élève obtient une deuxième fiche du même sujet (par exemple « La photosynthèse, suite »). Il peut lui donner le même sujet et le même dossier, ce qui les range ensemble. L'anti-doublon (`doublon`) ne se déclenche que si le texte est presque identique (Jaccard ≥ 0,85), pas pour une suite.

Alternative écartée pour la v1 : « compléter la fiche X ». Elle demande des versions de fiche, la reprise des affirmations et un choix de politique pour l'historique des tests déjà passés. À reprendre si le propriétaire la veut (P1).

### 3.2 Place des pages : fin ou insertion ? (P2)

**Défaut : à la fin uniquement.**

Les identifiants de phrase contiennent le numéro de page (`p3-s2`), et l'ordre du texte, des coupes (`rangesOf`), de `sentencesOf` et des tranches de F11 est l'ordre des pages. Insérer au milieu obligerait soit à renuméroter des phrases déjà ancrées dans des fiches, soit à ajouter une clé d'ordre séparée que chaque lecteur du texte devrait connaître. Ce coût n'est pas justifié pour une page oubliée : l'élève ajoute la page à la fin, avec un sujet qui l'explique.

Numérotation : si le cours a `N` pages, les `k` nouvelles pages portent les numéros `N+1` à `N+k`. L'offset est appliqué **dès la lecture** (juste après `readWindow`, avant `assemblePages`) : les identifiants sont définitifs dès `TEXT#` et la relecture, donc corrections, coupes et affirmations les utilisent sans table de conversion. Les photos restent numérotées localement (`scans/<sid>/<job>/0..k-1`).

### 3.3 Phrase à cheval avec la dernière page existante (P3)

**Défaut : pas de recollage ; contexte en lecture seule.**

Recoller réécrirait la dernière phrase du cours, qui peut déjà porter une affirmation vérifiée et des questions. Au lieu de cela :
- Le premier appel de lecture reçoit les deux dernières phrases du cours **en texte** (la photo de la page précédente n'existe plus : elle est supprimée à la confirmation) avec la consigne « la première ligne de la page 1 continue-t-elle la dernière phrase ? ». La réponse `suite` existe déjà dans `ReadPage`.
- Si `suite` est vrai, la première phrase nouvelle garde son identifiant et reçoit `continuesId` (identifiant de la dernière phrase existante). Elle n'est pas jointe.
- L'extraction de la **première nouvelle section** reçoit les deux dernières phrases du cours comme `CONTEXT_SENTENCES`, déjà prévu pour F11 : « déjà traitées, aucune affirmation n'en est gardée ». Une phrase qui commence par « …et c'est pourquoi » est donc lue avec son début, sans que l'ancien texte change.
- À l'écran, la phrase de contexte est grisée au-dessus de la première nouvelle phrase, avec un trait de liaison si `continuesId` est présent.

Limite connue (`shortcut` à écrire en commentaire) : si la fin de la phrase coupée contient l'affirmation, l'ancienne fiche ne la verra pas ; seule la nouvelle section la portera. Acceptable, à revoir si les tests le montrent.

### 3.4 Relecture des seules nouvelles pages (P4)

**Défaut : oui.** `GET /jobs/{id}/transcription` ne renvoie que `TEXT#` du job (les nouvelles pages), plus `context` (deux dernières phrases du cours, texte seul) quand `appendTo` est posé. `ConfirmRequest` garde sa forme. Règles de `planSections` appliquées au texte du job seul : première coupe à la première **nouvelle** phrase, au plus `min(6, 2 × pages ajoutées)` sections, 40 mots au total sur les nouvelles pages (un ajout d'une demi-page très courte est refusé avec le message existant « Il faut au moins 40 mots… »).

Les anciennes phrases ne sont ni corrigeables ni retirables dans ce flux. Une correction de l'ancien texte relève d'une fonction d'édition du cours, qui n'existe pas aujourd'hui et qui est hors de cette demande (voir R1, section 5, « édition en place »).

### 3.5 Quota par page et plafond de coût (P5)

**Défaut : par page ajoutée.**

- `POST /scans` avec `coursId` réserve `pages` (les pages **ajoutées**) comme aujourd'hui, via `reservePages`. Même consommation unique (`quotaConsume`), même rendu sur échec. `pagesConsommees` de la première nouvelle fiche porte les pages ajoutées, comme pour un scan ordinaire.
- Le plafond de coût du job est `jobCapEur(pages ajoutées)` = `max(0,25 ; 0,15 × pages ajoutées)`. Il ne compte pas les pages existantes. La réserve de génération (6 centimes) et le calcul de budget par section (`budgetLeftCents`) sont inchangés. Le contexte de deux phrases ajoute de l'ordre de 100 jetons : négligeable.
- Le garde de coût global (`costGateFor`) s'applique à la création comme aujourd'hui (429 `budget_epuise`).
- Exemples : 1 page ajoutée = quota 1, plafond 0,25 € ; 3 pages = quota 3, plafond 0,45 €.
- Pire cas écrit : plafond par job ≤ 1,50 € (10 pages) ; par cours ≤ 4,50 € (30 pages × 0,15 €). Coût réel attendu : environ 0,09 € par page (p95 0,12 €, `docs/cost-guard.md`). La garde globale (`DEV_TRIAL_CAP_EUR`, 100 € en dev) et le quota mensuel de pages priment sur ces plafonds.

### 3.6 Limites d'un cours (P6)

Aujourd'hui un cours a au plus 10 pages et 6 sections (schémas `CoursItemSchema`, `CoursTextItemSchema`, `coursMeta` qui tronque à 6). Un ajout dépasse ces bornes. **Défaut : 30 pages et 20 sections par cours.** Constantes `MAX_COURS_PAGES = 30` et `MAX_COURS_SECTIONS = 20` dans `shared/scans.ts`. `MAX_PAGES_PER_SCAN = 10` et `MAX_SECTIONS = 6` (par ajout) ne changent pas.

Pourquoi 30 : trois scans de 10 pages ; un cours de 30 pages reste de l'ordre de quelques dizaines de Ko de texte (non mesuré, à vérifier dans le lot A) ; les lectures `COURS#` restent des `Query` de moins de 40 éléments. Au-delà, `POST /scans` avec `coursId` répond `409 cours_plein` **avant** toute réservation de page.

**Sections** : `scansCreate` refuse (`409 cours_plein`) si `sectionsBefore ≥ 20`. Sinon `maxSectionsFor` est borné pour un ajout à `min(6, 2 × pages, 20 − sectionsBefore)` ; le dépassement donne le 400 « Trop de sections pour ce scan » ordinaire à la confirmation, sans écriture. Sans cette borne, `CoursItemSchema.parse` lèverait un 500 répété jusqu'à l'expiration (relecture B4.1).

**Bornes de fiche et de contrat** : grâce à D12, un ajout est un scan ordinaire. Ses fiches ont `sectionIndex` de 0 à 5 et `sectionCount` au plus 6, donc `FicheItemSchema` (`max(5)`, `max(6)`), `ScanSummary.sectionIndex` (max 5), `sectionCount` (max 6) et `docIds` (maxItems 6) **ne bougent pas**. Le rang `sectionIndex` d'une fiche d'ajout est local au job. Seules les bornes du **cours** (`pages`, `sections`) montent. Le contrat 1.6.0 n'a donc pas à les modifier.

### 3.7 Cours supprimé, expiré, d'un autre élève (P7)

- **Supprimé** : `POST /scans` avec `coursId` inconnu répond `404 introuvable` avant toute réservation. Si le cours est supprimé **pendant** l'ajout : voir 3.8.
- **« Expiré »** : un cours n'a pas de TTL, donc il n'expire pas ; seuls les jobs expirent (7 jours, ou 12 h sans confirmation). L'ajout a son propre job. Un ajout non confirmé au bout de 12 h expire comme un scan, le quota est rendu, le verrou libéré (3.8).
- **Autre élève, autre famille, frère ou sœur** : l'en-tête est lu avec la clé `STUDENT#<sid-de-l'appelant>` ; un `coursId` qui n'est pas à cet élève donne `404 introuvable`, sans différence de réponse avec un cours inexistant. Le `sid` ne vient jamais du corps de la requête.
- **Parent** : `requireStudent` refuse (403, rôle d'abord, existence ensuite), comme `cours-api`. Un parent ne peut pas ajouter de pages ni lire le texte (décision D10 bis).

### 3.8 Concurrence (P8)

Risques réels dans le code actuel :
1. Deux ajouts simultanés numéroteraient tous deux `N+1…` et écriraient les mêmes `COURS#<id>#T<nn>`.
2. Un ajout pendant que le scan d'origine est encore en `verification` ou `generation` : l'en-tête serait écrit par deux acteurs.
3. Une suppression du cours pendant l'ajout laisserait des fiches orphelines.
4. Un verrou repris trop tôt (job « absent » ou « final » dont la restauration n'est pas finie) laisserait un rejeu tardif détruire l'ajout suivant (relecture B3).

**Défaut : verrou sur l'en-tête, créé avec le job, libéré en dernier.**

- **Prérequis** : le job d'origine (`head.jobId`) est `termine` ou absent (expiré). Sinon `409 etat_invalide` « Ce cours est encore en cours de création ».
- **Création atomique** : `scansCreate` fait **une seule transaction** (`Db.transact`) : `put` du job avec `ifNotExists`, et `update` de l'en-tête avec condition « `appendJobId` absent » qui pose `appendJobId = <jobId>`. Dans la même transaction, le job reçoit `appendBase` (voir section 4), calculé à partir de l'en-tête lu juste avant ; la condition de la transaction porte aussi sur `pages` et `sections` lus (`pages = N`, nombre de sections = M), donc la base ne peut pas être périmée. Pas de fenêtre « verrou sans job » : un second `POST /scans` voit soit un verrou avec son job, soit rien.
- **Pas d'orphelin supposé** : un verrou n'est repris que si le job porteur est `termine`, **ou** s'il est final (`rejete`, `echec`, `expire`) **et** sa restauration est faite (marqueur `restoredAt` sur le job). Le job absent (TTL de 7 jours dépassé) ne se produit que sur un job final déjà restauré : on le traite comme orphelin et la reprise est conditionnelle sur l'ancienne valeur de `appendJobId`.
- **Réservation des pages après la transaction.** Si elle échoue (`quota_epuise`), la création lance la restauration du job (qui libère le verrou en dernier pas, section 6) et répond 429.
- **Libération en dernier pas.** Aucun chemin ne libère le verrou avant que la restauration de ce job soit finie. Chaque écriture de restauration est conditionnée à `appendJobId = <ce job>` : un rejeu tardif, après qu'un autre job a pris le verrou, ne fait rien.
- **`DELETE /cours/{id}`** applique la même règle : il pose une écriture conditionnelle sur l'en-tête (`appendJobId` absent, ou porteur final et restauré, auquel cas il reprend la restauration) avant de supprimer quoi que ce soit. Sinon un verrou resté posé après une libération ratée rendrait le cours **indélébile** (409 permanent). Pendant un ajout réellement ouvert : `409 etat_invalide` « Un ajout est en cours ».
- **Durée réelle du verrou** : de l'envoi (15 minutes) jusqu'à la fin du traitement, donc **jusqu'à 12 h** si l'élève ne confirme pas (`CONFIRM_TIMEOUT_S`), puis environ 100 s pour 3 pages (mesure T4). L'élève peut **annuler l'ajout depuis la liste** (`DELETE /scans/{id}` avant confirmation, ou `POST /jobs/{id}/cancel`) : `endWithoutDoc` puis la restauration libèrent le verrou. Un rejeu réseau de `POST /scans` reçoit un 409 sans le `jobId` du premier appel : l'élève retrouve cet ajout dans la liste.
- **Écritures de l'en-tête** : sous verrou, **un seul écrivain** (le job porteur). Les sections sont traitées une par une (`maxConcurrency: 1`). `setCoursStatus` garde donc son `get` puis l'écriture de `sections` entier (le port `Db.update` n'a pas de chemin imbriqué), mais cette écriture est **conditionnelle** sur `appendJobId = <ce job>`. Aucune extension du port : `ports.ts` n'est pas dans le lot A.
- **Édition de texte de R1** (« édition en place » du cours) : **refusée pendant un ajout ouvert**, avec la même règle que `DELETE` (409). À reporter dans R1-A (P15).
- Suppression d'**une fiche** du cours pendant un ajout : sans effet sur l'ajout (les `docId` du job sont distincts).

### 3.9 Rejeu idempotent (P9)

- **`POST /scans` rejoué** (réseau) : deux appels = deux tentatives ; la seconde échoue sur le verrou (`409`), sans réserver.
- **`appendBase`** est écrit **à la création** (3.8) : `{ pagesBefore: N, sectionsBefore: M, nbPhrasesBefore }`. L'en-tête est figé par le verrou, donc la base ne change plus. Elle n'est **jamais recalculée** à la confirmation.
- **`POST /jobs/{id}/confirm` rejoué** : la transition `a_confirmer → verification` reste l'arbitre. L'en-tête est recalculé **depuis `appendBase`** : `sections = ancien.slice(0, sectionsBefore) + nouvelles`, `pages = pagesBefore + k`. Rejouer ne duplique jamais une section, y compris après un plantage entre l'écriture du cours et la transition : le job a déjà sa base.
- **Ordre dans `jobsConfirm`** (C3) : (1) mise à jour conditionnelle de l'en-tête (`attribute_exists` **et** `appendJobId = <ce job>`) ; (2) écriture des textes `T<N+1…>` ; (3) transition du job. Sans `attribute_exists`, un `put` après un `DELETE /cours` recréerait un en-tête sans ses textes. En cas d'échec de la condition, `409 etat_invalide`, rien d'écrit.
- **Étapes de la machine** : inchangées et reprenables (`extract` efface la tentative précédente, `generate` saute une fiche existante, `quotaConsume` par marqueur, `finalize` conditionnel), **sauf `transcribe`** (3.2 bis).
- **`finalize` d'un ajout** : fixe `head.pages` et `head.nbPhrases` finaux et libère le verrou, par affectations conditionnelles (`appendJobId = <ce job>`). Il ne réécrit **pas** `sectionCount` des fiches d'origine (D12). Rejouable.
- **Restauration** : affectation depuis `appendBase`, rejouable, sûre à tout état (section 6).

#### 3.2 bis Reprise de `transcribe` avec l'offset de pages (B1)

Aujourd'hui `transcribe` s'arrête tôt si `TEXT#1` existe (`steps.ts:185`) et l'écrit en dernier (`steps.ts:221`). Avec l'offset, un ajout n'a plus de `TEXT#1`. Une relance relirait les photos (coût doublé) et rejouerait le compteur « 10 transcriptions par jour ». **Marqueur de reprise nommé** : l'attribut `textDone` du job (booléen, écrit **après** tous les `TEXT#`, avant le contrôle d'état final). `transcribe` teste `textDone` en premier, au lieu de `TEXT#1`, pour tous les jobs (un scan ordinaire reçoit aussi `textDone` ; un job déjà en cours au déploiement garde le test `TEXT#1` en repli). `steps.ts:185` et `:221` sont dans le lot A. Test de reprise : relancer `transcribe` d'un job `appendTo` avec textes déjà écrits ne rappelle pas le modèle et ne touche pas au compteur.

### 3.10 Fiches déjà jouées, historique des tests H1 (P10)

Rien ne change pour les fiches existantes : mêmes `docId`, mêmes questions, même historique, même `sectionIndex` et `sectionCount` (D12 : aucune réécriture des fiches frères). Les nouvelles fiches commencent sans passage et forment le groupe de leur propre scan.
- `TEST#.titre` est une copie du titre de la fiche ; l'ajout ne renomme aucune fiche.
- Supprimer les fiches de l'ajout supprime les passages `TEST#` de ces fiches seulement (`deleteDocTree`).
- Échec de l'ajout : aucune fiche existante n'est touchée. Une fiche **de l'ajout** déjà visible puis jouée peut être supprimée avec son historique si le job échoue ensuite ; c'est le comportement actuel de `failJob` pour un scan ordinaire (noté, non changé).

### 3.11 Isolation famille et élève (P11)

- Toutes les clés sont dans `STUDENT#<sid>` avec `sid` issu du jeton, jamais du corps. Le verrou, `appendBase` et `appendTo` sont lus et écrits sous ce `sid`.
- `appendTo` accepte un identifiant au format `ID_RE` ; format invalide : `400 requete_invalide`.
- Frère ou sœur : aucune route ne prend un `sid` côté élève ; un `coursId` d'un autre élève donne `404` (3.7).
- Parent : 403, et jamais de texte (`GET /cours` reste réservé à l'élève).
- L'export famille (`CoursMeta`) montre les sections ajoutées (sans texte) ; la liste de sections n'est plus tronquée à 6 mais à 20 (`coursMeta`).
- Les journaux ne reçoivent aucun contenu : `appendTo` est un identifiant, pas un texte. Le test « aucun contenu dans les journaux » existant s'applique aux nouvelles étapes.

### 3.12 Parent sans accès au texte (P12)

Inchangé et testé : le parent ne lit ni le texte du cours, ni le contexte de relecture, ni la transcription (routes réservées à l'élève). Il voit seulement, par `CoursMeta`, le nombre de pages et les sections (matière, sujet, titre, état), maintenant allongé. À ajouter au test d'acceptation : un parent qui appelle `POST /scans` avec `coursId` reçoit 403 sans réservation.

## 4. Modèle de données

Aucun nouvel élément. Ajouts d'attributs sur des éléments existants.

| Élément | Ajout | Écrivain |
|---|---|---|
| `JOB#` (clé `STUDENT#<sid> / JOB#<job>`) | `appendTo` (coursId), `appendBase = { pagesBefore, sectionsBefore, nbPhrasesBefore }` (**écrite à la création**, jamais recalculée), `coursId = appendTo`, `textDone`, `restoredAt` | `scansCreate` (transaction), `transcribe`, restauration |
| `COURS#<id>` (en-tête) | `appendJobId` (verrou, absent hors ajout) ; `jobIds` (ensemble des jobs qui ont construit le cours, alimenté par `addSet` dans la transaction de création, repli `[jobId]` pour un cours ancien) ; `pages`, `nbPhrases`, `sections` allongés | `scansCreate` (verrou, `jobIds`), `jobsConfirm`, `finalize`, restauration |
| `COURS#<id>#T<nn>` | nouvelles pages `N+1…N+k` | `jobsConfirm` |
| `DOC#` | `coursId`, `sectionIndex` et `sectionCount` **locaux au job de l'ajout** (comme un scan ordinaire, bornes inchangées) | `generate` |
| `JOB#…/TEXT#` | numéros de page globaux (offset appliqué) ; `continuesId` éventuel | `transcribe` |

Bornes à élargir dans `shared/items.ts` : `CoursItemSchema.pages` max 30, `.sections` max 20, `jobIds` ; `CoursTextItemSchema.page` max 30, `pages` des phrases max 30 ; le motif `T[0-9]{2}` suffit jusqu'à 99. `coursMeta` : `slice(0, 20)` et `pages` max 30. `shared/scans.ts` : `MAX_COURS_PAGES`, `MAX_COURS_SECTIONS` et `maxSectionsFor` borné pour un ajout (3.6). **Inchangées** : `FicheItemSchema.sectionIndex` (max 5) et `sectionCount` (max 6), `MAX_SECTIONS`, `MAX_PAGES_PER_SCAN`, `statusOfJob`, `listScans` (portent sur le **job**, pas sur le cours).

Un seul propriétaire de `docs/data-model.md` : le lot F10-A (mise à jour avec ses attributs).

## 5. Pipeline : points précis à changer

1. **`scansCreate`** : si `coursId` est présent : valider le format ; lire `COURS#` sous `sid` (404) ; refuser si `head.pages + pages > MAX_COURS_PAGES` ou `sectionsBefore ≥ MAX_COURS_SECTIONS` (409 `cours_plein`) ; vérifier le job d'origine terminé ; **une transaction** : job (avec `appendTo`, `appendBase`) + verrou et `jobIds` sur l'en-tête, conditionnée à l'état lu (3.8) ; **puis** réserver les pages (échec : restauration et 429).
2. **`transcribe`** : lit `appendTo`, charge les deux dernières phrases du cours, les passe au premier appel de lecture (texte seul), applique l'offset `N` aux pages lues avant `assemblePages`. Marqueur de reprise `textDone` (3.9, `steps.ts:185` et `:221` dans le lot A). Le garde-fou « 10 transcriptions par jour » et `MIN_WORDS` sont inchangés.
3. **`jobsTranscription`** : ajoute `context` (texte seul).
4. **`jobsConfirm`** : si `appendTo`, ordre de 3.9 (en-tête conditionnel, textes, transition) ; l'en-tête est calculé depuis `appendBase`. **Jamais** `deleteCoursTree` ; la course perdue appelle la restauration.
5. **`sectionOf` / `extract`** : `sec.rank` reste local au job, comme aujourd'hui (aucun décalage). Un paramètre **nouveau** de `extract` (même fichier, lot A) : les deux dernières phrases du cours, passées comme contexte à la première section du job seulement (le contexte de F11 vient du même texte de job ; ici il vient du cours).
6. **`setCoursStatus`** : garde son `get` puis l'écriture de `sections` entier, mais **conditionnelle** sur `appendJobId = <ce job>` (un seul écrivain sous verrou ; sections traitées une à une). Les indices modifiés sont `sectionsBefore + planIndex`.
7. **`finalize`** : branche `appendTo` (3.9) : `pages`, `nbPhrases`, libération du verrou.
8. **`endWithoutDoc`, `failJob`, `expire`, `jobsCancel`, `scansDelete`** : tous appellent la restauration quand `job.appendTo` est posé (`scansDelete` rejoue le nettoyage, donc rejoue la restauration), et elle seule libère le verrou. `purgeScan` et la course perdue de `jobsConfirm` n'appellent jamais `deleteCoursTree` pour un ajout.
9. **`DELETE /cours`** : écriture conditionnelle sur le verrou (3.8) ; retire `coursId` de **tous** les jobs de `head.jobIds` (repli `[head.jobId]`) ; supprime la copie `JOB#<job>/TEXT#` de chacun. Sinon `GET /scans` renverrait un lien mort (défaut B2 de T4).
10. **R1 (édition en place)** : refusée pendant un ajout ouvert (3.8).

La machine d'états (infra) ne change pas : son entrée est `{ jobId, sid }` et toutes les étapes lisent le job.

## 6. Échec, annulation et expiration : ne jamais supprimer l'ancien cours

C'est le risque principal du projet. Aujourd'hui, trois chemins suppriment « le cours du job » parce qu'il avait été créé par ce job :

- course perdue dans `jobsConfirm` (`deleteCoursTree(... jobId)`),
- `purgeScan` (appelé par `failJob` et `extract` quand aucune affirmation n'est exploitable),
- `DELETE /cours` (retire `coursId` du job).

Avec un ajout, `job.coursId` désigne le cours **existant** de l'élève. Les laisser inchangés supprimerait des semaines de travail sur une simple erreur d'extraction.

**Règle** : si `job.appendTo` est présent, ces chemins appellent `restoreAfterFailedAppend(ctx, sid, job)` et jamais `deleteCoursTree`. Elle est appelée par `endWithoutDoc` (donc par `expire`, `jobsCancel`, `scansDelete`, la course perdue), `failJob` et la création après un refus de quota.

`restoreAfterFailedAppend` est **idempotente et sûre à tout état** :
- **Condition d'ensemble** : chaque écriture exige `appendJobId = <ce job>` sur l'en-tête (ou l'absence de verrou quand le job est déjà restauré). Si un autre job détient le verrou, elle ne fait **rien**. Un rejeu tardif ne touche donc jamais l'ajout suivant.
- Avant la confirmation (le cours n'a rien reçu), les étapes 1 à 3 ne trouvent rien à faire et seule l'étape 6 agit.

Étapes, dans cet ordre :
1. supprimer les fiches du job (`deleteDocTree` pour chaque `docId` de `job.sections`) et les restes `DOC#<id>` (brouillons, comme `purgeScan`) ;
2. supprimer les textes `COURS#<id>#T<nn>` avec `nn > pagesBefore` ;
3. remettre `pages`, `nbPhrases` et `sections` de l'en-tête à `appendBase` (`sections.slice(0, sectionsBefore)`) ;
4. supprimer la copie de travail `JOB#<job>/TEXT#` (C2), comme le fait aujourd'hui `deleteCoursTree(..., { jobId })` ; supprimer aussi les figures du job (R1, préfixe de ce job) ;
5. poser `restoredAt` sur le job ;
6. **en dernier** : retirer `appendJobId` (condition : égal à ce job).

Sans `appendBase` (job qui n'a pas pu être créé), elle ne fait rien. Le quota est rendu par `endWithoutDoc` comme aujourd'hui. Il n'y a pas de réécriture de `sectionCount` à annuler (D12). Si l'ajout est annulé ou expire avant la confirmation, seules les étapes 4 à 6 ont un effet.

Tests obligatoires : après **chaque** chemin d'échec, le cours d'origine est identique (en-tête, textes, fiches) ; plantage entre l'écriture de l'en-tête et la transition de `jobsConfirm` ; restauration rejouée après qu'un second ajout a pris le verrou (aucun effet) ; `DELETE /cours` avec verrou porté par un job final non restauré (reprend la restauration, puis supprime).

Cas « aucune section avec fiche » (`MSG.noClaims`) : le job est rejeté, l'ajout est restauré, les pages sont rendues.

## 7. Confidentialité (commit séparé)

Rien n'est collecté de nouveau : mêmes photos (supprimées à la confirmation), même texte conservé jusqu'à suppression par l'élève ou avec le compte, aucun accès du parent. Ce qui change : le cours peut se construire en plusieurs envois et dépasser 10 pages, donc les textes doivent le dire. Nouveau traitement du texte conservé : **au premier ajout, les deux dernières phrases du cours sont renvoyées à Bedrock** pour lire la suite (même sous-traitant, même finalité, pas de nouveau destinataire). Une ligne dans le registre T3.

Le commit « docs(legal): F10 » (séparé du commit de conception, dans la PR de mise en œuvre du lot F10-D) :
- `docs/legal/registre.md` (T3) : préciser que le texte du cours s'enrichit à chaque ajout, jusqu'à 30 pages, avec la même conservation ;
- `docs/legal/politique-confidentialite.md` : une phrase « Tu peux ajouter des pages à un cours déjà scanné » et la mention que le texte ajouté suit la même règle ;
- `docs/legal/aipd-brouillon.md` : volume maximal par élève (30 pages par cours) ; `sous-traitants.md` : aucune nouveauté (AWS déjà sous-traitant).
- **`POLICY_VERSION` : décision du propriétaire (P13), tranchée.** F10 ne relève pas la version et ne modifie pas `shared/policy.ts`. La version suit la **hausse unique de R1** (PR #82), posée une seule fois pour les deux lots ; les familles consentent une fois. Raison : la substance ne change pas (aucune donnée nouvelle, aucune durée nouvelle, mêmes destinataires), mais R1 modifie les mêmes textes (`politique-confidentialite.md`, `registre.md`, `aipd-brouillon.md`).
  - **Ordre des deux PR sur les mêmes textes légaux** : R1-D d'abord, puis F10-D rebasée sur ses textes, avec un commit qui ne modifie que les lignes F10. Le commit légal de F10 le dit : « la version est relevée par R1 ».
  - Si F10 est mise en production **avant** la hausse de R1, le texte modifié part sans nouvelle version jusqu'à celle de R1 ; le propriétaire en est informé au moment de ce choix d'ordre de mise en production.

Contrôles : photo supprimée à la confirmation de l'ajout (`s3.deleteAll(scansPrefix)` du `jobsConfirm`, inchangé) ; l'ajout n'écrit aucune photo hors du préfixe du job ; aucun texte dans les journaux, ni dans les erreurs 4xx (messages constants).

## 8. Risques

| Risque | Parade |
|---|---|
| Perte du cours existant sur échec d'ajout | Section 6, test d'égalité du cours avant et après |
| Ancrage des affirmations sur de mauvais identifiants | Offset appliqué avant `assemblePages` ; les anciens identifiants ne sont jamais réécrits |
| Course sur l'en-tête (`setCoursStatus` en lecture puis écriture complète) | Un seul écrivain sous verrou, écriture conditionnelle sur `appendJobId` ; sections traitées une à une (`maxConcurrency: 1`) ; pas d'extension du port (3.8) |
| `sectionCount` des fiches d'origine | Jamais réécrit (D12) : un ajout est un scan, sa liste « 1 sur 2 » est propre |
| Verrou repris trop tôt, restauration tardive | Transaction job + verrou, libération en dernier pas, écritures conditionnées au verrou (3.8, 6) |
| Cours bloqué à 20 sections | Refus dès la création, bornes de `maxSectionsFor` (3.6) |
| Coût | Plafond par job, inchangé (`jobCapEur(pages ajoutées)`) ; 30 pages au plus par cours, donc au plus 4,50 € de plafond cumulé sur la vie d'un cours (0,15 € × 30), très au-dessus du réel (environ 0,09 €/page, p95 0,12 €, `docs/cost-guard.md`) ; la garde globale et le quota mensuel priment |
| Lecture d'une fin de phrase absente | Contexte textuel limité à deux phrases ; `continuesId` informatif (3.3) |
| Conflit avec R1 | F10 démarre après la fusion de R1-A (mêmes fichiers `steps-doc.ts`, `text.ts`, `jobs-confirm`, `items.ts`). Les blocs R1 (`Cours.blocks`) doivent aussi s'étendre : à confirmer dans R1 (P14) |

Interaction avec R1 : `Cours.blocks`, `figures` et `marks` s'ajoutent aux nouvelles pages comme à un scan ordinaire. Les blocs sont portés au niveau du document : un ajout **ajoute** des blocs en fin de liste, sans toucher aux précédents ; un paragraphe n'est jamais recollé à l'ancien (D4). Les figures de l'ajout vivent sous `figures/<sid>/<coursId>/…` et suivent la vie du cours ; la restauration (section 6) doit les supprimer aussi (préfixe de ce job, via la liste de `figureId` du job).

## 9. Contrat 1.6.0 (proposé, additif, à écrire après la fusion de la PR #82)

Rien de requis n'est ajouté à une requête existante ; un client 1.5 reste valide.

- **`ScanCreateRequest`** : `coursId` (string, 1 à 64, facultatif). Description : « Cours existant de l'élève auquel ajouter ces pages. Les pages sont numérotées à la suite et donnent de nouvelles sections et fiches. Inconnu ou d'un autre élève : 404. »
- **`POST /scans`** : nouvelles réponses :
  - `404 introuvable` (cours inconnu), `403 interdit` (parent), `409 etat_invalide` (« Ce cours est encore en cours de création » / « Un autre ajout est en cours pour ce cours »), `409 cours_plein` (nouveau code, dépassement de 30 pages ou cours déjà à 20 sections), `400 requete_invalide` (format).
- **`Error.code`** : ajout de `cours_plein` (comme `dossier_nom_pris` en 1.3 : un client ancien lit le statut HTTP).
- **`Transcription`** : `context` (tableau de `Sentence`, au plus 2, lecture seule, absent hors ajout) ; `Sentence.continuesId` (identifiant de la phrase du cours que celle-ci prolonge, absent sinon).
- **`Job`** : `coursId` (déjà exposé par `GET /scans` côté liste) ; `appendTo` n'est **pas** exposé.
- **`CoursMeta`** : `pages` maximum 30 (au lieu de 10), `sections` maximum 20 (au lieu de 6). `maxItems` des sections passe de 6 à 20.
- **Inchangés** (D12, un ajout = un scan) : `ScanSummary.sectionIndex` (max 5), `sectionCount` (max 6), `docIds` (maxItems 6). Le contrat 1.6.0 n'y touche pas ; le test de contrat le vérifie.
- **`DELETE /cours/{coursId}`** : `409 etat_invalide` pendant un ajout ouvert (verrou conditionnel, reprise d'une restauration inachevée).
- **`ConfirmRequest`** : inchangé. La règle « première section à la toute première phrase » s'entend sur les nouvelles phrases ; « au plus `min(6, 2 × pages)` » sur les pages ajoutées.
- Les exemples (`mock/`) : un ajout `201`, un `409 cours_plein`, un `409` verrou, une transcription avec `context`.

Version : `1.6.0` (R1 prend 1.5.0).

## 10. Lots et fichiers propres (un seul propriétaire par fichier)

Prérequis : fusion de R1-A (PR #82 et ses lots) pour les fichiers communs ; contrat 1.6.0 fusionné avant les lots A et C.

### Lot F10-0 : contrat (PR courte)

- `shared/contract/openapi.yaml`, `shared/contract/generated/**`, `shared/contract/contract.test.ts`, `mock/**` (exemples), `docs/acceptance/F10.md`

### Lot F10-A : API et pipeline

- `shared/scans.ts` (`MAX_COURS_PAGES`, `MAX_COURS_SECTIONS`, `maxSectionsFor` pour un ajout), `shared/items.ts` (bornes du cours, `jobIds`), `shared/ddb/keys.ts` (aucune clé nouvelle prévue), `shared/delete-tree.ts` (+ test : jobs multiples d'un cours)
- `api/src/pipeline/api.ts` (`scansCreate`, `jobsTranscription`, `jobsConfirm`, `jobsCancel`), `api/src/pipeline/append.ts` (**nouveau** : verrou, `appendBase`, `restoreAfterFailedAppend`, contexte), `api/src/pipeline/steps.ts` (`transcribe` dont le marqueur `textDone` aux lignes 185 et 221, `purgeScan`, `failJob`, `expire`), `api/src/pipeline/steps-doc.ts` (`setCoursStatus`, `generate`, `finalize`), `api/src/pipeline/text.ts` (offset de pages, `continuesId`), `api/src/pipeline/prompts.ts` (consigne de contexte), `api/src/pipeline/job.ts` (`endWithoutDoc` appelle la restauration), `api/src/scans/delete.ts` (rejoue la restauration), `api/src/cours/cours.ts`, `api/src/cours/meta.ts`
- Tests : `api/src/pipeline/append.test.ts` (nouveau, voir 11), compléments dans `entry.test.ts` seulement pour l'export des handlers, `docs/data-model.md` (seul propriétaire)
- **Hors lot** : `api/src/pipeline/ports.ts` (aucune extension : écriture de `sections` entier sous verrou), `shared/scans.ts` `listScans` pour le groupement (inchangé, D12), `Docs.tsx` (groupes par `scanId`, inchangé)

### Lot F10-B : infra

- `infra/lib/api-stack.ts` : droits de `scans-create` sur `COURS#` en lecture et mise à jour (verrou), et de `jobs-confirm` / `cours-api` selon les clés déjà autorisées. Aucune route nouvelle. À vérifier avant de conclure que le lot est vide : les rôles IAM actuels listent les actions DynamoDB par handler.
- `infra/test/*` : test de synthèse (aucun droit S3 ou Bedrock ajouté à `scans-create`).
- Estimation de coût avant déploiement : aucun composant nouveau, coût marginal limité aux appels de lecture et de génération déjà plafonnés.

### Lot F10-C : site

- `web/src/screens/Cours.tsx` (bouton, sections allongées), `web/src/screens/Scan.tsx` (mode « Ajouter au cours »), `web/src/screens/confirm/ConfirmView.tsx` et `confirm/sections.ts` (contexte grisé, `continuesId`), `web/src/screens/confirm/storage.ts` (clé de brouillon par job), `web/src/api.ts`, `web/src/types.ts`, `web/src/labels.ts` (messages 409), `web/src/**/*.css`
- Tests unitaires associés

### Lot F10-D : textes légaux (après validation)

- `docs/legal/registre.md`, `politique-confidentialite.md`, `aipd-brouillon.md`, à rebaser sur R1-D (ordre en section 7). `shared/policy.ts` n'est pas modifié par F10 (la hausse unique est celle de R1, P13).

### Lot F10-E : e2e

- `e2e/tests/append.spec.ts` (nouveau), `e2e/mock-api/**` (propriétaire : lot F10-0 pour le mock, F10-E pour les scénarios)

### Ordre

1. Cette PR de conception, validation P1 à P15.
2. Fusion de R1-A, puis lot F10-0.
3. Lots F10-A et F10-C en parallèle contre le mock ; F10-B si nécessaire ; F10-D après validation ; F10-E en dernier.

## 11. Tests

**API (`append.test.ts`, sans réseau, ports factices comme `pipeline.test.ts`)** :
- ajout nominal : pages `N+1…`, sections du cours allongées, fiches de l'ajout avec `sectionIndex`/`sectionCount` locaux, fiches d'origine **inchangées**, quota consommé une fois pour les pages ajoutées ;
- cours à 20 sections : refus à la création sans réservation ; cours à 18 sections et ajout de 3 sections : 400 ordinaire à la confirmation ;
- reprise de `transcribe` avec `appendTo` : pas de second appel de modèle, compteur du jour inchangé ;
- création : verrou et job dans une transaction (un second `POST /scans` concurrent reçoit 409, jamais deux jobs) ; refus de quota : verrou libéré en dernier ;
- plantage entre l'écriture de l'en-tête et la transition de `jobsConfirm` : cours d'origine restauré à l'expiration ;
- restauration rejouée après qu'un second ajout a pris le verrou : aucun effet ; `DELETE /cours` avec verrou d'un job final non restauré : reprend la restauration ;
- édition R1 refusée pendant un ajout ;
- cours inconnu 404 ; cours d'un autre élève 404 ; parent 403 ; format invalide 400 ; `cours_plein` 409 sans réservation ;
- scan d'origine non terminé : 409, rien réservé ; verrou pris : 409 ; verrou orphelin (job final) repris ;
- **égalité avant/après** du cours d'origine après : échec d'extraction, `noClaims`, course perdue, annulation, expiration, panne de `generate` ;
- rejeu : confirmation rejouée, `finalize` rejoué, restauration rejouée, sans doublon de section ;
- plafond : `jobCapEur(pages ajoutées)` et non du cours entier ; `budgetLeftCents` inchangé ;
- offset : identifiants globaux, `assemblePages` sans recollage avec l'ancien texte, `continuesId` posé seulement si `suite` et pages consécutives ;
- `DELETE /cours` : 409 pendant un ajout, retire `coursId` de tous les jobs du cours ;
- confidentialité : aucun texte dans les journaux ni les erreurs ; photo supprimée à la confirmation ; parent sans `GET /cours` ;
- fiches existantes : `docId`, QCM et `TEST#` inchangés.

**Contrat** : exemples valides, schémas `coursId`, `context`, `continuesId`, `cours_plein`.

**e2e (Playwright, mock puis dev réel)** :
1. cours de 2 pages, ajout d'1 page, relecture avec contexte grisé, deux sections, retour à « Mes cours » avec 5 sections ;
2. ajout refusé à 30 pages (message) ;
3. ajout pendant un autre ajout (second onglet) : message clair, pas de double réservation ;
4. échec simulé (mock `echec`) : le cours d'origine reste lisible, quota rendu ;
5. suppression du cours pendant un ajout : message ;
6. parent : pas de bouton, pas de texte ;
7. mobile et PC (captures relues avant rapport).

Un test réel sur dev (1 à 2 pages, coût attendu inférieur à 0,10 €) avant fusion du lot A, à lancer sur accord du propriétaire pour la dépense.

## 12. Décisions à valider (P1 à P15)

| # | Question | Défaut proposé | Alternative |
|---|---|---|---|
| P1 | Les nouvelles pages refont-elles la fiche et le QCM ? | **Non**, nouvelles sections et fiches ajoutées, anciennes inchangées | « Compléter une fiche » (versions, coût double, historique à traiter) : lot ultérieur |
| P2 | Place des pages | **À la fin** | Insertion au milieu : clé d'ordre séparée, touche chaque lecteur du texte |
| P3 | Phrase à cheval avec la dernière page | **Pas de recollage**, contexte lecture seule + `continuesId` | Recoller et réécrire la dernière phrase (invalide ses affirmations) |
| P4 | Relecture | **Nouvelles pages seulement**, contexte grisé | Relire tout le cours (coût et confusion) |
| P5 | Quota et plafond | **Par page ajoutée**, `max(0,25 ; 0,15 × pages ajoutées)` | Plafond sur le cours entier (pénalise les gros cours) |
| P6 | Limites du cours | **30 pages, 20 sections** ; ajout borné à `20 − sectionsBefore`, refus dès la création à 20 | 20 pages / 12 sections (plus prudent) ou 50 / 30 |
| P7 | Cours supprimé, d'un autre élève, parent | 404 / 404 / 403, avant toute réservation | — |
| P8 | Concurrence | **Verrou par cours** créé avec le job (transaction), libéré en dernier pas, scan d'origine terminé requis, `DELETE /cours` refusé pendant l'ajout ; verrou jusqu'à 12 h, annulable depuis la liste | Annuler l'ajout en cours à la suppression (plus de cas dans la machine) |
| P9 | Rejeu | Affectations depuis `appendBase`, jamais d'incréments | — |
| P10 | Fiches déjà jouées et liste | Inchangées, historique intact ; **un ajout = un scan**, `sectionCount` des fiches d'origine non réécrit | Regrouper par cours (`listScans`, contrat, `Docs.tsx`) : plus gros, plus tard |
| P11 | Isolation | `sid` du jeton, 404 uniforme | — |
| P12 | Parent | Aucun texte, aucun ajout (403) | — |
| P13 | `POLICY_VERSION` | **Tranché par le propriétaire** : pas de hausse propre à F10, hausse unique avec R1 (PR #82) | — |
| P14 | Échec d'ajout | **Restaurer** le cours d'origine (jamais le supprimer), depuis une base écrite à la création ; blocs, figures et marques de R1 suivent | — |
| P15 | Édition en place de R1 pendant un ajout | **Refusée** (409), même règle que `DELETE /cours` | La laisser, avec un verrou séparé |

Question ouverte hors défaut : faut-il, à terme, proposer « Ajouter à une fiche existante » (P1) et « Insérer avant la page N » (P2) ? Le défaut les laisse hors périmètre ; rien dans cette conception ne les empêche (identifiants et `docId` stables).
