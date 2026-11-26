# Q1 : banque de questions variées (#42) et « S'entraîner » sur plusieurs fiches ou un dossier (#72)

Statut : **conception**, aucun code écrit. Le contrat d'API n'est **pas** modifié par cette PR : `shared/contract/openapi.yaml` appartient à la PR #82 (contrat 1.5.0). Le contrat proposé est dans la section 8, à intégrer plus tard.
Dépend de : H1 (historique des tests, `docs/H1-design.md`, déjà fusionné) ; croise R1 (PR #82, fiche en paragraphes) et F10 (PR #84, ajout de pages à un cours) : voir section 13.
Les coûts sont **estimés, pas mesurés** (aucun appel de modèle n'a été fait pour ce document).

## 1. Ce qui existe aujourd'hui

- La génération (`makeQuestions`, `api/src/pipeline/steps-doc.ts`) fait **un** appel Haiku qui renvoie le résumé, au plus 5 QCM et au plus 5 textes à trous (`MAX_QUESTIONS = 5`, `questionCap(verified) = min(5, max(1, ceil(verified / 2)))`), puis un second appel « à l'aveugle » (`controle-qcm`) qui résout chaque QCM sans voir la clé. Une question repose sur **une** affirmation vérifiée (`claimId`).
- Les questions sont des éléments `DOC#<docId>` / `QCM#<nn>` et `GAP#<nn>`. `questionId = <docId>:<qcm|gap>:<nn>` (`nn` sur 2 chiffres : **99 au plus** par type). `answers-post` relit la question par cette clé exacte (`keys.qcm(docId, nn)`), donc **tout** `questionId` bien formé d'une fiche de l'élève est accepté, tiré ou non.
- `GET /docs/{docId}/session` renvoie **toutes** les questions de la fiche (10 au plus), sans clé ni mot attendu. Il pose `PROFILE.tick`, `PROFILE.series` et le pointeur `PROFILE.currentTest` (H1).
- « Une récompense par question pour toujours » (`game-rules.md` 7.2) : `ATT#<questionId>#<jour>` porte `rewarded`. Plafond de 250 XP par jour. Série de 10 : `SERIES_LENGTH = 10`, bonus +20, parfaite +30.
- Un test porte sur **une** fiche : `Quiz.tsx` ne reçoit qu'un `docId` (bouton « S'entraîner » de `Doc.tsx`). Les dossiers (#74) ne servent qu'à classer les fiches : `DOC#.dossierId`.
- Plafond de coût par scan : `jobCapEur(pages) = max(0,25 ; 0,15 x pages)` EUR, dont `GEN_RESERVE_CENTS = 6` centimes gardés pour la génération (`docs/cost-guard.md`).

Conséquence : avec 5 + 5 questions par fiche, deux tests de suite sur la même fiche posent **les mêmes questions** dans le même ordre.

## 2. Idée générale (en deux phrases)

On prépare **plus de questions que nécessaire** par fiche (la « banque »), on retire à la création celles qui se ressemblent trop, et à chaque test le serveur **tire** une liste dans la banque, en évitant les questions déjà répondues et les questions proches entre elles. Le même tirage sert pour une fiche, plusieurs fiches ou un dossier.

Ce qu'on ne change pas : la clé et le mot attendu ne quittent jamais le serveur, la photo est toujours supprimée à la confirmation, l'historique garde des identifiants de questions et jamais leur texte.

## 3. Modèle de données de la banque

**Aucun type d'élément nouveau, aucune table, aucun index.** La banque est l'ensemble des éléments `QCM#<nn>` et `GAP#<nn>` déjà présents sous `DOC#<docId>`, en plus grand nombre.

| Quoi | Où | Changement |
|---|---|---|
| Question QCM / trou | `DOC#<docId>` / `QCM#<nn>`, `GAP#<nn>` | **Inchangé.** `nn` va jusqu'à 40 par type en pratique (limite de format 99). Les numéros ne sont **jamais réutilisés** : une question retirée laisse un trou (voir section 13 pour F10) |
| Taille de la banque | calculée | `QuestionPool = nombre de QCM + nombre de trous lisibles`. Affichée par `DocSummary.questionCount` (section 8) |
| Questions déjà vues | `ATT#<questionId>#<jour>` (existant) | **Aucun nouvel élément.** Le tirage lit `ATT#<docId>:` en préfixe : « vue » = a une ligne `ATT`, « dernière fois » = le jour le plus récent |

Pourquoi ne pas créer un élément `SEEN#` : `ATT` est déjà écrit à chaque réponse, dans la partition de l'élève, effacé avec l'élève, et porte le jour. Contre-partie : une fiche travaillée tous les jours pendant un an donne environ 3 650 lignes `ATT` (10 par jour), soit environ 0,4 Mo à lire, un seul `Query` d'environ 50 RCU. `shortcut: lecture complète des ATT de la fiche, à remplacer par un élément SEEN#<docId> (au plus 99 identifiants) si une fiche dépasse 5 000 lignes ou 300 ms.`

**Pointeur de passage (H1) : un champ de plus.** `PROFILE.currentTest.draw: string[]` : la liste ordonnée des `questionId` tirés (20 au plus, environ 700 octets). `currentTest.docId` reste la **première** fiche ; `currentTest.docIds` (au plus 10) porte les autres pour un test multi-fiches.

**Entrée `TEST#` (H1), champs en plus**, tous facultatifs (une entrée H1 sans eux reste valide) :

| Champ | Sens |
|---|---|
| `scope` | `fiche` (défaut), `fiches` ou `dossier` |
| `docIds` | les fiches interrogées (10 au plus). `docId` reste la première, pour les clients H1 et pour le filtre par fiche |
| `titre` | pour `fiches` : « 3 fiches » ; pour `dossier` : le nom du dossier, nettoyé et coupé à 200 caractères (copie, comme H1 P6) |

`items[].q` contient déjà `<docId>:<kind>:<nn>`, donc le `docId` de chaque ligne se déduit sans nouveau champ. Le filtre par fiche (`GET /me/tests?docId=`) devient `docId = :d OR contains(docIds, :d)`.

## 4. Génération de la banque

### Où
Dans `generate` (étape 12, `api/src/pipeline/steps-doc.ts`), **après** l'appel actuel qui reste identique (résumé, `cap` QCM et `cap` trous, contrôle à l'aveugle). Le nouveau code vit dans un fichier à part, `api/src/pipeline/pool-gen.ts`, appelé en 3 lignes depuis `generate`. Les questions du premier tour gardent leurs numéros (01 à 05), celles du second tour suivent (06 et plus).

### Combien
`poolCap(verified) = min(20, max(questionCap(verified), 2 x verified))` par type (QCM et trous), c'est-à-dire environ **deux questions par fait vérifié**, au plus **20 QCM + 20 trous = 40 par fiche**. Exemple : 4 faits vérifiés donnent au plus 8 QCM + 8 trous ; 12 faits donnent 20 + 20.

Ce nombre est un **plafond de demande**, pas une promesse : le contrôle de proximité (section 5) retire les jumelles, et une fiche courte aura une banque plus petite (voir P3). Seuls les faits **vérifiés** servent, comme aujourd'hui : un fait « non vérifiable » ou « erreur » n'a jamais de question.

### Comment
Un **second tour** de génération, un seul appel Haiku (`'variantes'`, `maxTokens: 4000`), avec dans le prompt : les affirmations vérifiées (`<affirmations>`, donnée non fiable, même `defang`), et **la liste des énoncés déjà produits** (`<deja>`, donnée non fiable). Consigne : « pour chaque affirmation, propose d'autres questions sous un autre angle (autre mot masqué, question inverse, autre formulation), jamais la même réponse attendue qu'une question déjà faite sur cette affirmation ». Même format JSON que le premier tour (`qcm`, `trous`), `claimId` obligatoire.

Ensuite, **dans cet ordre, tout par le code** :
1. mêmes validations que le premier tour (`validQcm`, `validGap` : `claimId` dans l'ensemble des affirmations vérifiées, mot masqué copié de l'affirmation, 4 choix différents) ;
2. **contrôle de proximité** (section 5) contre toutes les questions déjà retenues, premier tour compris ; les questions trop proches sont jetées ;
3. **contrôle à l'aveugle des nouveaux QCM** par le même appel `controle-qcm` qu'aujourd'hui (une seule fois pour tous les nouveaux QCM) ; un QCM dont la réponse ne concorde pas est rejeté ;
4. écriture des éléments `QCM#`/`GAP#` suivants, avec `shuffleChoices(q.choix, q.cle, qid)` comme aujourd'hui.

Si le plafond du job ou le garde de coût refuse l'appel (`JobBudgetExceededError`, `CostBlockedError`) ou si la sortie est illisible (`ModelOutputError`, `salvageTruncatedList` pour une sortie coupée), **la fiche est publiée avec la banque du premier tour**, comme aujourd'hui pour les questions. Rien n'est perdu, rien n'échoue.

### Coût estimé (non mesuré)
Prix de `shared/pricing.ts` : Haiku à 0,11 USD (entrée) et 0,55 USD (sortie) par million de jetons, 1 USD = 0,912 EUR.

| Appel | Entrée | Sortie | Coût |
|---|---|---|---|
| Second tour (variantes) | environ 2 100 jetons (30 affirmations, 10 énoncés déjà faits, consigne) | environ 2 000 jetons (20 questions) | environ 0,0012 EUR |
| Contrôle à l'aveugle des nouveaux QCM | environ 1 100 jetons | environ 150 jetons | environ 0,0002 EUR |
| **Total par fiche** | | | **environ 0,0014 EUR** (au plus 0,003 EUR pour une fiche à 20 + 20) |

Comparaison : le coût mesuré d'un scan est d'environ 0,09 EUR **par page**. Une fiche de 6 sections ajoute au plus 6 x 0,003 = **0,02 EUR**. Cela reste très en dessous des 6 centimes gardés par `GEN_RESERVE_CENTS`. **Le plafond par scan `jobCapEur(pages)` est inchangé** : le second tour passe par `callModel`, donc par la garde (`jobSpentEur` obligatoire, refus avant l'appel). Aucune limite du garde de coût n'est touchée.

### Fiches déjà créées
Elles gardent leurs 5 + 5 questions (le tirage fonctionne, la banque est juste petite). Un bouton **« Ajouter des questions »** (lot Q1-X, facultatif, voir P6) refait seulement le second tour à partir des affirmations et verdicts déjà stockés (`CLAIM#`, `VERDICT#` : ils n'ont pas de durée de vie). Coût d'environ 0,0014 EUR par fiche, une fois par fiche et par jour, 10 par jour et par élève (même modèle que le compteur `TRANSCR#` : élément `POOL#<jour>` avec `ttl` de 2 jours). Nouveau rôle de traitement : à ajouter à `processingRoleNames` du test M2 (`infra/test/m2-bedrock.test.ts`), seul `bedrock:InvokeModel` sur le profil d'application.

## 5. Détection de proximité entre questions

Une seule fonction pure, `closeness(a, b)` dans `shared/pool.ts`, **sans modèle** (donc gratuite, déterministe, testable), utilisée **deux fois** : à la génération (jeter les jumelles) et au tirage (filet de sécurité, y compris entre fiches différentes).

Pour chaque question on prépare `{ docId, claimId, kind, texte, reponse }` :
- `texte` : l'énoncé du QCM, ou la phrase du trou **sans** le trou ;
- `reponse` : le choix correct du QCM, ou le mot attendu ;
- normalisation de `api/src/pipeline/text.ts` (`normalize`: minuscules, sans accents ni ponctuation), mots de moins de 3 lettres et mots-outils retirés.

Deux questions sont **proches** si l'une des trois règles est vraie :

| Règle | Condition | Pourquoi |
|---|---|---|
| R1. Même fait, même réponse | même `docId`, même `claimId`, **même `reponse` normalisée** | c'est la définition de l'issue : « même fait, même réponse attendue ». Couvre QCM contre trou sur la même affirmation |
| R2. Mêmes mots | similarité de Jaccard des mots de `texte` **>= 0,6** | deux formulations presque identiques, même entre deux fiches |
| R3. Même réponse, mots en commun | même `reponse` normalisée **et** Jaccard des mots de `texte` **>= 0,35** | même mot masqué dans une phrase du même cours sur deux fiches voisines |

Une question **n'est pas** proche d'une autre de la même affirmation si la réponse attendue est différente (autre mot masqué : c'est justement la variété voulue). Les seuils 0,6 et 0,35 sont des **valeurs de départ non mesurées** : le lot Q1-G les calibre sur un jeu de 10 fiches réelles avec des paires jugées à la main (point P12), avant de les figer dans `shared/pool.ts` avec les paires en test.

Choix écarté : un juge par modèle (« ces deux questions sont-elles proches ? »). Coût et latence ajoutés, résultat non déterministe. À reprendre seulement si la mesure montre des jumelles qui passent.

## 6. Tirage

Fonction pure `drawQuestions(candidates, size, history, rng)` dans `shared/pool.ts` (le hasard est un paramètre, donc testable), appelée par `api/src/game/draw.ts`.

Entrées : les questions lisibles de chaque fiche (`QcmItemSchema`/`GapItemSchema.safeParse`, comme `getSession`), pour chaque question sa dernière date de réponse (`ATT`, ou « jamais »), la taille demandée (`size`, 10 par défaut, 5, 10, 15 ou 20).

1. **Passe 1, jamais répondues.** Tour à tour, une fiche après l'autre dans un ordre mélangé, on prend dans la fiche la prochaine question **jamais répondue** qui n'est proche (section 5) d'aucune question déjà tirée. On alterne QCM et trous quand les deux existent dans la fiche. Une fiche à court passe son tour. On s'arrête à `size`.
2. **Passe 2, déjà répondues.** S'il manque des questions, même méthode avec les questions déjà répondues, **les plus anciennes d'abord** (égalité au hasard). C'est le « tant que la banque n'est pas épuisée » de l'issue : on ne reprend une question vue qu'une fois toutes les autres vues.
3. **Mélange final** de l'ordre (le serveur garde cet ordre, il devient le `rank` de l'historique).
4. Si `size` n'est pas atteint (banque trop petite ou trop de jumelles), le test est **plus court** et la réponse porte `short: true` avec `available` (voir P3). On ne complète jamais avec une question proche.

Conséquences vérifiables : deux tests de suite sur une banque de 20 questions et `size` 10 ne partagent aucune question ; un troisième reprend d'abord les plus anciennes ; un test ne contient jamais deux questions que `closeness` déclare proches ; une fiche d'un test multi-fiches n'a jamais plus d'une question d'écart avec une autre tant que toutes ont des questions disponibles.

La liste tirée est enregistrée dans `PROFILE.currentTest.draw` dans l'écriture de `PROFILE` que `session-get` fait déjà (aucune écriture de plus).

**Contrôle à la réponse (anti-triche).** Aujourd'hui `answers-post` accepte n'importe quel `questionId` d'une fiche de l'élève. Avec une banque, un élève pourrait deviner `fiche:qcm:17` et la réponse lui montrerait la bonne réponse sans jamais passer par un tirage. Règle ajoutée : **`answers-post` n'accepte qu'un `questionId` présent dans `currentTest.draw`** (sinon 409 `etat_invalide`, message « Ouvre d'abord un test »). Cela change le cas 2 de H1 (« réponse sans session ouverte = passage implicite ») : il disparaît. Point P10.

Le `rank` et `total` de H1 deviennent : `rank` = position dans `draw`, `total` = `draw.length` (au lieu de `docQuestions`).

## 7. Interaction avec l'historique des tests (H1, #44) et les points

- Le passage reste **une entrée `TEST#`**, une par test, quel que soit le nombre de fiches. `scope`, `docIds`, `titre` : section 3. `mode` reste `mixte`/`qcm`/`gap` (H1 §9 prévoyait `tirage` ; ce n'est pas nécessaire, le tirage est le comportement normal).
- La vue **parent** de H1 est inchangée : résultat juste/faux par `questionId` et `rank`, jamais de texte. Elle gagne seulement `docIds` et `scope` dans le résumé.
- **Suppression d'une fiche** (H1 P2 : « fiche supprimée = ses passages supprimés »). Pour un test d'**une** fiche, rien ne change. Pour un test multi-fiches, supprimer une fiche retire **seulement les lignes de cette fiche** (préfixe `<docId>:` de `q`), recalcule `total`, `answered`, `correct`, et supprime le passage s'il ne reste aucune ligne (point P9). `deleteDocTree` (`shared/delete-tree.ts`) en est le propriétaire.
- Un `questionId` qui n'existe plus (question retirée à la régénération) : `prompt` absent dans `TestDetail`, le front affiche « question retirée » (H1 §9, déjà prévu).
- **Points (XP).** La règle « une récompense par question pour toujours » ne change pas. Conséquence à connaître : une fiche passe de 10 questions payables à 40 au plus, donc de 50 à environ 200 XP de gain total. Le plafond de 250 XP par jour, le délai minimal de 1 s par réponse, les 20 s pour une série de 10 et la quarantaine au-delà de 100 bonnes réponses en 10 minutes restent. Le bonus « série parfaite » reste refusé pour une question dont l'affirmation n'est pas « vérifiée » (calculé **par question**, donc correct sur un test multi-fiches). Point P5.
- Une série (`SERIES_LENGTH = 10`) correspond à 10 réponses : un test de 20 questions donne deux séries.

## 8. Contrat proposé (additif, **non appliqué** : à intégrer après la PR #82)

Version : `1.6.0` si #82 (1.5.0) est fusionnée d'abord, sinon à renuméroter. Aucun champ obligatoire nouveau, aucune route existante modifiée de façon incompatible. `npm run gen` obligatoire après toute modification de `openapi.yaml`, même d'un exemple.

### 8.1 `GET /docs/{docId}/session` (route existante)
Paramètre de requête facultatif `size` (`5`, `10`, `15`, `20`, défaut `10`). Réponse `Session` (champs ajoutés, tous facultatifs) :

| Champ | Type | Sens |
|---|---|---|
| `available` | integer | nombre de questions distinctes utilisables dans la banque (hors proches) |
| `short` | boolean | `true` si moins de questions que demandé |

Un client 1.5 qui ignore ces champs reçoit simplement 10 questions au plus (il en recevait déjà 10 au plus).

### 8.2 `POST /practice/session` (route nouvelle, élève seulement)
Corps `PracticeRequest` : exactement **un** de `docIds` (1 à 10 identifiants, `minLength 1`, `maxLength 64`) ou `folderId`, plus `size` facultatif comme ci-dessus. Réponse 200 `PracticeSession` :

```yaml
PracticeSession:
  type: object
  required: [scope, title, docIds, questions, available, short, skipped]
  properties:
    scope: { type: string, enum: [fiches, dossier] }
    title: { type: string, maxLength: 200 }
    docIds: { type: array, items: { type: string }, maxItems: 10, description: "Fiches réellement interrogées, dans l'ordre" }
    questions: { type: array, items: { $ref: '#/components/schemas/Question' } }
    available: { type: integer, minimum: 0 }
    short: { type: boolean }
    skipped:
      type: array
      items:
        type: object
        required: [docId, reason]
        properties:
          docId: { type: string }
          title: { type: string, maxLength: 200 }
          reason: { type: string, enum: [sans_question, introuvable] }
```

`Question` gagne `docId` (facultatif, chaîne) et `docTitle` (facultatif, 200 au plus), utiles pour afficher la fiche d'origine pendant un test multi-fiches. `Question` n'a toujours **ni clé ni mot attendu** (le test de contrat existant « pas de champ cle/attendu » couvre aussi `PracticeSession`).

Codes : 400 `requete_invalide` (les deux ou aucun de `docIds`/`folderId`, plus de 10 fiches, `size` hors liste, doublon dans `docIds`) ; 403 pour un parent ; 404 `introuvable` pour un `folderId` inconnu ou d'un autre élève ; **409 `aucune_question`** si aucune fiche n'a de question. Un `docId` inconnu **ou d'un autre élève** n'est pas une erreur : il est rangé dans `skipped` avec `introuvable`, sans différence visible entre « n'existe pas » et « appartient à un autre » (pas de fuite d'existence). Limite de débit : celle de `GET /docs/{docId}/session`.

Un dossier sans fiche, ou dont toutes les fiches sont sans question : 409. Un dossier de 25 fiches : on prend les 10 fiches **les moins récemment travaillées** (point P7) ; les autres ne figurent pas dans `skipped` (elles n'ont pas été écartées pour un défaut, seulement pas retenues) et la réponse a `docIds` de 10.

### 8.3 `DocSummary`
Champ facultatif `questionCount` (integer, taille de la banque de la fiche). C'est un **nombre**, jamais un contenu : visible aussi par le parent.

### 8.4 `TestSummary` / `TestParentDetail` / `TestDetail` (H1)
`TestSummary` gagne `scope` (`fiche`, `fiches`, `dossier`) et `docIds` (tableau, 10 au plus). `docId` reste présent (première fiche). Les lignes `TestQuestionStatus` et `TestQuestionResult` n'ont pas de champ nouveau : leur `questionId` contient le `docId`. `TestQuestionResult` (élève) garde seule `choice`.

### 8.5 `POST /docs/{docId}/pool` (facultatif, lot Q1-X)
Élève propriétaire. Pas de corps. 202 `PoolStatus { state: pret | en_cours, questionCount }`, 409 si déjà demandé aujourd'hui, 429 si 10 demandes aujourd'hui, 404 si la fiche n'est pas à l'élève. Idempotent dans la journée.

## 9. Interface : plusieurs fiches ou tout un dossier

Ce qui change à l'écran, en deux endroits seulement :

1. **Liste des fiches** (`Docs.tsx`) : un bouton « S'entraîner sur plusieurs fiches » ouvre un mode « choisir » : une case à cocher par fiche (**10 au plus**, compteur « 3 fiches choisies »), puis le bouton « Commencer ». Les fiches sans question (`questionCount` = 0) sont grisées avec la raison « pas encore de questions ».
2. **Dossier** (`Folders.tsx`, écran du dossier) : un bouton « S'entraîner sur ce dossier ». Si le dossier a plus de 10 fiches, le bouton dit « S'entraîner (10 fiches parmi 25) ». Si aucune fiche n'a de question, le bouton est grisé.

Avant de commencer, un choix simple « Combien de questions ? 5 · **10** · 15 · 20 ». Pendant le test, chaque question affiche en petit le titre de sa fiche (multi-fiches seulement). À la fin : le score habituel, plus « Tu as vu N fiches », et si `short` : « Cette banque n'a que N questions différentes. Reviens quand tu auras scanné plus de pages. ». Les fiches écartées (`skipped`) sont dites avant le début : « 2 fiches n'ont pas encore de questions ».

`Quiz.tsx` accepte deux entrées : `docId` (route existante `/quiz/<docId>`, inchangée) et une session déjà tirée (route nouvelle `/entrainement`, la session est tenue en mémoire de l'application, jamais dans l'URL, donc l'adresse ne contient aucune question). Recharger la page `/entrainement` : le client rappelle `POST /practice/session` avec les mêmes `docIds` (un nouveau tirage ; l'ancien passage reste, voir section 7).

Fiches **non vérifiées** : une fiche dont aucun fait n'est vérifié n'a pas de question, donc elle est écartée (`sans_question`). Une fiche avec des faits « erreur » ou « non vérifiable » est interrogée sur ses seuls faits vérifiés, comme aujourd'hui. Fiche **supprimée** pendant un test : `POST /answers` répond 404 pour ses questions ; le client saute la question et continue (le passage garde les autres lignes).

## 10. Quotas

- **Pages** : aucun changement. Tirer, passer un test et le multi-fiches ne consomment aucune page. Générer la banque pendant un scan ne consomme pas de page de plus.
- **Coût** : section 4 (plafond par scan inchangé, `jobCapEur`). Les seuils mensuels et le plafond d'essais dev de 100 EUR priment, comme aujourd'hui.
- **Nouveau plafond (bouton P6 seulement)** : 1 ajout par fiche et par jour, 10 par jour et par élève.
- **Tirages** : `POST /practice/session` et `GET /docs/{id}/session` ouvrent un passage. Pas de plafond de plus (les points sont déjà plafonnés à 250 XP par jour). Lecture : au plus 10 fiches, soit 10 x (2 `Query` de questions + 1 `Query` de `ATT`), environ 30 `Query` d'une centaine d'octets à quelques Ko, de l'ordre de 0,0001 EUR par tirage.

## 11. Droits et confidentialité

| Règle | Détail |
|---|---|
| Élève seulement | `POST /practice/session` : 403 pour un parent. Partition `STUDENT#<sid>` prise du jeton ; aucun paramètre `studentId` |
| Fiches de l'élève seulement | chaque `docId` est lu par `keys.doc(sid, docId)` ; un autre élève ou une autre famille : rangé en `skipped`, indiscernable d'un identifiant inconnu. Un `folderId` d'un autre élève : 404 |
| Parent sans accès aux questions | aucune route parent ne renvoie `prompt`, `choices`, `correctAnswer` ni la banque. `questionCount` est un nombre. L'historique parent reste « juste ou faux par question, sans texte » (H1 P4). Test de contrat : `PracticeSession` n'est lisible que par l'élève (aucune route `/students/{sid}/...` ne la renvoie), et `DocSummary.questionCount` est un entier |
| Pas de fuite par le tirage | `Question` n'a jamais `cle` ni `attendu` ; le tirage n'expose que les questions tirées, jamais le reste de la banque. `answers-post` refuse une question hors de `draw` (section 6) |
| Aucun texte dans les journaux | le tirage journalise seulement le nombre de fiches, la taille demandée et obtenue, jamais un énoncé ni un titre |

**Confidentialité (RGPD).** Rien de nouveau n'est collecté : mêmes affirmations envoyées au même sous-traitant (Bedrock, UE), pas de nouvelle catégorie de donnée, pas de profilage (le tirage n'utilise que « déjà répondu ou non »). Deux points à écrire :
- l'historique garde le **titre du dossier** (nom écrit par l'élève, 200 caractères au plus, nettoyé) et plusieurs fiches par passage : une ligne dans le registre (T5b) et dans la politique (tableau des durées) ;
- la suppression d'une fiche retire seulement ses lignes d'un passage multi-fiches (section 7).

Ces deux modifications sont dans un **commit séparé `docs(legal)`** de cette PR, à valider par Alexis. **`POLICY_VERSION` n'est pas relevé** (décision de fusion à part : les parents déjà inscrits n'ont pas à ré-accepter pour un changement de ce niveau, mais c'est à Alexis d'en juger, point P13). Aucun ID de compte, aucune clé et aucun chemin local dans ce dépôt.

## 12. Tests

**Unitaires (`shared/pool.test.ts`)** : `closeness` sur des paires jugées à la main (même réponse même affirmation : proche ; autre mot masqué : pas proche ; deux fiches avec la même phrase : proche par R2/R3 ; accents et majuscules ignorés) ; `drawQuestions` avec un hasard fixe : pas de doublon, pas de paire proche, jamais répondues d'abord, puis les plus anciennes, test court quand la banque est petite, répartition égale entre fiches, fiche à court qui passe son tour, 10 questions de 10 fiches de 1 question chacune, 1 fiche de 40 questions ; `poolCap` aux bornes (1, 2, 10, 11, 20 faits).
**API** : `session-get` renvoie `size` questions sans clé ; deux tirages de suite sans recoupement ; `answers-post` refuse un `questionId` hors `draw` (409) et accepte celui du tirage ; `POST /practice/session` : parent 403, deux fiches d'un autre élève en `skipped`, dossier d'un autre élève 404, aucune question 409, 11 fiches 400, les deux paramètres 400 ; `TEST#` multi-fiches : `docIds`, `scope`, `rank` dans l'ordre du tirage ; suppression d'une fiche retire ses lignes seulement (test dans `shared/delete-tree.test.ts`).
**Pipeline** : second tour avec faux modèle (`testkit`) : questions retenues, jumelles jetées, budget du job atteint = fiche publiée avec le premier tour, sortie coupée récupérée, aucun appel au modèle de plus que prévu (compter les appels : 3 au total au lieu de 2).
**Contrat** : aucun champ `cle`/`attendu`/`correctAnswer` dans `PracticeSession` ; `docIds` borné à 10 ; exemple valide.
**e2e Playwright (`e2e/tests/08-banque.spec.ts`, mock)** : deux tests de suite sur la même fiche ne partagent aucune question ; choisir 3 fiches, voir les fiches d'origine, finir, retrouver le passage dans « Mes tests » avec « 3 fiches » ; entraînement sur un dossier ; dossier avec une fiche sans question (message et test lancé sur les autres) ; dossier vide (bouton grisé) ; banque trop petite (message « N questions différentes ») ; fiche supprimée pendant un test (la question est sautée) ; **le parent ne voit aucune question** (vue parent après un test multi-fiches : seulement juste/faux) ; un `POST /answers` direct sur une question hors tirage répond 409.
**Mesure réelle (hors CI, point P12)** : 10 fiches de l'échantillon, mode `real`, 2 passages au plus (garde de `docs/cost-guard.md`), budget d'environ 0,05 EUR pour la génération plus l'évaluation à la main des paires proches.

## 13. Découpage en lots (propriétaires de fichiers distincts)

Ordre : **Q1-S** d'abord ; puis **Q1-G** et **Q1-D** en parallèle ; **Q1-W** contre le mock en parallèle de Q1-D ; **Q1-E** à la fin ; **Q1-X** facultatif en dernier.

| Lot | Contenu | Fichiers (propriétaire unique) |
|---|---|---|
| **Q1-C** (cette PR) | conception, commit légal séparé. **Ne touche pas** au contrat | `docs/Q1-design.md`, `docs/legal/**` (registre, politique) |
| **Q1-K** contrat | intégrer la section 8 dans le contrat, **après** la fusion de #82. Un seul lot touche `openapi.yaml` à la fois | `shared/contract/**` |
| **Q1-S** fonctions pures | `closeness`, `drawQuestions`, `poolCap`, normalisation des mots, tests | `shared/pool.ts`, `shared/pool.test.ts` |
| **Q1-G** génération | second tour, prompt `variantes`, contrôle de proximité, écriture des questions suivantes, mesure sur 10 fiches et calibrage des seuils (P12) | `api/src/pipeline/pool-gen.ts` (+ tests), 3 lignes dans `api/src/pipeline/steps-doc.ts` (`generate`), une fonction dans `api/src/pipeline/prompts.ts`, `docs/cost-guard.md` (une ligne : estimation et mesure) |
| **Q1-D** tirage et API | `draw.ts`, `session.ts` (tirage), `answers.ts` (contrôle `draw`), `practice-post`, `PROFILE.currentTest.draw` / `docIds`, `TEST#` multi-fiches, suppression par fiche, `DocSummary.questionCount`, **ROUTES** | `api/src/game/{draw,session,answers,tests}.ts`, `api/src/handlers/{session-get,practice-post,answers-post}.ts`, `api/src/docs/docs.ts` (`questionCount`), `shared/delete-tree.ts` (+ test), `shared/tests-history.ts` (champs facultatifs), `docs/data-model.md`, `infra/lib/api-stack.ts` (**un seul lot touche `infra/`**), `mock/**` |
| **Q1-W** site élève | sélection de fiches, bouton du dossier, choix de la taille, affichage de la fiche d'origine, messages | `web/src/screens/Practice.tsx` (nouveau), `web/src/screens/Quiz.tsx`, une ligne dans `Docs.tsx` et `Folders.tsx`, `web/src/router.ts` (une route), `web/src/api.ts`, `web/src/types.ts` (**un seul lot à la fois**) |
| **Q1-E** e2e | scénarios de la section 12 | `e2e/tests/08-banque.spec.ts`, `e2e/mock-api/server.mjs`, `e2e/support/**` |
| **Q1-X** (facultatif) | « Ajouter des questions » pour les anciennes fiches : handler, compteur `POOL#`, rôle de traitement, test M2 | `api/src/pool/**`, `api/src/handlers/pool-post.ts`, `infra/lib/*` (après Q1-D), `infra/test/m2-bedrock.test.ts` |

**Piège d'ordre et CI verte** (comme H1 section 8) : `infra/test/stacks.test.ts` vérifie que `ROUTES` couvre exactement les routes du contrat. Fusionner Q1-K seul met la CI de `main` au rouge. Donc Q1-K et Q1-D forment une pile : Q1-D est fondée sur Q1-K, et on fusionne Q1-K puis Q1-D dans la foulée, ou Q1-D seule rebasée avec le contrat. `main` ne doit jamais être rouge, et on n'ajoute aucune exception au test.

**Croisements à surveiller**
- **R1 (PR #82)** : la fiche passe en paragraphes (`Doc.body`, `Doc.recall`) et R1 lot A touche aussi `api/src/pipeline/steps-doc.ts` et `prompts.ts`. Q1-G n'ajoute qu'un fichier et 3 lignes à `generate` : à faire **après** le lot A de R1 pour éviter un conflit. Le second tour lit les mêmes affirmations vérifiées, pas la fiche.
- **F10 (PR #84, ajout de pages à un cours)** : une régénération de fiche appelle aujourd'hui `clearDoc(['QCM#', 'GAP#'])` puis réécrit les numéros à partir de 01 : un `questionId` (donc une ligne d'historique) pourrait alors désigner une **autre** question. Avec une banque plus grande, c'est plus fréquent. Règle demandée à F10 et à Q1-G : **ne jamais réutiliser un numéro** ; une régénération ajoute à partir de `max(nn) + 1` et ne supprime que les questions dont l'affirmation a disparu, en laissant un trou (limite : 99 par type).
- **H1** : `recordTest` lit l'ordre de `docQuestions` ; Q1-D le remplace par `currentTest.draw`. Pas de changement de forme des routes H1.

## 14. Points à trancher

Chaque point a une réponse proposée **par défaut** : si vous ne dites rien, c'est elle qui sera faite.

| # | Question en mots simples | Réponse proposée par défaut |
|---|---|---|
| **P1** | Combien de questions prépare-t-on par fiche ? | Environ **deux questions pour chaque fait vérifié**, jusqu'à 20 QCM et 20 textes à trous (40 au plus). Une fiche à 4 faits aura jusqu'à 16 questions |
| **P2** | Combien de questions dans un test ? | **10** par défaut. L'élève peut choisir 5, 10, 15 ou 20 |
| **P3** | Que faire si la fiche n'a pas assez de questions vraiment différentes ? | Le test est **plus court**, avec un message (« cette fiche n'a que 6 questions différentes »). On ne repose jamais une question qui ressemble à une autre du même test, même pour faire le compte |
| **P4** | Quand reproposer une question déjà posée ? | **Seulement quand toutes les autres ont été posées.** Ensuite, on reprend d'abord les plus anciennes. Une question qu'on a vue sans y répondre n'est pas comptée comme posée |
| **P5** | Les nouvelles questions rapportent-elles des points ? | **Oui**, comme les autres : une fois par question, dans la limite de 250 points par jour. Une fiche peut donc rapporter jusqu'à environ 200 points en tout au lieu de 50. Alternative : limiter à 50 points par fiche |
| **P6** | Les fiches déjà créées ont peu de questions. Ajoute-t-on un bouton pour en créer d'autres ? | **Oui, mais plus tard** (lot facultatif Q1-X). Environ 0,14 centime par fiche, une fois par fiche et par jour, 10 par jour et par élève |
| **P7** | Comment partager les questions entre plusieurs fiches ? | **À parts égales** entre les fiches (10 fiches au plus). Un dossier de plus de 10 fiches : on prend les 10 les moins travaillées récemment |
| **P8** | Que fait-on des fiches d'un dossier qui n'ont pas de questions, ou qui ont été supprimées ? | On les **saute** et on le dit avant de commencer (« 2 fiches n'ont pas encore de questions »). Si aucune fiche n'a de question, le bouton est grisé |
| **P9** | Comment garder dans l'historique un test fait sur plusieurs fiches ? | **Un seul passage** (« Dossier Histoire, 12 questions »). Si on supprime une des fiches, on enlève seulement ses questions du passage ; le passage disparaît s'il n'en reste plus aucune |
| **P10** | L'application peut-elle refuser une réponse à une question qui n'est pas dans le test en cours ? | **Oui.** Sinon un élève pourrait deviner une question et voir sa réponse sans jouer. Conséquence : il faut ouvrir un test avant de répondre |
| **P11** | Le parent voit-il quelque chose de plus ? | Seulement **le nombre de questions** de chaque fiche et le nom du dossier ou « 3 fiches » dans l'historique. Jamais une question ni une réponse |
| **P12** | Mesure-t-on avant de décider des seuils de ressemblance et du coût ? | **Oui**, sur 10 vraies fiches, avec un coût d'environ 5 centimes, avant d'ouvrir la fonction. Les chiffres de ce document sont des estimations |
| **P13** | Les textes légaux changent un peu (titre du dossier, plusieurs fiches dans un passage). Fait-on ré-accepter la politique aux parents ? | **Non** : commit séparé à relire, version de la politique **non relevée**. À vous de décider si cela mérite une ré-acceptation |
