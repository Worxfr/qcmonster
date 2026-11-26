# M1 : ajouter une phrase oubliée à la relecture (#89) et modifier un cours après confirmation (#90)

Statut : **conception**, aucune ligne de code applicatif, aucune modification de `shared/contract/openapi.yaml` ni de `shared/contract/generated/` : le contrat proposé est décrit en section 8 (version 1.9.0, à écrire par le lot M1-K). Aucun appel Claude ni AWS, aucun `cdk synth` n'a été lancé pour écrire ce document. **Aucun chiffre de coût, de durée ou de taille ci-dessous n'a été mesuré** : ce sont des estimations tirées des mesures déjà citées par R1, F10, Q1 et E1 (section 13).

Base lue : `main` à `c27b59b` (contrat 1.8.0, `POLICY_VERSION` `2026-11-27`), en particulier `api/src/pipeline/{api,append,blocks,steps-doc,text}.ts`, `shared/{items,scans,delete-tree}.ts`, `shared/ddb/keys.ts`, `infra/lib/pipeline-stack.ts`, et les conceptions `docs/R1-design.md`, `docs/F10-design.md`, `docs/Q1-design.md`, `docs/E1-design.md`, `docs/H1-design.md`.

## 0. Résumé des décisions proposées

| # | Sujet | Décision par défaut |
|---|---|---|
| D1 | Découpage | Deux fonctions livrées **séparément** : #89 (avant confirmation, petit) puis #90 (après confirmation, plus gros). Le lot #89 ne dépend pas de #90. |
| D2 | #89, où | L'élève ajoute une phrase **après une phrase donnée** (ou tout au début du texte). Elle entre dans le même paragraphe ou la même liste, ou dans un nouveau paragraphe. |
| D3 | #89, identifiant | Le client envoie une **clé temporaire** (`n1`, `n2`…). Le serveur attribue l'identifiant définitif `p<page>-s<n>` avec `n` = plus grand numéro de la page + 1. Aucune phrase existante n'est renumérotée. |
| D4 | #89, vérification | **Aucun traitement de faveur** : la phrase ajoutée suit l'extraction et la vérification des sources comme une phrase lue. Une phrase que les sources ne confirment pas reste « non vérifiable » et ne sert à aucune question. |
| D5 | #90, sens de « modifier » | Corriger, retirer ou ajouter des **phrases** d'un cours confirmé. Pas de déplacement, pas de nouveau découpage en sections, pas de changement de photo ni de figure. |
| D6 | #90, mécanisme | Une **révision** est un job d'un genre nouveau (`kind: 'revision'`). Rien n'est écrit dans le cours ni dans la fiche avant la fin : tout le travail se fait dans une **copie de travail** (partition `DOC#<revisionId>`), puis une étape de validation (`revCommit`) l'applique. Échec = on jette la copie, le cours n'a jamais bougé. |
| D7 | #90, fiches | La fiche **garde son identifiant**. Les affirmations touchées sont **retirées** (jamais modifiées ni supprimées), de nouvelles sont extraites et vérifiées. Les questions liées à une affirmation retirée sont **retirées du tirage mais conservées** ; de nouvelles questions les remplacent. Le texte de la fiche (paragraphes, rappel) est réécrit. |
| D8 | #90, historique et points | L'historique des tests ne bouge pas (il ne garde que des identifiants de questions). Les points déjà gagnés restent. Le plafond de **50 points par fiche** (Q1) et celui de 20 points des exercices (E1) restent ceux de la fiche : modifier un cours ne remet aucun compteur à zéro. |
| D9 | #90, concurrence | Le verrou de F10 (`appendJobId` sur l'en-tête du cours) sert aussi aux révisions : **une seule opération à la fois par cours** (ajout de pages, révision, suppression). Le code de reprise de verrou de F10 doit apprendre à distinguer une révision (section 5). |
| D10 | Coût | #89 : environ +0,003 € par phrase ajoutée, dans le plafond de job existant. #90 : plafond propre **0,10 € par révision**, 20 phrases au plus, 3 fiches au plus, 3 révisions par cours et par jour, 5 par élève et par jour. Pas de quota de pages (aucune photo). Tout est estimé, rien mesuré. |
| D11 | IAM | #89 : **aucun droit nouveau** (le code écrit les mêmes éléments que `jobs-confirm` aujourd'hui). #90 : deux rôles nouveaux sans Bedrock (`revise-start`, `revise`), la génération de la fiche tourne dans `pipeline-role` existant. Un **test statique** compare les accès réellement faits par le code aux droits de chaque rôle (section 7.3). |
| D12 | Légal | Aucun nouveau sous-traitant, aucune durée nouvelle sauf la copie de travail (7 jours au plus). Textes dans un **commit séparé** `docs(legal)`, à valider par le propriétaire. `POLICY_VERSION` **non relevé** (hausse commune, section 9). |

## 1. Ce qui existe (lu dans `main` à `c27b59b`)

