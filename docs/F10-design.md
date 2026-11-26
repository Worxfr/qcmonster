# F10 : ajouter des pages à un cours existant

Demande du propriétaire : l'élève doit pouvoir ajouter des pages à un cours déjà scanné. Le cours reste complet, les nouvelles pages donnent des sections et des fiches par sujet, et le pipeline lit les nouvelles pages comme un seul document.

Cette PR ne contient que de la conception. Elle ne touche ni `shared/contract/openapi.yaml` ni `shared/contract/generated/` : la PR #82 (R1, contrat 1.5.0) en est seule propriétaire tant qu'elle n'est pas fusionnée. Les changements de contrat proposés sont décrits en section 9 (contrat 1.6.0, à écrire après la fusion de R1). Aucun appel Claude ni AWS n'a été fait pour l'écrire.

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
| D7 | Limites du cours | 30 pages et 20 sections par cours au total (nouvelles constantes). |
| D8 | Concurrence | **Un seul ajout ouvert par cours** (verrou conditionnel sur l'en-tête du cours, libéré à tout état final). Pas d'ajout tant que le scan d'origine n'est pas terminé. |
| D9 | Échec | **Tout ou rien pour l'ajout seulement** : le cours d'origine est restauré tel quel (texte, sections, fiches). Aujourd'hui `failJob` supprime tout le cours ; pour un ajout ce serait une perte de données (section 6). |
| D10 | Historique de tests (H1) | Inchangé : les `docId` existants ne bougent pas, donc aucun passage `TEST#` n'est touché. |
| D11 | Confidentialité | Aucune donnée nouvelle ni durée nouvelle. Mise à jour des textes du registre et de la politique dans un commit séparé, **sans relever `POLICY_VERSION`**. |

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
- **Liste** (`GET /scans`) : groupe les jobs et fiches par `coursId`.
- **Historique H1** : un `TEST#` par passage, relié à une fiche par `docId`, supprimé avec la fiche.

## 2. Parcours de l'élève

1. Dans **Cours** (écran d'un cours), bouton « Ajouter des pages ».
2. L'écran d'envoi existant s'ouvre avec le titre « Ajouter au cours : … ». Même sélection de photos (10 au plus par ajout), même envoi.
3. Lecture des nouvelles pages seulement. Relecture : les deux dernières phrases du cours apparaissent grisées en haut, puis les nouvelles pages, avec les mêmes outils (corrections, coupes en sections, matière, sujet, dossier).
4. Confirmation : le cours s'allonge (texte et sections), les nouvelles fiches sont créées, les anciennes ne bougent pas.
5. « Mes cours » montre le cours avec toutes ses sections, dans l'ordre. Un ajout apparaît dans la liste des scans comme un scan, rattaché au même cours.

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

### 3.6 Limites d'un cours (P6)

Aujourd'hui un cours a au plus 10 pages et 6 sections (schémas `CoursItemSchema`, `CoursTextItemSchema`, `coursMeta` qui tronque à 6). Un ajout dépasse ces bornes. **Défaut : 30 pages et 20 sections par cours.** Constantes `MAX_COURS_PAGES = 30` et `MAX_COURS_SECTIONS = 20` dans `shared/scans.ts`. `MAX_PAGES_PER_SCAN = 10` et `MAX_SECTIONS = 6` (par ajout) ne changent pas.

Pourquoi 30 : trois scans de 10 pages ; un cours de 30 pages reste de l'ordre de quelques dizaines de Ko de texte (non mesuré, à vérifier dans le lot A) ; les lectures `COURS#` restent des `Query` de moins de 40 éléments. Au-delà, `POST /scans` avec `coursId` répond `409 cours_plein` **avant** toute réservation de page.

### 3.7 Cours supprimé, expiré, d'un autre élève (P7)

- **Supprimé** : `POST /scans` avec `coursId` inconnu répond `404 introuvable` avant toute réservation. Si le cours est supprimé **pendant** l'ajout : voir 3.8.
- **« Expiré »** : un cours n'a pas de TTL, donc il n'expire pas ; seuls les jobs expirent (7 jours, ou 12 h sans confirmation). L'ajout a son propre job. Un ajout non confirmé au bout de 12 h expire comme un scan, le quota est rendu, le verrou libéré (3.8).
- **Autre élève, autre famille, frère ou sœur** : l'en-tête est lu avec la clé `STUDENT#<sid-de-l'appelant>` ; un `coursId` qui n'est pas à cet élève donne `404 introuvable`, sans différence de réponse avec un cours inexistant. Le `sid` ne vient jamais du corps de la requête.
- **Parent** : `requireStudent` refuse (403, rôle d'abord, existence ensuite), comme `cours-api`. Un parent ne peut pas ajouter de pages ni lire le texte (décision D10 bis).

### 3.8 Concurrence (P8)

Risques réels dans le code actuel :
1. Deux ajouts simultanés numéroteraient tous deux `N+1…` et écriraient les mêmes `COURS#<id>#T<nn>`.
2. Un ajout pendant que le scan d'origine est encore en `verification` ou `generation` modifierait l'en-tête que `setCoursStatus` réécrit en entier (`put({...head, sections})` : dernier écrivain gagnant, une section perdue).
3. Une suppression du cours pendant l'ajout laisserait des fiches orphelines.

**Défaut : verrou court sur l'en-tête.**
- `POST /scans` avec `coursId` exige que le job d'origine (`head.jobId`) soit **terminé** (`termine`, ou absent car expiré). Sinon `409 etat_invalide` « Ce cours est encore en cours de création ».
- Le verrou est `head.appendJobId`, posé par une mise à jour **conditionnelle** (`attribute_not_exists(appendJobId)`). Un second ajout reçoit `409 etat_invalide` « Un autre ajout est en cours pour ce cours ».
- Verrou **jamais orphelin** : si `appendJobId` existe, on lit ce job ; s'il est final (`termine`, `rejete`, `echec`, `expire`) ou absent, la création reprend le verrou (condition sur l'ancienne valeur). Le verrou est aussi libéré par chaque sortie de job (`finalize`, `endWithoutDoc`, `failJob`, `expire`, annulation), de façon conditionnelle (`appendJobId = <ce job>`) donc rejouable.
- Le verrou est posé **avant** la réservation des pages ; s'il échoue, rien n'est réservé. Si la réservation échoue après le verrou, le verrou est libéré (même schéma que le `catch` de `scansCreate`).
- `DELETE /cours/{id}` pendant un ajout ouvert : `409 etat_invalide` « Un ajout est en cours ». Il se termine en quelques minutes (environ 100 s pour 3 pages mesurées en T4) ou expire. L'élève peut aussi annuler l'ajout avant confirmation. Choix par défaut parce qu'il évite des fiches orphelines sans nouveau cas dans la machine (P8).
- Suppression d'**une fiche** du cours pendant un ajout : sans effet sur l'ajout (les `docId` du job sont distincts).
- Écritures de l'en-tête pendant un ajout : la machine ne réécrit plus l'en-tête entier (`setCoursStatus` remplace `put({...head})`) mais fait un `update` conditionnel de `sections[<index>]`. Les index de l'ajout sont au-delà de `sectionsBefore`, donc les écrits ne se croisent jamais.

### 3.9 Rejeu idempotent (P9)

- **`POST /scans` rejoué** (réseau) : comme aujourd'hui, deux appels = deux jobs. Le second échoue sur le verrou (`409`), sans réserver. C'est un gain par rapport à un scan ordinaire.
- **`POST /jobs/{id}/confirm` rejoué** : la transition `a_confirmer → verification` reste le seul arbitre (le deuxième appel reçoit `409 etat_invalide`). Écritures du cours : l'en-tête est recalculé à partir de la base figée dans le job (`appendBase = { pagesBefore, sectionsBefore, nbPhrasesBefore }`) et non de l'en-tête courant : `sections = ancien.slice(0, sectionsBefore) + nouvelles`. Rejouer ne duplique donc jamais une section. Les `TEXT#`/`COURS#…#T<nn>` sont écrits par clés déterministes (`N+1…`).
- **Étapes de la machine** : inchangées et déjà reprenables (`extract` efface la tentative précédente, `generate` saute une fiche existante, `quotaConsume` par marqueur, `finalize` conditionnel).
- **`finalize` d'un ajout** : (a) met `sectionCount` à jour sur les fiches frères (mise à jour conditionnelle `attribute_exists`, valeur absolue, donc rejouable), (b) fixe `head.pages` et `head.nbPhrases` finaux, (c) libère le verrou. Chaque écriture est une affectation, jamais un incrément.
- **Rejeu de `failJob`** : la restauration (section 6) est une affectation à partir de `appendBase`, rejouable sans effet.

### 3.10 Fiches déjà jouées, historique des tests H1 (P10)

Rien ne change pour les fiches existantes : mêmes `docId`, mêmes questions, même historique. Les nouvelles fiches commencent sans passage. Points d'attention :
- `sectionCount` d'une fiche existante change quand des sections s'ajoutent (« 2 sur 3 » devient « 2 sur 5 »). Ce n'est que de l'affichage et l'historique H1 ne le lit pas.
- `TEST#.titre` est une copie du titre de la fiche ; l'ajout ne renomme aucune fiche.
- Supprimer l'ajout (suppression de ses fiches) supprime les passages `TEST#` de ces fiches seulement, comme `deleteDocTree` le fait déjà.
- L'« échec de l'ajout » ne touche aucune fiche existante donc aucun `TEST#` (section 6).

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
| `JOB#` (clé `STUDENT#<sid> / JOB#<job>`) | `appendTo` (coursId), `appendBase = { pagesBefore, sectionsBefore, nbPhrasesBefore, kept }` (figée à la confirmation), `coursId = appendTo` | `scansCreate`, `jobsConfirm` |
| `COURS#<id>` (en-tête) | `appendJobId` (verrou, absent hors ajout) ; `pages`, `nbPhrases`, `sections` allongés | `scansCreate` (verrou), `jobsConfirm`, `finalize`, restauration |
| `COURS#<id>#T<nn>` | nouvelles pages `N+1…N+k` | `jobsConfirm` |
| `DOC#` | `sectionIndex` continue (rang parmi toutes les sections avec fiche du cours), `sectionCount` mis à jour sur les frères, `coursId` | `generate`, `finalize` |
| `JOB#…/TEXT#` | numéros de page globaux (offset appliqué) ; `continuesId` éventuel | `transcribe` |

Bornes à élargir dans `shared/items.ts` : `CoursItemSchema.pages` max 30, `.sections` max 20 ; `CoursTextItemSchema.page` max 30, `pages` des phrases max 30 ; le motif `T[0-9]{2}` suffit jusqu'à 99. `coursMeta` : `slice(0, 20)` et `pages` max 30. `shared/scans.ts` : `MAX_COURS_PAGES`, `MAX_COURS_SECTIONS`. Le calcul `statusOfJob` et `listScans` bornent aujourd'hui les pages à 10 (`MAX_PAGES_PER_SCAN`) : inchangé, car il porte sur les pages du **job**, pas du cours.

`data-model.md` est mis à jour par le propriétaire du fichier (voir lots).

## 5. Pipeline : points précis à changer

1. **`scansCreate`** : si `coursId` est présent : valider le format ; lire `COURS#` sous `sid` (404) ; refuser si `head.pages + pages > MAX_COURS_PAGES` (409 `cours_plein`) ; vérifier le job d'origine terminé ; poser le verrou ; **puis** réserver les pages. Le job reçoit `appendTo`.
2. **`transcribe`** : lit `appendTo`, charge les deux dernières phrases du cours (`COURS#…#T` le plus haut), les passe au premier appel de lecture (texte seul), applique l'offset `N` aux pages lues avant `assemblePages`. Le garde-fou « 10 transcriptions par jour » et le seuil `MIN_WORDS` sont inchangés.
3. **`jobsTranscription`** : ajoute `context` (texte seul). Les photos restent celles du job.
4. **`jobsConfirm`** : si `appendTo`, écrit **seulement** les nouvelles pages et un en-tête recalculé à partir de `appendBase`, sous condition `appendJobId = <ce job>`. Pas de `put` de l'en-tête complet sans cette condition. Ne jamais appeler `deleteCoursTree` sur la course perdue (voir 6).
5. **`sectionOf` / `extract`** : `sec.rank` reste local au job ; `generate` écrit `sectionIndex = appendBase.kept + rank` et `sectionCount = appendBase.kept + kept.length`. Le contexte des deux phrases n'est passé qu'à la première section du job.
6. **`setCoursStatus`** : passe à une mise à jour d'un seul élément de `sections` (indice `sectionsBefore + planIndex`), au lieu d'un `put` de l'en-tête.
7. **`finalize`** : branche `appendTo` (3.9).
8. **`endWithoutDoc`, `failJob`, `expire`, `jobsCancel`** : libèrent le verrou ; `purgeScan` et la course perdue de `jobsConfirm` utilisent la restauration (section 6) et non `deleteCoursTree`.
9. **`DELETE /cours`** : refuse pendant un ajout ouvert ; retire `coursId` de **tous** les jobs du cours (celui d'origine et ceux des ajouts) : l'en-tête garde la liste `jobIds` des jobs qui l'ont construit (au plus 30, un envoi d'une page au minimum). Sinon `GET /scans` renverrait un lien mort, comme le défaut B2 de T4.

La machine d'états (infra) ne change pas : son entrée est `{ jobId, sid }` et toutes les étapes lisent le job.

## 6. Échec, annulation et expiration : ne jamais supprimer l'ancien cours

C'est le risque principal du projet. Aujourd'hui, trois chemins supprimaient « le cours du job » parce qu'il avait été créé par ce job :

- course perdue dans `jobsConfirm` (`deleteCoursTree(... jobId)`),
- `purgeScan` (appelé par `failJob` et `extract` quand aucune affirmation n'est exploitable),
- `DELETE /cours` (retire `coursId` du job).

Avec un ajout, `job.coursId` désigne le cours **existant** de l'élève. Les laisser inchangés supprimerait des semaines de travail sur une simple erreur d'extraction.

**Règle** : si `job.appendTo` est présent, ces chemins appellent `restoreAfterFailedAppend(ctx, sid, job)` et jamais `deleteCoursTree`.

`restoreAfterFailedAppend` (idempotent, par affectations) :
1. supprime les fiches du job (`deleteDocTree` pour chaque `docId` de `job.sections`, plus les brouillons `DOC#<id>`, comme `purgeScan`) ;
2. supprime les textes `COURS#<id>#T<nn>` pour `nn > pagesBefore` ;
3. remet `pages`, `nbPhrases` et `sections` de l'en-tête à `appendBase` (`sections.slice(0, sectionsBefore)`), et retire `appendJobId` si c'est ce job ;
4. remet `sectionCount` des fiches frères à `appendBase.kept` si une mise à jour les avait déjà modifiées.

Le quota est rendu par `endWithoutDoc` comme aujourd'hui. Si l'ajout est annulé ou expire **avant** la confirmation, rien n'a été écrit dans le cours : seul le verrou est libéré. Test obligatoire : après chaque chemin d'échec, le cours d'origine est identique octet pour octet (en-tête, textes, fiches).

Cas « aucune section avec fiche » (`MSG.noClaims`) : le job est rejeté, l'ajout est restauré, les pages sont rendues.

## 7. Confidentialité (commit séparé)

Rien n'est collecté de nouveau : mêmes photos (supprimées à la confirmation), même texte conservé jusqu'à suppression par l'élève ou avec le compte, aucun accès du parent. Ce qui change : le cours peut se construire en plusieurs envois et dépasser 10 pages, donc les textes doivent le dire.

Le commit « docs(legal): F10 » (séparé du commit de conception, dans la PR de mise en œuvre du lot F10-D) :
- `docs/legal/registre.md` (T3) : préciser que le texte du cours s'enrichit à chaque ajout, jusqu'à 30 pages, avec la même conservation ;
- `docs/legal/politique-confidentialite.md` : une phrase « Tu peux ajouter des pages à un cours déjà scanné » et la mention que le texte ajouté suit la même règle ;
- `docs/legal/aipd-brouillon.md` : volume maximal par élève (30 pages par cours) ; `sous-traitants.md` : aucune nouveauté (AWS déjà sous-traitant).
- **`shared/policy.ts` n'est pas modifié : `POLICY_VERSION` reste `2026-11-26`.** La durée et la nature des données conservées ne changent pas ; le relèvement (et un nouveau consentement des familles) reste une décision du propriétaire à la mise en production (P13).

Contrôles : photo supprimée à la confirmation de l'ajout (`s3.deleteAll(scansPrefix)` du `jobsConfirm`, inchangé) ; l'ajout n'écrit aucune photo hors du préfixe du job ; aucun texte dans les journaux, ni dans les erreurs 4xx (messages constants).

## 8. Risques

| Risque | Parade |
|---|---|
| Perte du cours existant sur échec d'ajout | Section 6, test d'égalité du cours avant et après |
| Ancrage des affirmations sur de mauvais identifiants | Offset appliqué avant `assemblePages` ; les anciens identifiants ne sont jamais réécrits |
| Course sur l'en-tête (`setCoursStatus` en `put` complet) | Mise à jour d'un élément, verrou (3.8) |
| `sectionCount` périmé sur les anciennes fiches | Mis à jour dans `finalize`, valeur absolue, rejouable |
| Coût | Plafond par job, inchangé (`jobCapEur(pages ajoutées)`) ; 30 pages au plus par cours, donc au plus 4,50 € de plafond cumulé sur la vie d'un cours (0,15 € × 30), très au-dessus du réel (0,05 €/page mesuré en T4) |
| Lecture d'une fin de phrase absente | Contexte textuel limité à deux phrases ; `continuesId` informatif (3.3) |
| Conflit avec R1 | F10 démarre après la fusion de R1-A (mêmes fichiers `steps-doc.ts`, `text.ts`, `jobs-confirm`, `items.ts`). Les blocs R1 (`Cours.blocks`) doivent aussi s'étendre : à confirmer dans R1 (P14) |

Interaction avec R1 : `Cours.blocks`, `figures` et `marks` s'ajoutent aux nouvelles pages comme à un scan ordinaire. Les blocs sont portés au niveau du document : un ajout **ajoute** des blocs en fin de liste, sans toucher aux précédents ; un paragraphe n'est jamais recollé à l'ancien (D4). Les figures de l'ajout vivent sous `figures/<sid>/<coursId>/…` et suivent la vie du cours ; la restauration (section 6) doit les supprimer aussi (préfixe de ce job, via la liste de `figureId` du job).

## 9. Contrat 1.6.0 (proposé, additif, à écrire après la fusion de la PR #82)

Rien de requis n'est ajouté à une requête existante ; un client 1.5 reste valide.

- **`ScanCreateRequest`** : `coursId` (string, 1 à 64, facultatif). Description : « Cours existant de l'élève auquel ajouter ces pages. Les pages sont numérotées à la suite et donnent de nouvelles sections et fiches. Inconnu ou d'un autre élève : 404. »
- **`POST /scans`** : nouvelles réponses :
  - `404 introuvable` (cours inconnu), `403 interdit` (parent), `409 etat_invalide` (« Ce cours est encore en cours de création » / « Un autre ajout est en cours pour ce cours »), `409 cours_plein` (nouveau code, dépassement de 30 pages), `400 requete_invalide` (format).
- **`Error.code`** : ajout de `cours_plein` (comme `dossier_nom_pris` en 1.3 : un client ancien lit le statut HTTP).
- **`Transcription`** : `context` (tableau de `Sentence`, au plus 2, lecture seule, absent hors ajout) ; `Sentence.continuesId` (identifiant de la phrase du cours que celle-ci prolonge, absent sinon).
- **`Job`** : `coursId` (déjà exposé par `GET /scans` côté liste) ; `appendTo` n'est **pas** exposé.
- **`CoursMeta`** : `pages` maximum 30 (au lieu de 10), `sections` maximum 20 (au lieu de 6). `maxItems` des sections passe de 6 à 20.
- **`DELETE /cours/{coursId}`** : `409 etat_invalide` pendant un ajout ouvert.
- **`ConfirmRequest`** : inchangé. La règle « première section à la toute première phrase » s'entend sur les nouvelles phrases ; « au plus `min(6, 2 × pages)` » sur les pages ajoutées.
- Les exemples (`mock/`) : un ajout `201`, un `409 cours_plein`, un `409` verrou, une transcription avec `context`.

Version : `1.6.0` (R1 prend 1.5.0).

## 10. Lots et fichiers propres (un seul propriétaire par fichier)

Prérequis : fusion de R1-A (PR #82 et ses lots) pour les fichiers communs ; contrat 1.6.0 fusionné avant les lots A et C.

### Lot F10-0 : contrat (PR courte)

- `shared/contract/openapi.yaml`, `shared/contract/generated/**`, `shared/contract/contract.test.ts`, `mock/**` (exemples), `docs/acceptance/F10.md`

### Lot F10-A : API et pipeline

- `shared/scans.ts` (`MAX_COURS_PAGES`, `MAX_COURS_SECTIONS`), `shared/items.ts` (bornes), `shared/ddb/keys.ts` (aucune clé nouvelle prévue), `shared/delete-tree.ts` (+ test : jobs multiples d'un cours)
- `api/src/pipeline/api.ts` (`scansCreate`, `jobsTranscription`, `jobsConfirm`, `jobsCancel`), `api/src/pipeline/append.ts` (**nouveau** : verrou, `appendBase`, `restoreAfterFailedAppend`, contexte), `api/src/pipeline/steps.ts` (`transcribe`, `purgeScan`, `failJob`, `expire`), `api/src/pipeline/steps-doc.ts` (`setCoursStatus`, `generate`, `finalize`), `api/src/pipeline/text.ts` (offset de pages, `continuesId`), `api/src/pipeline/prompts.ts` (consigne de contexte), `api/src/pipeline/job.ts` (`endWithoutDoc` libère le verrou), `api/src/cours/cours.ts`, `api/src/cours/meta.ts`
- Tests : `api/src/pipeline/append.test.ts` (nouveau, voir 11), compléments dans `entry.test.ts` seulement pour l'export des handlers, `docs/data-model.md`

### Lot F10-B : infra

- `infra/lib/api-stack.ts` : droits de `scans-create` sur `COURS#` en lecture et mise à jour (verrou), et de `jobs-confirm` / `cours-api` selon les clés déjà autorisées. Aucune route nouvelle. À vérifier avant de conclure que le lot est vide : les rôles IAM actuels listent les actions DynamoDB par handler.
- `infra/test/*` : test de synthèse (aucun droit S3 ou Bedrock ajouté à `scans-create`).
- Estimation de coût avant déploiement : aucun composant nouveau, coût marginal limité aux appels de lecture et de génération déjà plafonnés.

### Lot F10-C : site

- `web/src/screens/Cours.tsx` (bouton, sections allongées), `web/src/screens/Scan.tsx` (mode « Ajouter au cours »), `web/src/screens/confirm/ConfirmView.tsx` et `confirm/sections.ts` (contexte grisé, `continuesId`), `web/src/screens/confirm/storage.ts` (clé de brouillon par job), `web/src/api.ts`, `web/src/types.ts`, `web/src/labels.ts` (messages 409), `web/src/**/*.css`
- Tests unitaires associés

### Lot F10-D : textes légaux (après validation)

- `docs/legal/registre.md`, `politique-confidentialite.md`, `aipd-brouillon.md`. `shared/policy.ts` seulement sur décision du propriétaire (P13).

### Lot F10-E : e2e

- `e2e/tests/append.spec.ts` (nouveau), `e2e/mock-api/**` (propriétaire : lot F10-0 pour le mock, F10-E pour les scénarios)

### Ordre

1. Cette PR de conception, validation P1 à P14.
2. Fusion de R1-A, puis lot F10-0.
3. Lots F10-A et F10-C en parallèle contre le mock ; F10-B si nécessaire ; F10-D après validation ; F10-E en dernier.

## 11. Tests

**API (`append.test.ts`, sans réseau, ports factices comme `pipeline.test.ts`)** :
- ajout nominal : pages `N+1…`, sections et fiches allongées, `sectionIndex` continu, `sectionCount` mis à jour sur les frères, quota consommé une fois pour les pages ajoutées ;
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

## 12. Décisions à valider (P1 à P14)

| # | Question | Défaut proposé | Alternative |
|---|---|---|---|
| P1 | Les nouvelles pages refont-elles la fiche et le QCM ? | **Non**, nouvelles sections et fiches ajoutées, anciennes inchangées | « Compléter une fiche » (versions, coût double, historique à traiter) : lot ultérieur |
| P2 | Place des pages | **À la fin** | Insertion au milieu : clé d'ordre séparée, touche chaque lecteur du texte |
| P3 | Phrase à cheval avec la dernière page | **Pas de recollage**, contexte lecture seule + `continuesId` | Recoller et réécrire la dernière phrase (invalide ses affirmations) |
| P4 | Relecture | **Nouvelles pages seulement**, contexte grisé | Relire tout le cours (coût et confusion) |
| P5 | Quota et plafond | **Par page ajoutée**, `max(0,25 ; 0,15 × pages ajoutées)` | Plafond sur le cours entier (pénalise les gros cours) |
| P6 | Limites du cours | **30 pages, 20 sections** | 20 pages / 12 sections (plus prudent) ou 50 / 30 |
| P7 | Cours supprimé, d'un autre élève, parent | 404 / 404 / 403, avant toute réservation | — |
| P8 | Concurrence | **Verrou par cours**, scan d'origine terminé requis, `DELETE /cours` refusé pendant l'ajout | Annuler l'ajout en cours à la suppression (plus de cas dans la machine) |
| P9 | Rejeu | Affectations depuis `appendBase`, jamais d'incréments | — |
| P10 | Fiches déjà jouées | Inchangées, historique intact ; `sectionCount` des frères mis à jour | Ne pas mettre à jour (affichage « 2 sur 3 » périmé) |
| P11 | Isolation | `sid` du jeton, 404 uniforme | — |
| P12 | Parent | Aucun texte, aucun ajout (403) | — |
| P13 | Confidentialité | Textes en commit séparé, **`POLICY_VERSION` inchangée** | Relever la version et redemander le consentement |
| P14 | Échec d'ajout | **Restaurer** le cours d'origine (jamais le supprimer) ; blocs, figures et marques de R1 suivent | — |

Question ouverte hors défaut : faut-il, à terme, proposer « Ajouter à une fiche existante » (P1) et « Insérer avant la page N » (P2) ? Le défaut les laisse hors périmètre ; rien dans cette conception ne les empêche (identifiants et `docId` stables).