- **Relecture** (`GET /jobs/{id}/transcription`, `ConfirmView.tsx`) : l'élève corrige (`corrections`) ou retire (`removed`) une phrase. Il ne peut pas en ajouter (R1 §12.1, P5). Les identifiants de phrase (`p<page>-s<n>`) ne sont jamais renumérotés ; les trous sont permis (retraits).
- **Blocs** (R1) : `Cours.blocks` regroupe les phrases dans l'ordre du document (titre, paragraphe, liste, formule, figure). Chaque phrase est dans **exactement un** bloc. L'ordre d'une page est l'ordre du tableau `sentences`, pas l'ordre des numéros.
- **Cours confirmé** : en-tête `STUDENT#<sid> / COURS#<coursId>` (`pages`, `sections`, `jobIds`, verrou `appendJobId`), textes `COURS#<id>#T<nn>`, blocs `COURS#<id>#B`. Les phrases sont **corrigées au moment de la confirmation** ; après, **rien ne les modifie** (R1 §4, §12.1).
- **Fiche** : en-tête `STUDENT#<sid> / DOC#<docId>` (titre, `resume`, `body`, `recall`, `nbQuestions`, `coursId`, `sectionIndex`). Contenu dans la partition `DOC#<docId>` : `CLAIM#<nn>` (affirmation, `origine.phraseId`, **jamais modifiée**), `VERDICT#<nn>` (écrit par la vérification seule), `QCM#<nn>` et `GAP#<nn>` (porteurs de `claimId` et d'un `questionId` = `<docId>:qcm|gap:<nn>`, deux chiffres). `QuestionIdSchema` impose **deux chiffres** : **99 emplacements par type et par fiche, jamais réutilisés**.
- **Extraction** (`extract` dans `steps-doc.ts`) : au début, `clearDoc(CLAIM#, VERDICT#, QCM#, GAP#)` efface « les restes d'une tentative précédente » dans la partition de la fiche (ligne 265). C'est le point dangereux de #90 : réutilisée telle quelle sur une fiche vivante, cette ligne détruirait la fiche (section 3.3).
- **Historique des tests** (H1) : `STUDENT#<sid> / TEST#…` ne garde **que des identifiants de questions** et des résultats. Une question disparue s'affiche « question retirée » (H1 §9). Le parent ne voit jamais de texte (`TestParentDetail`).
- **Points** (Q1) : une récompense par question pour toujours (`ATT#<questionId>#<jour>`), **50 points au plus par fiche pour toute sa vie**, 250 par jour. Exercices (E1) : 20 points au plus par fiche, `EXO#` porte `claimIds[]`.
- **Ajout de pages** (F10, code présent dans `api/src/pipeline/append.ts`) : verrou `appendJobId` posé avec le job dans une transaction, libéré **en dernier** par `restoreAfterFailedAppend`. `reclaimLock` reprend un verrou dont le job est `termine`, ou final et restauré, ou absent. Il appelle `restoreAfterFailedAppend`, qui **ne fait rien** sur un job sans `appendBase` puis le verrou est libéré (voir section 5.2, c'est un défaut à corriger avant #90).
- **IAM** : un rôle par profil d'accès (`pipeline-stack.ts`, `game-stack.ts`, `verify-stack.ts`) ; chaque action DynamoDB est limitée par `dynamodb:LeadingKeys` (partition). IAM ne filtre pas la clé de tri : l'isolation entre types d'éléments d'une même partition est faite par le code. Seuls `pipeline-role` et `verify-role` appellent Bedrock (test `infra/test/m2-bedrock.test.ts`).
- Les tickets #89 et #90 n'ont aucun commentaire ; leur corps est la source de la demande (liste de pistes de chaque ticket reprise en section 12).

## 2. #89 : ajouter une phrase oubliée à la relecture

### 2.1 Parcours

1. À l'écran de relecture, entre deux phrases, un bouton discret « Ajouter une phrase ici » (et un au tout début du texte).
2. Un champ de texte s'ouvre, avec l'aperçu LaTeX déjà utilisé pour les corrections. L'élève écrit, valide. La phrase apparaît **dans le paragraphe**, marquée « Ajoutée par toi ».
3. L'élève peut modifier le texte d'une phrase ajoutée ou la supprimer **avant d'envoyer** (c'est du texte local, comme une correction non envoyée, sauvegardé dans `sessionStorage` par `storage.ts`).
4. À la confirmation, les phrases ajoutées partent avec la requête. Elles peuvent être le début d'une section (`fromSentenceId`).

### 2.2 Où : l'ancre, et son effet sur les blocs

- Une phrase ajoutée porte une **ancre** `afterId` : l'identifiant de la phrase **après laquelle** elle vient, ou `null` pour « tout au début du texte ». L'ancre est une phrase du job (pas le contexte grisé de F10) ou une autre phrase ajoutée plus tôt dans la même requête (ajouts en chaîne).
- **Page** : la phrase prend la page de son ancre (`null` : la première page du job). Elle est insérée juste après l'ancre dans le tableau `sentences` de cette page. Limite acceptée (`shortcut: la page d'une phrase ajoutée est celle de son ancre; si la phrase oubliée était en haut de la page suivante, elle porte la page précédente, sans effet sur le texte; à revoir si l'on affiche la photo en face de chaque phrase`).
- **Bloc** (règle de code, aucune décision du modèle) :
  - ancre dans un `paragraphe` ou une `liste` : la phrase entre dans ce bloc, juste après l'ancre (élément de liste supplémentaire pour une liste) ;
  - `nouveauBloc: true` (choix de l'élève) : un nouveau `paragraphe` est créé **après le bloc de l'ancre** ; on ne coupe jamais un paragraphe en deux en v1 ;
  - ancre dans un `titre`, une `formule` ou une `figure` : un nouveau `paragraphe` après ce bloc ;
  - ancre `null` : un nouveau `paragraphe` avant le premier bloc ;
  - job sans couche de blocs (repli R1 §2.5) : la phrase est seulement insérée dans la liste de phrases.
- **Formule seule** : pas de bloc `formule` créé par un ajout en v1 (point à trancher P3). L'élève écrit la formule dans une phrase avec `$…$`.

### 2.3 Comment : identifiants, ordre, sections

- **Clé temporaire** : le client numérote ses ajouts `n1`, `n2`… (motif `^n[0-9]{1,2}$`, 20 au plus). Elle sert dans `afterId` d'un autre ajout et dans `sections[].fromSentenceId`. Raison : une seule requête reste cohérente (corrections, retraits, coupes et ajouts) sans aller-retour, et le client n'a pas à deviner le prochain numéro.
- **Attribution** (côté serveur, dans l'ordre du tableau `added`) : `id = p<page>-s<n>` avec `n` = (plus grand numéro de phrase de cette page dans le texte du job, **retraits compris**) + 1. Aucun identifiant existant ne change, un identifiant retiré n'est jamais repris. Les numéros d'une page peuvent donc ne pas suivre l'ordre du texte : c'est déjà vrai après un recollage, et l'ordre vient du tableau.
- **Ordre de traitement dans `jobsConfirm`** : validation complète d'abord (rien n'est écrit si une règle échoue), puis `removed`, `corrections`, `added`, puis sections et seuil de 40 mots. Les ajouts comptent dans les 40 mots.
- **Coupes en sections** : une phrase ajoutée peut être `fromSentenceId` (clé temporaire acceptée, remplacée par l'identifiant définitif avant `planSections`). Une ancre peut être une phrase **retirée dans la même requête** : l'ajout garde alors la place que la phrase retirée occupait (règle de code, un test).
- **Recollage de phrases sur deux pages** (`suite`) : le recollage a lieu à la lecture, avant la relecture ; une phrase ajoutée n'est jamais recollée. L'ancre peut être la phrase recollée (elle porte `pages: [1, 2]`) : la phrase ajoutée prend alors **la dernière** de ses pages.
- **F10 (ajout de pages)** : les numéros de page sont déjà décalés dans le job ; une ancre ne peut pas viser le contexte grisé. « Au début » veut dire au début des nouvelles pages.
- **Limites** : 20 phrases ajoutées par confirmation, 2 000 caractères chacune (limite existante), 6 000 caractères au total, aucune phrase vide ou de moins de 3 caractères utiles, `sanitizeLatex` appliqué (une formule invalide est refusée avec le message déjà employé pour les corrections : 400 `requete_invalide`, rien n'est modifié).
- **Donnée conservée** : la phrase ajoutée est écrite dans `COURS#<id>#T<nn>` avec `added: true` (facultatif). Ce drapeau sert à l'affichage (« Ajoutée par toi ») et, dans #90, à la règle de la section 3.2. Il n'est pas envoyé à Bedrock.

### 2.4 Vérification des sources

- Après la confirmation, la phrase ajoutée passe **exactement** par le chemin d'une phrase lue : `extract` (une affirmation par fait), `verify-run` (recherche dans les sources autorisées, verdict `verifiee`, `erreur` ou `non_verifiable`), génération des questions à partir des seules affirmations **vérifiées** (règle Q1).
- Conséquences voulues :
  1. Une phrase que l'élève invente ou mal recopie est marquée `erreur` si une source la contredit ; sinon `non_verifiable` (affichée « non vérifié », jamais source d'une question, jamais reprise dans le rappel sans la mention, règle D9 de R1).
  2. Une phrase ajoutée **ne peut pas devenir une question sans source** : on ne peut pas « fabriquer » des questions en tapant du texte.
  3. Aucune confiance automatique parce que l'élève a tapé le texte lui-même.
- Le texte ajouté est une entrée d'élève : il suit les mêmes protections contre l'injection de consignes que les corrections (texte délimité dans le prompt, jamais interprété comme consigne, `sanitizeLatex`, aucun contenu dans les journaux ni dans les messages d'erreur). Le plafond de 6 000 caractères borne aussi le surcoût de jetons.
- Cas limite : une phrase ajoutée très proche d'une phrase existante produit deux affirmations presque identiques. La fusion de doublons par empreinte existante (`fingerprint.ts`) s'applique.

### 2.5 Ce qui ne change pas

La photo, les figures (une ancre sur une figure donne un paragraphe après), le quota (pages), le plafond de coût du job (`jobCapEur`), les rôles IAM, la machine d'états, le parent (qui ne voit pas le texte), l'export.

## 3. #90 : modifier un cours après confirmation

### 3.1 Ce que veut dire « modifier » (périmètre)

**Permis** (mêmes opérations que la relecture, mêmes règles de validation, même code partagé `applyChanges` dans `api/src/pipeline/changes.ts`, section 11) :

| Opération | Effet |
|---|---|
| Corriger le texte d'une phrase | Le texte change, l'identifiant et la place restent. |
| Retirer une phrase | Elle disparaît du cours (comme `removed`). Un bloc sans phrase disparaît. |
| Ajouter une phrase | Même règles que la section 2 (ancre, clé temporaire). |

**Refusé en v1** (400 avec un message constant) : retirer la **première phrase d'une section** (elle porte la coupe `fromSentenceId`), retirer **toutes** les phrases d'une section, descendre le cours sous 40 mots au total, modifier une phrase d'un cours dont une fiche est encore en génération ou `echec`, plus de 20 phrases touchées par révision, plus de 3 fiches touchées par révision. **Hors périmètre** : déplacer ou fusionner des phrases, recouper des sections, remplacer une photo ou une figure, modifier la description d'une figure (`alt`), ajouter des pages (c'est F10). Les figures ne bougent pas : elles restent attachées à leurs blocs.

**Sections ignorées** (`status: ignoree`, sans fiche) : le texte se modifie **sans modèle ni verrou long** : écriture directe, conditionnée à la version de l'élément (compteur `v`), même plafonds de longueur.

### 3.2 Ce que deviennent les objets liés (tableau de référence)

Notation : « touchée » = l'affirmation a pour `origine.phraseId` une phrase corrigée ou retirée.

| Objet | Après une révision | Raison |
|---|---|---|
| **Texte du cours** (`COURS#T`, `COURS#B`) | Réécrit à la fin seulement (étape `revCommit`), phrases à identifiants stables. Les blocs sont recalculés par `applyChanges`. | Rien de visible avant que la fiche soit prête : pas de cours « nouveau » avec une fiche « ancienne ». |
| **Fiche** (`STUDENT#…/DOC#<docId>`) | **Même `docId`**. `resume`, `body`, `recall`, `nbQuestions` réécrits à partir des affirmations valides (anciennes non touchées + nouvelles). | Garder le `docId` garde l'historique, les points, le dossier, le plafond de 50 points (sinon modifier un cours remettrait les compteurs à zéro). |
| **Affirmations** (`CLAIM#`) | Les touchées sont **retirées** : leur numéro est ajouté à `claimsRetired` sur l'en-tête de la fiche. L'élément reste, intact (règle « jamais modifié »). Les nouvelles reçoivent des numéros **plus grands que tout numéro déjà pris**. | Pas de réécriture d'un élément déclaré immuable ; un rejeu ne peut pas corrompre l'ancien. |
| **Verdicts** (`VERDICT#`) | Inchangés pour les anciennes. Nouveaux verdicts pour les nouvelles affirmations, par la même vérification. | La vérification est refaite **seulement** pour ce qui a changé (coût borné). |
| **Questions** (`QCM#`, `GAP#`) | Celles dont le `claimId` est retiré reçoivent `retiree: true` et **sortent du tirage**. Elles ne sont ni supprimées ni modifiées dans leur contenu. De nouvelles questions (numéros jamais utilisés) sont générées pour les nouvelles affirmations vérifiées, au plus autant que de questions retirées, banque de 40 par type au plus. | `ATT#` et `TEST#` pointent vers des `questionId` : supprimer une question casserait l'historique lisible. |
| **Historique des tests** (`TEST#`) | **Inchangé.** Le détail élève (`TestDetail`) montre une question retirée avec l'étiquette « retirée après une correction du cours » (champ `retired`, section 8). Le parent n'a jamais de texte. | Respecte H1 et l'effacement fiche par fiche (`deleteDocTree`). |
| **Points déjà gagnés** (`ATT#…xp`, `PROFILE`) | **Gardés.** Les lignes `ATT#` des questions retirées comptent toujours dans les 50 points de la fiche. Les nouvelles questions paient dans ce qui reste du plafond. | Aucun gain par modification : sans cela, corriger une phrase serait un moyen de regagner 50 points. |
| **Exercices** (E1, `EXO#`, `EXOP#`, `COPIE#`) | Un exercice dont `claimIds[]` contient une affirmation retirée reçoit `retiree: true` et n'est plus proposé. Ses copies et ses points restent. Aucun exercice n'est régénéré automatiquement. Si E1 n'est pas encore livré, M1-B n'a rien à faire et E1-B reprend la règle. | Le raisonnement corrigé reposait sur un fait désormais retiré. |
| **Signalements** (`REPORT#`) | Non touchés. | Ils appartiennent au parent et à la relecture humaine (L3). |
| **Marques** (`Cours.marks`) | Calculées à la lecture à partir des affirmations **non retirées**. Pendant une révision, les phrases concernées n'ont pas de marque. | R1 §4 : les marques ne sont pas stockées. |
| **Figures** (S3 `figures/…`, `COURS#B`) | Inchangées. Une phrase modifiée dans un bloc qui touche une figure ne déplace ni ne supprime la figure. | Une seule durée de vie pour une figure : celle du cours (R1 D4). |
| **Photo** | Aucune : elle a été supprimée à la confirmation. | La révision ne lit que du texte. |
| **Parent** | Aucun accès au texte, aucune route nouvelle. `CoursMeta` ne change pas. | Règle confirmée par R1, F10 et H1. |

**Garde-fou de capacité** : un numéro de question n'est jamais réutilisé et tient sur deux chiffres. Si `claimMax`, `qcmMax` ou `gapMax` + besoin dépasse 99, la révision est refusée en 409 `fiche_trop_revisee` avec le message « Cette fiche a été trop retouchée : supprime-la et rescanne ». `claimsRetired` est aussi limité à 200 numéros.

### 3.3 Mécanisme : une révision est un job, sur une copie de travail

Principe : **ne jamais exécuter les étapes existantes sur la fiche vivante.** `extract` commence par effacer les affirmations de la partition qu'on lui donne ; il ne faut donc lui donner qu'une partition jetable.

1. **Création** (`POST /cours/{coursId}/revisions`, fonction `revise-create`, élève seulement) :
   - lit l'en-tête du cours (404 si absent ou d'un autre élève, sans différence de réponse), vérifie que le job d'origine et les fiches concernées sont `termine`, applique les limites (3.1) et les plafonds (section 6) ;
   - vérifie les règles de validation de `applyChanges` **sans rien écrire** (400 `requete_invalide`, rien n'est modifié) ;
   - calcule les fiches touchées (sections qui contiennent une phrase concernée) et, par fiche, les affirmations touchées (lecture de `CLAIM#` : `origine.phraseId` dans l'ensemble modifié) ;
   - écrit **dans une seule transaction** : le job `STUDENT#<sid> / JOB#<revisionId>` (`kind: 'revision'`, `coursId`, `base`, voir section 4) et le verrou sur l'en-tête (`appendJobId = <revisionId>`, condition « verrou absent » et `pages`, nombre de sections lus). Pas de fenêtre « verrou sans job » ;
   - écrit la copie de travail du texte (`JOB#<revisionId> / TEXT#…` : seulement les phrases modifiées ou ajoutées, avec une phrase de contexte avant et après), avec `ttl` 7 jours ;
   - lance la machine `revise`, répond **202** `{ revisionId, etat: 'en_cours' }`.
2. **Machine `revise`** (nouvelle machine, mêmes conventions que la machine de scan, section 7.2), par fiche touchée, **une à la fois** (`maxConcurrency: 1`) :
   1. `revPrepare` : fixe le plan : une « section » par fiche touchée, dont le `docId` est le **docId de travail** `<revisionId>-<k>` (partition `DOC#<revisionId>-<k>`, **sans en-tête de fiche** donc invisible dans « Mes fiches »), texte = phrases modifiées avec contexte (le contexte est celui de F11 : « déjà traité, aucune affirmation n'en est gardée »).
   2. `extract` (existant) et `verify-run` (existant, rôle de vérification existant) : ils écrivent `CLAIM#` et `VERDICT#` **dans la partition de travail**. Aucune ligne de ces étapes ne change, parce qu'elles reçoivent un `docId` de travail. `clearDoc` ne peut donc toucher que la copie.
   3. `revGenerate` (nouveau, dans le rôle de traitement existant `pipeline-role`) : un appel de génération par fiche à partir de l'ensemble « affirmations valides de la fiche vivante (non retirées, verdict non `erreur`) + nouvelles affirmations vérifiées » : nouveaux `body` et `recall` (le code copie le texte du rappel depuis les affirmations, règle D9 de R1), nouvelles questions (QCM et trous, mêmes contrôles `solvePrompt` et `sanitizeLatex` que `generate`), écrites **dans la partition de travail** (`QCM#`, `GAP#`) et le texte de la fiche dans le job. Une erreur de modèle sur le second tour de questions n'empêche pas la fiche (règle de Q1 : on garde le premier tour).
   4. `revCommit` (nouveau, rôle `revise`) : voir 3.4.
   5. Chemin d'erreur : `Catch` sur chaque étape vers `revFail` (3.5).
3. **Suivi** : `GET /cours/{coursId}/revisions/{revisionId}` renvoie l'état (`en_cours`, `terminee`, `echec`), l'étape et, par fiche, son état. `GET /cours/{coursId}` renvoie `revision` tant qu'une révision est ouverte (un autre appareil de l'élève voit la bannière).

### 3.4 Validation (`revCommit`), ordre et reprise

Étape sans appel de modèle, donc **reprise automatique permise** (`retry = true`), idempotente. Numéros réservés à la création : `base = { claimMax, qcmMax, gapMax }` par fiche, **figés par le verrou** (un seul écrivain), jamais recalculés. Les numéros définitifs sont `base + rang` : un rejeu écrit les mêmes éléments aux mêmes clés.

Ordre (chaque écriture est répétable sans effet de plus) :
1. copier les nouvelles affirmations, verdicts et questions de la partition de travail vers `DOC#<docId>` (numéros `base + rang` ; `claimId` des questions et `questionId` réécrits en conséquence ; écriture avec `attribute_not_exists` : un élément déjà écrit n'est jamais remplacé par un autre) ;
2. marquer `retiree: true` sur les questions liées aux affirmations retirées (et les exercices si E1) ;
3. écrire sur l'en-tête de la fiche `claimsRetired` (union), `resume`, `body`, `recall`, `nbQuestions`, `rev` (compteur de révisions) ;
4. écrire le texte du cours (`COURS#T`) et les blocs (`COURS#B`) : chaque élément est remplacé par une écriture **conditionnelle à la version `v` lue à la création** (si elle a changé, c'est un bogue : la révision échoue sans rien perdre, le verrou interdisait toute autre écriture) ;
5. supprimer la partition de travail et la copie de texte du job, poser `restoredAt` ;
6. **en dernier** : libérer le verrou (condition : `appendJobId = <revisionId>`), passer le job à `termine`.

**Fenêtre visible** : entre les étapes 1 et 4, qui durent de l'ordre de la seconde (non mesuré), un élève qui ouvre une fiche peut voir les nouvelles questions avant le nouveau texte du cours. Acceptée : aucune donnée n'est perdue, l'état se corrige à l'étape 4. Le commit ne retire aucune question avant que les remplaçantes existent (l'étape 1 précède l'étape 2).

### 3.5 Échec, annulation, expiration

- **Tout ou rien, sans restauration** : avant `revCommit`, **rien de visible n'a été écrit** (ni cours, ni fiche, ni question). L'échec (`revFail`, ou expiration du job à 12 h) supprime la partition de travail et la copie de texte, pose `restoredAt` et libère le verrou **en dernier**. Contrairement à F10, il n'y a pas de base à restaurer.
- **Échec pendant `revCommit`** : les étapes 1 à 3 sont additives et répétables ; l'étape 4 est conditionnelle. La reprise automatique finit le travail. Si elle échoue définitivement, `revFail` n'efface **pas** la partition de travail avant d'avoir vérifié si l'étape 4 a eu lieu (lecture de `rev` sur la fiche) : si le texte est déjà écrit, la révision est finie, sinon elle est annulée proprement (les nouvelles lignes `CLAIM#`… sans effet restent, inertes, jusqu'à la suppression de la fiche).
- **Annulation par l'élève** : `POST /cours/{coursId}/revisions/{revisionId}/cancel` seulement avant `revCommit` ; sinon 409 `etat_invalide`.
- **Suppression du cours ou d'une fiche pendant la révision** : refusée en 409 (« Une modification est en cours »), comme pour un ajout de pages (F10 §3.8).
- **Quota** : rien à rendre (aucune page réservée) ; les compteurs du jour (section 6) ne sont **pas** rendus sur échec côté serveur (le coût a été engagé), sauf échec avant tout appel de modèle.

## 4. Modèle de donnée

Aucune table, aucun index, aucun bucket nouveau.

| Élément | Clé | Ajout | Écrit par |
|---|---|---|---|
| Job de révision | `STUDENT#<sid> / JOB#<revisionId>` | `kind: 'revision'`, `coursId`, `base[]` (par fiche : `docId`, `claimMax`, `qcmMax`, `gapMax`, `textVersions`), `changes` (compteurs seulement), `docIds` (fiches de travail), `restoredAt`, `ttl` 7 jours | `revise-create`, étapes de la machine |
| Copie de texte de travail | `JOB#<revisionId> / TEXT#<page>`, `CHANGES` | phrases modifiées avec contexte ; la requête (`corrections`, `removed`, `added`) | `revise-create` ; `ttl` 7 jours |
| Partition de travail | `DOC#<revisionId>-<k> / CLAIM#, VERDICT#, QCM#, GAP#` | même forme qu'une fiche, **sans en-tête** ; `ttl` 7 jours de sécurité | `extract`, vérification, `revGenerate` ; supprimée par `revCommit` ou `revFail` |
| En-tête du cours | `STUDENT#<sid> / COURS#<id>` | **aucun attribut nouveau** : le verrou `appendJobId` est réutilisé (valeur = `revisionId`) | `revise-create`, `revCommit`, `revFail` |
| Fiche (en-tête) | `STUDENT#<sid> / DOC#<docId>` | `claimsRetired` (200 numéros au plus), `rev` (entier) | `revCommit` seul |
| `QCM#`, `GAP#` | `DOC#<docId>` | `retiree` (booléen) | `revCommit` seul (écriture) ; lu par le tirage, `answers-post`, `docs-read` |
| `EXO#` (si E1 livré) | `DOC#<docId>` | `retiree` | `revCommit` seul |
| Compteurs du jour | `STUDENT#<sid> / REVJ#<jour>` | `n` (révisions de l'élève), `parCours` (petite table `coursId` vers nombre), `ttl` 2 jours | `revise-create` |
| Texte du cours | `COURS#<id>#T<nn>` | `sentences[].added` (facultatif) | `jobsConfirm` (#89), `revCommit` (#90) |

`shared/items.ts` : `FicheItemSchema` gagne `claimsRetired` et `rev` (facultatifs) ; `QcmItemSchema` et `GapItemSchema` gagnent `retiree` ; le schéma de sentence du cours gagne `added`. Un seul propriétaire de `docs/data-model.md` : M1-K.

**Lecteurs à adapter** (liste exhaustive à vérifier par `grep` par le lot, section 11) : le tirage et `GET /docs/{id}/session` (ignorer `retiree`), `answers-post` (une question `retiree` d'une session déjà ouverte est **corrigée normalement, sans point**, et la réponse porte `retired: true`), `docs-read` (ignorer les affirmations de `claimsRetired`), `Cours.marks`, `exo-gen` (ne pas partir d'une affirmation retirée), `DocSummary.questionCount` (compteur `nbQuestions` = questions non retirées).

## 5. Verrou et concurrence avec l'ajout de pages (F10)

### 5.1 Règle

**Un seul verrou par cours** : l'attribut `appendJobId` de l'en-tête (F10 §3.8). Sa valeur est l'identifiant du job porteur : un job de scan en ajout **ou** une révision. Il couvre aussi la suppression (`DELETING`). Conséquences, sans changer les conditions déjà écrites dans `scans-create`, `cours-delete` et `jobsConfirm` (elles testent « verrou absent » ou « égal à ce job ») :

| Opération en cours | Ajout de pages | Révision | Suppression du cours | Suppression d'une fiche du cours | Relecture d'un autre scan (sans `appendTo`) |
|---|---|---|---|---|---|
| Ajout de pages | 409 | 409 | 409 | sans effet sur l'ajout (F10) | autorisée |
| Révision | 409 | 409 | 409 | **409** si la fiche est touchée, sinon autorisée | autorisée |
| Suppression | 409 | 409 | rejeu | rejeu | autorisée |

- **Création atomique** : une seule transaction (job + verrou), comme F10. Aucune réservation de pages pour une révision, donc aucun « rendu » de quota à ordonnancer.
- **Reprise de verrou orphelin** : un verrou n'est repris que si le job porteur est `termine`, ou final **et** restauré (`restoredAt`), ou absent (TTL).
- **Durée du verrou** : de la création à `revCommit`, de l'ordre de 1 à 3 minutes pour 3 fiches (non mesuré ; la vérification domine). Une révision non terminée expire à 12 h (même durée que `CONFIRM_TIMEOUT_S`) : plus longue qu'utile, mais alignée sur ce qui existe, et l'élève peut annuler.
- **Pas de relecture** : une révision n'a pas d'écran de relecture à attendre, donc pas de verrou tenu par un élève qui s'absente.

### 5.2 Défaut à corriger dans le code de F10 avant #90

`reclaimLock` (`append.ts`) appelle `restoreAfterFailedAppend` sur le job porteur d'un verrou **final non restauré**. Avec une révision, `restoreAfterFailedAppend` ne trouve aucun `appendBase`, **retourne sans rien faire**, puis `reclaimLock` libère le verrou : la copie de travail resterait, et pire, une révision en plein `revCommit` pourrait être jugée orpheline. Correctif (lot M1-B, fichier `append.ts`) :

1. `reclaimLock` lit `job.kind` : pour `kind === 'revision'` il ne restaure **jamais** lui-même (les droits de `scans-create` ne le permettent pas, voir 7.3) ; il ne libère que si le job est `termine`, ou final avec `restoredAt` ;
2. un job final de révision non restauré laisse le verrou en place (409 au demandeur) ; `revFail` ou l'expiration de la machine termine la restauration ;
3. test : un job `echec` de révision sans `restoredAt` ne libère pas le verrou.

### 5.3 Deux appareils, deux onglets, sessions de test

- **Deux onglets du même élève** : la seconde création échoue sur le verrou (409), sans rien écrire.
- **Un passage de test ouvert pendant `revCommit`** : les questions déjà tirées (`PROFILE.currentTest.draw`) restent dans la session ; une question devenue `retiree` est corrigée normalement, sans point, avec `retired: true` ; le prochain tirage l'exclut.
- **#89 et #90** : aucune interaction. #89 agit avant la confirmation sur un job, #90 après sur un cours terminé.

## 6. Coût et quota

Rien de ce qui suit n'est mesuré. Base : R1 (« +0,0002 € par page lue, +0,0003 € par fiche »), F10 (coût réel attendu environ 0,09 € par page), Q1 (second tour de questions environ 0,003 € par fiche).

**#89** : une phrase ajoutée coûte son extraction, sa vérification et sa part de génération : de l'ordre de **0,003 € par phrase** (extrapolé de 0,09 € par page de 25 à 30 phrases). Pour 20 phrases : environ 0,06 €. Le plafond de job `max(0,25 ; 0,15 × pages)` et la garde `jobSpentEur` sont **inchangés** : un job qui atteint son plafond suit le comportement existant (le dernier appel peut le dépasser d'un appel). Aucun quota de pages : une phrase ajoutée n'est pas une page.

**#90** :

| Poste | Estimation |
|---|---|
| Extraction et vérification de N phrases touchées | environ 0,003 € par phrase |
| Réécriture de la fiche (`body`, `recall`) | environ 0,0003 € par fiche (R1) |
| Nouvelles questions (premier tour, puis second tour de Q1) | environ 0,003 € par fiche |
| **Exemple : 10 phrases touchées dans 2 fiches** | **environ 0,04 €** (estimation, non mesurée) |
| **Plafond de la révision** (`REVISION_COST_CAP_EUR`) | **0,10 €**, `jobSpentEur` obligatoire, même comportement que les scans |

Limites (constantes dans `shared/scans.ts`, défauts à trancher, P9) : 20 phrases touchées par révision (les retraits ne comptent pas pour le coût mais comptent pour la limite), 3 fiches par révision, **3 révisions par cours et par jour**, **5 par élève et par jour** (élément `REVJ#<jour>`, `ttl` 2 jours, comme `TRANSCR#`). Pire cas par élève et par jour : 5 × 0,10 € = 0,50 €, **borné en pratique par la garde de coût globale** (`costGateFor`, 429 `budget_epuise`) qui s'applique à la création comme pour un scan. Le quota mensuel de pages **ne s'applique pas** : la révision ne lit aucune photo.

Pourquoi des plafonds par jour et pas un quota de pages : une révision peut être déclenchée en boucle par un élève (ou un script avec son jeton) ; sans plafond, on ouvre un moyen de consommer le budget de la famille et du projet sans scanner une seule page.

## 7. Droits IAM minimaux, par rôle

Aucun ARN complet ni ID de compte dans ce document ni dans le dépôt : les ressources sont écrites par forme (`table`, `GSI1`, `bucket des scans`, `machine revise`).

### 7.1 Principe de rédaction

La relecture des PR #95 et #96 a trouvé, les deux fois, une **écriture que le code fait et que le rôle n'a pas** (suppression de figures et lecture `DOC#*` par `scans-delete` ; `UpdateItem` de `mutateTest` par `docs-delete`) : rédigées à partir de ce que la fonction **crée**, pas de ce qu'elle **fait en cas d'échec, de nettoyage ou de reprise**. Pour M1, chaque ligne de la table ci-dessous liste **trois colonnes** : ce que le handler lit, ce qu'il écrit, ce qu'il fait en nettoyage ou sur le chemin d'échec. Une transaction DynamoDB n'a pas d'action IAM propre : elle demande les actions de chaque élément (`PutItem`, `UpdateItem`, `DeleteItem` et, pour une simple condition, `ConditionCheckItem`).

### 7.2 Rôles

Convention de `main` : toutes les actions DynamoDB portent `dynamodb:LeadingKeys` (condition `ForAllValues:StringLike` et `Null` à faux) sur la ou les partitions utilisées. Les formes sont des motifs de partition (`STUDENT#*` = partition de l'élève, etc.). IAM **ne filtre pas la clé de tri** : l'isolation entre types d'éléments d'une même partition est faite par le code et par le test 7.3 (limite connue, déjà dite par Q1 et E1).

| Rôle | Fonctions | DynamoDB : lit | écrit | nettoyage, échec, reprise | Autres |
|---|---|---|---|---|---|
| **`confirmRole`** (existant, `pipeline-api-confirm-role`) | `jobs-confirm` (#89) | `GetItem`, `Query` sur `STUDENT#*`, `DOC#*`, `JOB#*`, `FAMILY#*` | `PutItem`, `UpdateItem` sur les mêmes partitions ; `BatchWriteItem` sur `STUDENT#*`, `JOB#*` | inchangé | **Aucun droit nouveau pour #89** : la phrase ajoutée est écrite dans `COURS#<id>#T`, `COURS#<id>#B` (partition `STUDENT#*`) comme une phrase corrigée ; aucun compteur nouveau ; S3 inchangé. Un test (7.3) le prouve. |
| **`readRole`** (existant) | `jobs-get`, `jobs-transcription`, `docs-read` | inchangé (`GetItem`, `Query` sur `STUDENT#*`, `DOC#*`, `JOB#*`, `FAMILY#*`) | aucune | aucun | `docs-read` ne fait que lire `claimsRetired` et `retiree` : aucun droit nouveau |
| **`revise-start`** (nouveau, **sans Bedrock**, hors `processingRoleNames`) | `revise-create`, `revise-cancel` | `STUDENT#*` : `GetItem`, `Query` (en-tête, textes `COURS#…#T`, `#B`, en-têtes de fiches, compteur `REVJ#`) ; `DOC#*` : `Query` (`CLAIM#` des fiches touchées) ; `FAMILY#*` : `Query` (`callerOf`, retrouver l'élève) ; `COST#<env>` : `GetItem` seulement (garde de coût, comme `scans-create`) | `STUDENT#*` : `PutItem` (job), `UpdateItem` (verrou sur l'en-tête, `REVJ#`) ; `JOB#*` : `PutItem` (`TEXT#`, `CHANGES`) ; la transaction (job + verrou) demande `PutItem` et `UpdateItem` sur `STUDENT#*` | **échec avant le lancement de la machine** : `UpdateItem` (libérer le verrou, conditionnel à `appendJobId = <revisionId>`) et `UpdateItem` du job (`restoredAt`) sur `STUDENT#*` ; `DeleteItem`/`BatchWriteItem` sur `JOB#*` (supprimer la copie de texte si le lancement échoue) ; `revise-cancel` : `UpdateItem` sur `STUDENT#*` | `states:StartExecution` sur la seule machine `revise` ; `states:SendTaskFailure` non nécessaire ; **ni S3, ni Bedrock** |
| **`revise`** (nouveau, **sans Bedrock**, hors `processingRoleNames`) | `revPrepare`, `revCommit`, `revFail` | `STUDENT#*` : `GetItem`, `Query` ; `DOC#*` : `GetItem`, `Query` (fiche vivante et partition de travail) ; `JOB#*` : `GetItem`, `Query` | `STUDENT#*` : `UpdateItem` (en-tête du cours et de la fiche, texte, blocs, job, libération du verrou) ; `DOC#*` : `PutItem` (nouvelles affirmations, verdicts, questions : écritures avec `attribute_not_exists`), `UpdateItem` (`retiree` sur `QCM#`, `GAP#`, `EXO#`) ; `JOB#*` : `PutItem` (`TEXT#` de travail de `revPrepare`) | `DOC#*` et `JOB#*` : `BatchWriteItem` (supprimer la partition de travail et la copie de texte) ; `STUDENT#*` : `UpdateItem` (`restoredAt`, verrou en dernier) | **aucun accès S3, aucun `COST#`, aucun `FAMILY#`** (la machine reçoit `sid`) |
| **`pipeline-role`** (existant, Bedrock) | `extract`, `revGenerate` | `DOC#*`, `JOB#*`, `STUDENT#*` : lectures existantes ; `COST#<env>` existant | `DOC#*` : écritures existantes (la partition de travail est une partition `DOC#*`) ; `COST#<env>` : `UpdateItem` existant | `revGenerate` ne supprime rien | **Bedrock : inchangé** (profil Haiku, et Sonnet seulement pour les figures R1) ; `revGenerate` n'ajoute **aucun modèle**. `infra/test/m2-bedrock.test.ts` : `processingRoleNames` ne change pas |
| **`verify-role`** (existant, Bedrock) | `verify-run` | partition `DOC#*` (CLAIM#) | `VERDICT#` dans `DOC#*` | inchangé | inchangé : il reçoit un `docId` de travail, sans différence pour lui |
| **`coursReadRole`** (existant) | `cours-api`, `revise-get` | `STUDENT#*` : `GetItem`, `Query` ; `DOC#*` : `GetItem`, `Query` ; `FAMILY#*` : `Query` | aucune | aucun | **Aucun droit nouveau** : l'état d'une révision est un élément `STUDENT#…/JOB#…` |
| **`coursRole`** (existant) | `cours-delete` | inchangé | inchangé | refuse (409) si le verrou est tenu par une révision (lecture de l'en-tête déjà permise) | inchangé |
| **`deleteRole`** (existant) | `docs-delete` | inchangé | inchangé | refuse (409) si la fiche est touchée par une révision en cours : lecture de l'en-tête du cours, déjà permise (`STUDENT#*`) | inchangé |
| **`play`** (existant) | `session-get`, `answers-post`, `practice-post` | lecture des attributs `retiree` : déjà `DOC#*` en lecture | inchangé | aucun | inchangé |
| **`writeRole`** (existant) | `scans-create` | inchangé | inchangé | `reclaimLock` **ne restaure pas** un verrou de révision (5.2) : aucun droit supplémentaire n'est donc nécessaire | inchangé |
| **`admin`** (existant, `game-stack.ts`) | `students-delete`, `family-admin` | **à relire par M1-D** : `deleteStudentTree` doit supprimer les partitions `DOC#<revisionId>-<k>` et `JOB#<revisionId>` d'un élève dont une révision est ouverte (le job `kind: 'revision'` les liste dans `docIds`) | — | `DeleteItem`/`BatchWriteItem` sur `DOC#*`, `JOB#*` (probablement déjà accordés : à vérifier, pas supposé) | inchangé |

**Vérifié dans le code** (sans synthèse) : `confirmRole` reçoit `grantWrite` (`GetItem`, `Query`, `PutItem`, `UpdateItem` sur `FAMILY#*`, `STUDENT#*`, `DOC#*`, `JOB#*`) plus `BatchWriteItem` sur `STUDENT#*`, `JOB#*` ; `coursRole` reçoit `GetItem`, `Query`, `UpdateItem`, `BatchWriteItem` sur `STUDENT#*`, `DOC#*`, `JOB#*`. **Non vérifié** : le détail de `admin`, `verify-role` et `pipeline-role` pour les partitions `DOC#<revisionId>-<k>` (motif `DOC#*` attendu), à relire par M1-D avant de coder.

Pourquoi deux rôles nouveaux et pas le rôle de confirmation : `revise` écrit dans `DOC#*` (promotion d'affirmations et de questions), ce que `confirmRole` ne fait pas aujourd'hui ; lui donner ce droit élargirait un rôle exposé à une route HTTP. `revise-start` est exposé à une route, il n'écrit pas dans `DOC#*` : c'est la raison de la séparation. Alternative écartée : un seul rôle `revise` pour la route et les étapes, plus simple mais qui donnerait à une route HTTP le droit d'écrire des affirmations et des questions d'une fiche.

### 7.3 Test statique « le code ne fait que ce que son rôle permet »

C'est la mesure contre l'erreur de #95 et #96, **et il doit échouer avant la fusion** si un accès manque. Deux niveaux :

1. **Enregistreur d'accès** (`api/src/pipeline/access-spy.ts`, nouveau) : un enrobage de `Db` et du port S3 de `testkit.ts` qui note chaque appel `(service, action, partition ou préfixe)`. La correspondance `Db` vers IAM est écrite une seule fois : `get` → `GetItem`, `query` → `Query`, `put` → `PutItem`, `update` → `UpdateItem`, `remove` → `BatchWriteItem` ou `DeleteItem` selon le port, `transact` → l'action de chaque élément (+ `ConditionCheckItem`).
2. **Comparaison** (`infra/test/iam-coverage.test.ts`, nouveau) : pour chaque handler de la table `HANDLER_ROLE` (fonction → rôle, lue dans `pipeline-stack.ts` et `game-stack.ts`), le test rejoue ses **scénarios** (chemin heureux, conflit de verrou, échec en milieu de travail, nettoyage, rejeu) avec l'enregistreur, puis vérifie que chaque `(action, partition)` observée est autorisée par les instructions du rôle **telles que synthétisées** (`Template.fromStack`, développement des motifs `StringLike`, prise en compte de la condition `Null`, des ressources `GSI1`, et des préfixes S3 avec leurs conditions `s3:prefix`).
   - **Un handler sans scénario déclaré fait échouer le test** : on ne peut pas ajouter une fonction sans dire ce qu'elle fait.
   - Les scénarios sont **ceux des tests unitaires existants**, rejoués avec l'enregistreur (pas de réécriture) ; le lot M1-B fournit un scénario de cleanup et d'échec par handler nouveau.
   - Inverse (avertissement, non bloquant) : droit accordé et jamais utilisé par les scénarios.
3. **Cas vérifiés par ce test pour M1** : `jobs-confirm` avec `added` (aucune action ni partition nouvelle par rapport au scénario sans `added` : prouve « aucun droit nouveau pour #89 ») ; `revise-create` (tous chemins, y compris l'échec du lancement de la machine) ; `revCommit` rejoué ; `revFail` après `revCommit` partiel ; `reclaimLock` face à un verrou de révision ; `docs-delete` et `cours-delete` refusés pendant une révision (**aucune écriture** doit être observée) ; `students-delete` avec une révision ouverte.
4. **Limites dites** : le test ne voit que ce que les scénarios exercent ; IAM ne filtre pas la clé de tri (le test ne détecte pas une écriture sur un mauvais type d'élément dans une bonne partition ; les tests de handlers s'en chargent) ; il ne remplace pas un essai réel sur l'environnement de développement, qui reste dans le plan de test (section 10).

Tests de synthèse en plus (`infra/test/m1-roles.test.ts`) : `revise-start` et `revise` n'ont aucune action `bedrock:*` ; `processingRoleNames` inchangé ; `revise` n'a aucun droit S3 ni `COST#` ; `revise-start` ne peut écrire dans aucune partition `DOC#*` ; la route `POST /cours/{coursId}/revisions` est dans `ROUTES` et dans le contrat (test existant `stacks.test.ts`) ; tags du projet sur les ressources nouvelles (`tags.test.ts`).

## 8. Contrat proposé (additif, 1.9.0, **non appliqué**)

Intégré par le lot M1-K (propriétaire unique du contrat, des fichiers générés, de la table `ROUTES` et de `docs/data-model.md` pour M1).

**#89**

| Schéma | Ajout |
|---|---|
| `AddedSentence` (nouveau) | `key` (`^n[0-9]{1,2}$`), `afterId` (identifiant de phrase ou clé d'un ajout précédent, **ou `null`** : tout au début), `text` (3 à 2 000 caractères, LaTeX permis), `newBlock` (booléen, défaut faux) |
| `ConfirmRequest` | `added` : `AddedSentence[]`, 20 au plus, 6 000 caractères au total (la limite totale est dite dans la description ; le schéma ne la porte pas). Les 400 existants s'appliquent : ancre inconnue, clé en double, ordre d'ancres impossible (une ancre vers un ajout **plus tard** dans le tableau), phrase vide, LaTeX invalide, seuil de 40 mots |
| `ConfirmRequest.sections[].fromSentenceId` | accepte aussi une clé `n<k>` d'un ajout (description et motif élargis) |
| `Sentence` (cours seulement) | `added` : booléen facultatif (affichage « Ajoutée par toi »). **Jamais** dans `Transcription` |

**#90**

| Route | Rôle | Réponses |
|---|---|---|
| `POST /cours/{coursId}/revisions` | élève (parent : 403) | 202 `Revision` ; 400 `requete_invalide` (messages constants : phrase inconnue, début de section, section vide, moins de 40 mots, LaTeX invalide, trop de phrases ou de fiches) ; 404 `introuvable` (cours inconnu ou d'un autre élève) ; 409 `etat_invalide` (autre opération en cours, fiche en cours de génération) ; 409 `fiche_trop_revisee` ; 429 `plafond_revisions` ; 429 `budget_epuise` |
| `GET /cours/{coursId}/revisions/{revisionId}` | élève | 200 `Revision` ; 404 |
| `POST /cours/{coursId}/revisions/{revisionId}/cancel` | élève | 204 ; 409 `etat_invalide` après le début de la validation |

| Schéma | Contenu |
|---|---|
| `ReviseRequest` (nouveau) | `corrections` (même schéma que `ConfirmRequest`), `removed`, `added` (`AddedSentence`) ; 20 changements au total au plus |
| `Revision` (nouveau) | `revisionId`, `coursId`, `etat` (`en_cours`, `terminee`, `echec`), `etape` (`preparation`, `verification`, `generation`, `validation`), `fiches` (`docId`, `etat`), `message` (constant, jamais de texte du cours), `createdAt` |
| `Cours` | `revision` : `{ revisionId, etat }` facultatif ; `marks` ignore les affirmations retirées |
| `TestDetail` (ligne de question) | `retired` : booléen facultatif (« retirée après une correction du cours ») |
| `AnswerResult` | `retired` : booléen facultatif (réponse à une question retirée d'une session ouverte : corrigée, sans point) |
| Erreurs nouvelles | `fiche_trop_revisee`, `plafond_revisions` |

Tests de contrat : `ReviseRequest` rejette plus de 20 changements ; **aucun champ de `Revision` ne porte de texte du cours** ; le parent n'a aucune de ces routes ; `AddedSentence.afterId` accepte `null` ; la description de `ConfirmRequest.added` dit que la phrase ajoutée est vérifiée comme une phrase lue.

## 9. Impact légal

- **Aucun nouveau sous-traitant** (AWS et Bedrock, déjà listés). **Aucune donnée nouvelle** : une phrase ajoutée ou corrigée est du texte tapé par l'élève, de même nature que les corrections de relecture ; elle suit la durée du cours.
- **Ce qui change dans le registre** (traitement T3, texte du cours) : (1) le texte d'un cours **peut être modifié par l'élève après confirmation** ; (2) une modification renvoie les **phrases modifiées** à Bedrock pour extraction et vérification, finalité inchangée ; (3) la **copie de travail** (texte des phrases modifiées et affirmations nouvelles) dure **7 jours au plus** puis est supprimée à la fin de la révision ou par expiration ; (4) les **anciennes affirmations et questions retirées** sont conservées jusqu'à la suppression de la fiche (nécessaire à l'historique et au plafond de points) ; (5) le **texte précédent d'une phrase corrigée n'est pas conservé** (hors affirmations retirées, qui en citent un extrait, `origine.extrait`).
- **AIPD** : risque d'un texte erroné conservé dans des affirmations retirées (mesure : elles ne sont ni affichées, ni tirées, ni reprises ; suppression avec la fiche) ; risque d'abus du budget (mesure : plafonds par jour et par révision, garde globale).
- **Commit séparé `docs(legal)`** dans la PR de code correspondante (`docs/legal/registre.md`, `politique-confidentialite.md`, `aipd-brouillon.md`), **à valider par le propriétaire**. `sous-traitants.md` inchangé.
- **`POLICY_VERSION` n'est pas relevé** par M1 (valeur actuelle `2026-11-27`) : une hausse commune sera faite plus tard, **avant le premier déploiement (dev compris) qui conserve ou modifie un texte de cours de cette manière**. Les textes légaux ne doivent pas être publiés avant que le lot qui les justifie soit livré ; à écrire dans le seed des lots M1-A et M1-B. Attention : `web/src/screens/Policy.tsx` affiche les textes, à ne pas modifier avant la hausse.
- #89 seul n'ajoute **rien** au registre au-delà d'une phrase tapée par l'élève (déjà couverte par « corrections »).

## 10. Tests

**#89** (lot M1-A) :
- `applyAdded` (fonction pure) : ancre au début, au milieu d'un paragraphe, dans une liste, après un titre, après une formule, après une figure ; deux ajouts en chaîne ; ajout après une phrase retirée dans la même requête ; ancre inconnue (400) ; clé en double (400) ; identifiants attribués sans trou ni reprise d'un identifiant retiré ; **aucun identifiant existant renuméroté** ; blocs corrects ; job sans couche de blocs.
- `jobsConfirm` avec `added` : coupe de section sur une phrase ajoutée ; seuil de 40 mots avec ajouts ; `sanitizeLatex` (formule invalide refusée, rien modifié) ; 21 ajouts (400) ; 6 000 caractères dépassés (400) ; rejeu de la confirmation (même résultat) ; `added: true` écrit ; F10 : ancre sur le contexte refusée.
- Vérification : une phrase ajoutée sans source donne `non_verifiable` et aucune question (faux modèle `testkit`) ; aucun texte dans les journaux.
- Contrat : voir section 8.
- Site (`ConfirmView`) : ajout en tête, en milieu, en nouveau paragraphe ; sauvegarde dans `sessionStorage` ; aperçu LaTeX ; captures PC et mobile relues avant rapport.

**#90** (lots M1-B, M1-C, M1-D) :
- **Cours intact en cas d'échec** : pour chaque étape de la machine (`revPrepare`, `extract`, `verify-run`, `revGenerate`) un échec laisse **octet pour octet** cours, fiche, `CLAIM#`, `VERDICT#`, `QCM#`, `GAP#`, `TEST#`, `ATT#` identiques et le verrou libéré ; **test de non-régression de `clearDoc`** : `extract` lancé sur la partition de travail ne supprime rien dans la fiche vivante.
- `revCommit` : rejoué après chaque étape (1 à 6) donne le même état final ; numéros d'affirmations et de questions jamais réutilisés ; `claimId` et `questionId` des questions promues cohérents ; une question retirée n'est plus tirée, reste lisible dans `TestDetail` avec `retired` ; les `ATT#` et `TEST#` ne bougent pas ; **les points déjà gagnés comptent dans les 50 de la fiche** (une fiche à 50 sur 50 reste à 50 après révision) ; 99 emplacements dépassés : 409 `fiche_trop_revisee`.
- Verrou : deux créations concurrentes (une seule gagne) ; création pendant un ajout de pages (409) ; ajout de pages pendant une révision (409) ; suppression du cours ou d'une fiche touchée pendant une révision (409, aucune écriture) ; verrou d'une révision `echec` non restaurée non repris par `scans-create` ; expiration à 12 h.
- Parent : 403 sur les trois routes ; `CoursMeta` inchangé ; aucun texte dans `Revision`.
- Isolation : un `coursId` ou un `revisionId` d'un autre élève, d'une autre famille ou d'un frère répond 404, sans différence avec un inconnu ; `sid` toujours issu du jeton.
- Coût : plafond de 0,10 € atteint (comportement identique aux scans), `budget_epuise`, plafonds par jour et par cours (429 `plafond_revisions`), compteur `REVJ#` avec `ttl`.
- Figures : une révision ne touche pas `COURS#B.figures` ni S3 (test sur compteurs d'appels S3 : zéro).
- Suppression d'un élève ou d'une famille avec une révision ouverte : plus aucune partition `DOC#<revisionId>-<k>` ni `JOB#<revisionId>` après (test qui compte les éléments avant et après).
- Test statique 7.3 et tests de synthèse `m1-roles`.
- **Essai réel sur l'environnement de développement** (jamais fait ici) : une révision de bout en bout avec un vrai modèle, 3 fiches, mesure du temps et du coût réels, avant toute décision de fusion de M1-B.

## 11. Découpage en lots, un seul propriétaire par fichier

Ordre : **K → A** (livrable seul) ; **K → D (rôles) → B → C → F** pour #90. M1-A ne dépend pas de #90.

| Lot | Contenu | Fichiers propres (aucun autre lot n'y touche) |
|---|---|---|
| **M1-K** contrat, routes, modèle | `AddedSentence`, `ReviseRequest`, `Revision`, routes, erreurs, version 1.9.0 ; tests de contrat ; `ROUTES` | `shared/contract/openapi.yaml`, `shared/contract/generated/*`, `infra/lib/api-stack.ts` (table `ROUTES` seulement), `docs/data-model.md`, `shared/items.ts` (champs `added`, `claimsRetired`, `rev`, `retiree`) |
| **M1-A** #89 API | `applyAdded` (pure) et son branchement dans `jobsConfirm` (validation avant écriture, ordre des opérations, sections, 40 mots) | `api/src/pipeline/api.ts`, nouveau `api/src/pipeline/changes.ts` (fonctions pures `applyAdded`, `applyChanges` partagées avec M1-B), `api/src/pipeline/changes.test.ts`, `api/src/pipeline/added.test.ts` |
| **M1-E** #89 site | bouton d'ajout, champ, aperçu LaTeX, marque « Ajoutée par toi », sauvegarde locale, envoi de `added` | `web/src/screens/confirm/ConfirmView.tsx`, `web/src/screens/confirm/storage.ts`, `web/src/screens/confirm/*.css`, `web/src/api/*` du contrat (généré par M1-K) |
| **M1-D** infra #90 | machine `revise`, rôles `revise-start` et `revise`, fonctions, variables, plafonds ; **test statique 7.3** ; tests de synthèse | `infra/lib/pipeline-stack.ts`, `infra/lib/game-stack.ts` (rôle `admin`, si besoin), `api/src/pipeline/access-spy.ts`, `infra/test/iam-coverage.test.ts`, `infra/test/m1-roles.test.ts` |
| **M1-B** #90 API | `revise-create`, `revise-get`, `revise-cancel`, étapes `revPrepare`, `revGenerate`, `revCommit`, `revFail`, réutilisation de `extract` et `verify-run` sur la partition de travail, correctif de `reclaimLock`, refus de suppression, `deleteStudentTree` | nouveau `api/src/revise/*`, `api/src/pipeline/append.ts`, `api/src/pipeline/entry.ts`, `api/src/pipeline/steps-doc.ts` (aucun changement de comportement de `extract`, seulement des tests ; si un changement est nécessaire, il vient ici), `api/src/cours/cours.ts`, `api/src/docs/*` (refus de suppression, `claimsRetired`), `shared/delete-tree.ts`, `shared/scans.ts` (constantes, `listScans` ignore `kind: 'revision'`), `shared/ddb/keys.ts` (clé `REVJ#`) |
| **M1-C** lecteurs de questions | ignorer `retiree` au tirage, dans `answers-post` (sans point, `retired: true`), dans `docs-read` si différent, `Cours.marks` | `api/src/game/draw.ts`, `api/src/game/answers.ts`, `api/src/handlers/answers-post.ts`, `api/src/handlers/session-get.ts`, `api/src/docs/read.ts` (propriétaire à nommer par le lot : un seul fichier par lecteur) |
| **M1-F** #90 site | écran de modification du cours, bannière de révision en cours, état de la révision, étiquette « retirée après une correction du cours » | `web/src/screens/Cours.tsx`, `web/src/screens/TestDetail.tsx`, `web/src/screens/Docs.tsx` (état seulement), CSS associés |
| **M1-G** légal | registre, politique, AIPD, dans un commit `docs(legal)` séparé | `docs/legal/*` |
| **M1-T** e2e | parcours #89 (ajout, confirmation, fiche) et #90 (modification, bannière, fiche mise à jour, tirage sans question retirée) avec faux modèle | `e2e/*` (fichiers nouveaux de M1) |

Seeds de lot : écrire « le propriétaire » et jamais son prénom (la garde `scripts/guards.test.ts` échoue sinon) ; aucun ID de compte, ARN complet, clé ou secret dans le dépôt (`<ID_COMPTE>` dans les documents) ; commits par `Worxfr <worx@pouf.org>` ; tout est tagué `Project`, `Environment`, `ManagedBy`, `Owner` ; **estimation de coût à faire valider avant tout déploiement de ressources nouvelles** (machine `revise`, deux rôles, fonctions : aucun bucket ni table nouveaux).

## 12. Points à trancher par le propriétaire

Chaque point a une réponse par défaut, utilisée tant que rien d'autre n'est décidé.

| # | Question (en mots simples) | Défaut proposé |
|---|---|---|
| P1 | Faut-il livrer d'abord « ajouter une phrase oubliée » (petit), puis seulement ensuite « modifier un cours » (gros) ? | **Oui**, dans cet ordre : #89 d'abord, séparé. |
| P2 | Où peut-on ajouter une phrase à la relecture ? | Après n'importe quelle phrase, ou tout au début. Elle rejoint le paragraphe, ou forme un nouveau paragraphe au choix de l'élève. |
| P3 | Peut-on ajouter une formule « seule sur sa ligne » ? | **Non** en première version : la formule s'écrit dans une phrase, avec `$…$`. |
| P4 | Combien de phrases ajoutées d'un coup ? | **20** au plus, **6 000 caractères** au total. |
| P5 | Une phrase ajoutée est-elle vérifiée comme les autres ? | **Oui, sans exception.** Si aucune source ne la confirme, elle est « non vérifiée » et ne donne aucune question. |
| P6 | Que veut dire « modifier un cours » ? | Corriger, retirer ou ajouter des **phrases**. Pas de déplacement, pas de nouveau découpage, pas de changement de photo ni de figure. |
| P7 | La fiche est-elle refaite en entier ? | **Non.** Elle garde son identité, son historique et ses points. Seules les affirmations touchées sont remplacées ; le texte de la fiche et le rappel sont réécrits ; les questions touchées sont retirées et remplacées. |
| P8 | Que deviennent les points déjà gagnés ? | **Ils restent**, et comptent toujours dans les 50 points de la fiche : modifier un cours ne permet pas de regagner des points. |
| P9 | Quelles limites pour une modification, et quel coût maximum ? | **20** phrases touchées, **3** fiches, **3** modifications par cours et par jour, **5** par élève et par jour, coût plafonné à **0,10 €** par modification (estimation, non mesurée). |
| P10 | Les anciennes questions retirées : on les efface ou on les garde ? | On les **garde** (invisibles, jamais posées) jusqu'à la suppression de la fiche, pour que l'historique reste lisible. Dans l'historique, elles portent « retirée après une correction du cours ». |
| P11 | Peut-on retirer la première phrase d'une section ou toutes ses phrases ? | **Non**, avec un message clair (sinon la fiche n'aurait plus de début). Il faut alors supprimer la fiche. |
| P12 | Garde-t-on l'ancien texte pour pouvoir « annuler » une modification ? | **Non.** Une modification réussie est définitive. Une modification qui échoue ne change rien. |
| P13 | Un test en cours au moment de la modification ? | La question retirée est **corrigée normalement, sans point**, et ne reviendra plus. |
| P14 | Combien de retouches par fiche avant de devoir la refaire ? | Jusqu'à épuisement des **99 numéros** de questions et d'affirmations, avec le message « trop retouchée : supprime-la et rescanne ». Aucune limite par nombre de retouches. |
| P15 | Les textes de confidentialité changent-ils tout de suite pour M1 ? | Le commit existe, **à valider par le propriétaire** ; la version de la politique **n'est pas relevée** (hausse commune plus tard). |
| P16 | Qui peut modifier un cours ? | **L'élève seulement.** Le parent n'a ni accès au texte ni droit de modification. |

## 13. Ce qui n'a pas été mesuré ni vérifié

- **Aucun coût, aucune durée, aucune taille n'est mesuré.** Les 0,003 € par phrase, 0,04 € pour une révision de 10 phrases, 1 à 3 minutes de verrou et la seconde de fenêtre de `revCommit` sont des estimations tirées des chiffres d'autres conceptions. Le lot M1-B mesure une révision réelle sur l'environnement de développement avant fusion.
- **Aucun `cdk synth`** : les droits de la section 7.2 sont lus dans `pipeline-stack.ts` de `main`, pas dans un modèle synthétisé. Les rôles `admin`, `verify-role` et `pipeline-role` face à des partitions `DOC#<revisionId>-<k>` restent à confirmer par M1-D (motif `DOC#*` attendu).
- **Aucun essai de réutilisation de `extract` et `verify-run`** avec un `docId` de travail : l'hypothèse est qu'ils n'écrivent que dans la partition reçue, hors en-tête de fiche. À vérifier en premier par M1-B (test de non-régression de `clearDoc`, section 10). Si `extract` écrit autre chose (compteurs, empreintes `CLAIMCACHE#`), les lignes concernées s'ajoutent à la table des droits.
- **Lecteurs de questions** : la liste de la section 4 vient d'une lecture partielle ; le lot M1-C la complète par `grep` de tous les lecteurs de `QCM#`, `GAP#`, `CLAIM#` et `EXO#`.
- **E1** : seule la conception est fusionnée ; la règle sur `EXO#` s'applique si le code E1 est livré avant M1-B.
- Non évalué : qualité réelle de la vérification d'une phrase tapée par l'élève (part de `non_verifiable` attendue), temps réel d'une révision sur trois fiches, comportement de `reclaimLock` face à une exécution de machine qui dépasse 12 h (cas improbable, non étudié), nombre réel de questions d'une banque après plusieurs révisions.
