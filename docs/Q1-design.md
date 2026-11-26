# Q1 : banque de questions variées (#42) et « S'entraîner » sur plusieurs fiches ou un dossier (#72)

Statut : **conception**, aucun code écrit. Révision 2 : corrections de la relecture indépendante (B1, B2, M1 à M21) et décision du propriétaire sur P5 (50 points par fiche). Le contrat d'API n'est **pas** modifié par cette PR : la PR #82 est fusionnée (contrat 1.5.0 sur `main`), mais le contrat proposé reste dans la section 8, à intégrer par le lot Q1-K.
Dépend de : H1 (historique des tests, `docs/H1-design.md`, fusionné) ; croise R1 (PR #82 fusionnée ; ses lots R1-A et R1-B, PR #91 pour R1-B) et F10 (conception fusionnée) : voir section 13.
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
| Question QCM / trou | `DOC#<docId>` / `QCM#<nn>`, `GAP#<nn>` | **Inchangé.** `nn` va jusqu'à 40 par type en pratique (limite de format 99). Les numéros ne sont **jamais réutilisés** : une question retirée laisse un trou (voir section 13) |
| Taille de la banque | `DOC#` de l'élève (la fiche) | **Compteur `nbQuestions` écrit sur la fiche** par `generate` (fin de la génération) et par Q1-X (après un ajout). Affiché par `DocSummary.questionCount` (section 8). `GET /docs` ne lit donc aucune question. Fiche ancienne sans compteur : `questionCount` absent (le site ne grise pas le bouton ; une fiche sans question est signalée par `skipped` au tirage). Schéma : champ facultatif `nbQuestions` de `FicheItemSchema` (`shared/items.ts`) |
| Questions déjà vues | `ATT#<questionId>#<jour>` (existant) | **Aucun nouvel élément.** Le tirage lit `ATT#<docId>:` en préfixe : « vue » = a une ligne `ATT`, « dernière fois » = le jour le plus récent. **Un attribut `xp` s'ajoute** : les points payés pour cette question **après** le plafond de fiche et **avant** le plafond quotidien (définition en section 7), pour le plafond de 50 XP par fiche |

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
0. **Garde d'entrée** : pas de second tour si `eligible.size === 0` (aucun fait vérifié : `generate` appelle `makeQuestions` dès que `forSummary.size > 0`, donc il faut cette garde, sinon `poolCap(0)` vaut 1 et on paie un appel pour rien), ni si le premier tour n'a produit aucune question, ni si `generate` a déjà consommé plus de 120 s de ses 240 s (`TASK_TIMEOUT_S.generate`). Un test pour chacun des trois cas.
1. mêmes validations que le premier tour (`validQcm`, `validGap` : `claimId` dans l'ensemble des affirmations vérifiées, mot masqué copié de l'affirmation, 4 choix différents) ;
2. **contrôle de proximité** (section 5) contre toutes les questions déjà retenues, premier tour compris ; les questions trop proches sont jetées ;
3. **contrôle à l'aveugle des nouveaux QCM** par le même appel `controle-qcm` qu'aujourd'hui (une seule fois pour tous les nouveaux QCM) ; un QCM dont la réponse ne concorde pas est rejeté ;
4. **écriture à partir de `max(nn) + 1`** (jamais de `clearDoc` pour le second tour), avec la condition `attribute_not_exists(PK)` pour qu'une reprise n'écrase aucune question déjà publiée ; arrêt à `nn = 99` (limite du format `[0-9]{2}` ; `poolCap` plafonne à 40 par type, donc la limite n'est atteinte que par des ajouts répétés de Q1-X, qui s'arrête alors sans erreur et le dit à l'élève) ; `shuffleChoices(q.choix, q.cle, qid)` comme aujourd'hui ; puis mise à jour de `nbQuestions` sur la fiche.

**Reprise de `generate`** : le premier tour garde son `clearDoc(['QCM#','GAP#'])` en tête de `generate` (la fiche n'est pas encore publiée, aucun élève n'a répondu, aucun `questionId` n'existe dans un historique). Le second tour n'efface jamais. Si Step Functions rejoue `generate` avant publication, tout est refait proprement (premier tour et banque) ; une fois la fiche publiée, la reprise ne fait plus rien (c'est déjà le cas).

**Le second tour absorbe toute erreur d'appel de modèle** : plafond du job ou garde de coût (`JobBudgetExceededError`, `CostBlockedError`), sortie illisible (`ModelOutputError`, avec `salvageTruncatedList` pour une sortie coupée), mais aussi limitation de débit Bedrock, délai dépassé ou toute autre erreur levée par `callModel`. Elle est journalisée (nom de la classe d'erreur seulement, jamais un texte) et **la fiche est publiée avec la banque du premier tour**. Sans cela, une erreur du second tour ferait échouer `generate`, que Step Functions rejoue : `clearDoc`, puis le premier tour et son contrôle seraient payés de nouveau. Seules les erreurs d'écriture DynamoDB ne sont pas absorbées. Rien n'est perdu, rien n'échoue à cause de la banque.

### Coût estimé (non mesuré)
Prix de `shared/pricing.ts` : Haiku à 0,11 USD (entrée) et 0,55 USD (sortie) par million de jetons, 1 USD = 0,912 EUR.

| Appel | Entrée | Sortie | Coût |
|---|---|---|---|
| Second tour (variantes), **un seul appel**, `maxTokens: 6000` | environ 2 100 jetons (30 affirmations, 10 énoncés déjà faits, consigne) | environ 1 800 à 2 800 jetons (de 20 à 40 questions) | environ 0,0012 EUR (10 + 10) à 0,0020 EUR (20 + 20) |
| Contrôle à l'aveugle des nouveaux QCM | environ 1 100 à 2 200 jetons | environ 150 à 200 jetons | environ 0,0002 à 0,0004 EUR |
| **Total par fiche : 4 appels au lieu de 2** (`generation`, `controle-qcm`, `variantes`, `controle-qcm`) | | | **environ 0,0014 EUR** (au plus environ 0,003 EUR pour une fiche à 20 + 20) |

`maxTokens` : 4 000 jetons suffisent pour environ 20 questions (10 + 10), pas pour 40 (80 à 100 jetons chacune). Valeur de départ **6 000** (sous la limite de 8 192 de `shared/bedrock.ts`). Si la mesure P12 montre des sorties coupées, passer à **deux appels** (QCM puis trous) ; la banque réelle sera de toute façon plus petite que `poolCap`.

Comparaison : le coût mesuré d'un scan est d'environ 0,09 EUR **par page**. Une fiche de 6 sections ajoute au plus 6 x 0,003 = **0,02 EUR**. Cela reste très en dessous des 6 centimes gardés par `GEN_RESERVE_CENTS`. **Le plafond par scan `jobCapEur(pages)` est inchangé, mais il n'est pas une borne stricte** : la garde refuse un appel seulement quand le plafond est **déjà** atteint, donc le dernier appel peut le franchir d'un appel (comportement actuel, non aggravé) : le second tour passe par `callModel`, donc par la garde (`jobSpentEur` obligatoire, refus avant l'appel). Aucune limite du garde de coût n'est touchée.

**Délais (non mesurés)** : `generate` a `TASK_TIMEOUT_S.generate = 240` s et un Lambda de 3 minutes (`pipeline-stack.ts`). Deux appels Haiku de plus, dont un long (jusqu'à 6 000 jetons de sortie), ne sont pas mesurés : à ajouter à la mesure P12 et au point « revue des délais » de R1-B. La garde d'entrée de 120 s (étape 0) protège la fiche en attendant.

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

**Lectures du tirage (borne)** : au plus 10 fiches. Pour un dossier de plus de 10 fiches (P7, « les 10 les moins travaillées »), **une seule `Query` sur `TEST#` de l'élève, du plus récent au plus ancien, 100 entrées au plus** (environ 150 Ko), donne la dernière date de test de chaque fiche (une fiche absente = jamais travaillée = prioritaire) ; elle remplace toute lecture de `ATT` pour les 25 fiches. Puis, pour les 10 fiches retenues seulement : 2 `Query` de questions (`QCM#`, `GAP#`) et 1 `Query` `ATT#<docId>:` chacune. Total : au plus 1 + 1 (liste des fiches du dossier) + 30 `Query`.

1. **Tour de rôle entre fiches (parts égales).** Les fiches sont prises une à une dans un ordre mélangé. Chaque fiche a sa propre file : d'abord ses questions **jamais répondues** (QCM et trous en alternance), puis ses questions déjà répondues, **les plus anciennes d'abord** (égalité au hasard). À son tour, une fiche donne la prochaine question de sa file qui n'est proche (section 5) d'aucune question déjà tirée. Une fiche à court passe son tour. On s'arrête à `size`.
2. **Conséquence (décision du propriétaire sur le relecteur m1).** Les parts égales passent avant « jamais répondues d'abord » **entre fiches** : une fiche entièrement vue redonne ses questions les plus anciennes même si une autre fiche a encore des questions jamais posées. **Dans une même fiche**, une question déjà vue n'est reprise qu'une fois toutes les autres de cette fiche posées (le « tant que la banque n'est pas épuisée » de l'issue). C'est ce que fait `drawQuestions` (`shared/pool.ts`).
3. **Mélange final** de l'ordre (le serveur garde cet ordre, il devient le `rank` de l'historique). **Comportement qui change pour toutes les fiches, même anciennes** : aujourd'hui le site pose les QCM puis les trous dans l'ordre des numéros ; avec le mélange, l'ordre change à chaque test. C'est voulu (« tirage aléatoire à chaque test », #42).
4. Si `size` n'est pas atteint (banque trop petite ou trop de jumelles), le test est **plus court** et la réponse porte `short: true` avec `available` (voir P3). On ne complète jamais avec une question proche.

Conséquences vérifiables : deux tests de suite sur une banque de 20 questions et `size` 10 ne partagent aucune question ; un troisième reprend d'abord les plus anciennes de la fiche ; un test ne contient jamais deux questions que `closeness` déclare proches ; une fiche d'un test multi-fiches n'a jamais plus d'une question d'écart avec une autre tant que toutes ont des questions disponibles.

La liste tirée est enregistrée dans `PROFILE.currentTest.draw` dans l'écriture de `PROFILE` que `session-get` fait déjà (aucune écriture de plus).

**Contrôle à la réponse (anti-triche).** Aujourd'hui `answers-post` accepte n'importe quel `questionId` d'une fiche de l'élève. Avec une banque, un élève pourrait deviner `fiche:qcm:17` et la réponse lui montrerait la bonne réponse sans jamais passer par un tirage. Règle ajoutée : **`answers-post` n'accepte qu'un `questionId` présent dans `currentTest.draw`** (sinon 409 `etat_invalide`, message « Ouvre d'abord un test »). Cela change le cas 2 de H1 (« réponse sans session ouverte = passage implicite ») : il disparaît. Point P10.

**Règles précises du contrôle `draw` (P10)** :
1. **Un seul pointeur par élève.** `PROFILE.currentTest` est unique : avec deux onglets ou deux fiches ouvertes en même temps, le dernier `GET /session` ou `POST /practice/session` gagne. L'onglet qui a perdu reçoit **409** à chaque réponse. Le site, sur un 409 de `POST /answers`, **rouvre une session** (nouveau tirage, message « Ton test a été rouvert ailleurs, on reprend ici ») ; il ne boucle pas.
2. **Le pointeur expire.** Une réponse n'est acceptée que si la question est dans `draw` **et** que la dernière réponse ou ouverture date de moins de 3 h (`TEST_GAP_MS`). Passé ce délai : 409 « Ton test a expiré, rouvre-le ». Il n'y a donc **plus de passage implicite** : `recordTest` ne crée plus de passage à la volée, et ce code (cas 2 de `docs/H1-design.md` §2) est retiré. Le passage en cours garde `draw`, `docIds`, `scope` jusqu'à son remplacement.
3. **409 contre 429.** `etat_invalide` est déjà renvoyé avec un **429** pour « Trop rapide ». Le site distingue par le **statut** (429 : réessayer dans une seconde ; 409 : rouvrir le test), jamais par le seul code. Pas de nouveau code d'erreur.
4. **Rechargement.** Recharger `/quiz/<docId>` ou `/entrainement` ouvre un **nouveau tirage** ; l'ancien passage reste dans l'historique (les questions non répondues ne comptent pas comme vues, voir P4).
5. **Ouvrir une session remet la série à zéro.** `POST /practice/session` fait la même chose que `session-get` : `tick`, `series = newSeries(now)`, `currentTest`. Sans cela, la série du test précédent continuerait. Un test de 15 questions donne **une** série de 10 payée et 5 réponses qui ne forment pas de série (perdues à la prochaine ouverture) : accepté, la série reste un bonus de jeu.
6. **Fiche supprimée pendant un test** : `answers-post` relit la fiche dans `mutate` (un `GetItem`), donc une réponse déjà en vol ne crée pas de ligne pour une fiche supprimée.

Le `rank` et `total` de H1 deviennent : `rank` = position dans `draw`, `total` = `draw.length` (au lieu de `docQuestions`).

## 7. Interaction avec l'historique des tests (H1, #44) et les points

- Le passage reste **une entrée `TEST#`**, une par test, quel que soit le nombre de fiches. `scope`, `docIds`, `titre` : section 3. `mode` reste `mixte`/`qcm`/`gap` (H1 §9 prévoyait `tirage` ; ce n'est pas nécessaire, le tirage est le comportement normal).
- La vue **parent** de H1 est inchangée : résultat juste/faux par `questionId` et `rank`, jamais de texte. Elle gagne seulement `docIds` et `scope` dans le résumé.
- **Suppression d'une fiche** (H1 P2) : voir « Effacement d'un passage multi-fiches » ci-dessous. Pour un test d'**une** fiche, rien ne change : `deleteDocTree` supprime le passage comme aujourd'hui.
- Un `questionId` qui n'existe plus (question retirée à la régénération) : `prompt` absent dans `TestDetail`, le front affiche « question retirée » (H1 §9, déjà prévu).
- **Points (XP), décision du propriétaire sur P5 : 50 points au plus par fiche, au total.** La règle « une récompense par question pour toujours » reste, et s'y ajoute un **plafond de 50 XP par fiche pour toute la vie de la fiche** (`DOC_XP_CAP = 50`, constante de `api/src/game/rules.ts`). 50 XP correspond à ce qu'une fiche pouvait déjà rapporter avec ses 10 questions (10 x 5) : **aucune fiche existante ne perd de points**, et une banque plus grande n'en rapporte pas plus. Le plafond quotidien de 250 XP, le délai de 1 s, les 20 s pour une série de 10 et la quarantaine au-delà de 100 bonnes réponses en 10 minutes ne changent pas.
  - **Ce qui compte dans les 50** : seulement les points de réponse à une question de la fiche (QCM 5 ou 2, trou 5). Ne comptent pas : le bonus de série (+20, +30, calculé par série et non par fiche), les 10 XP par page scannée, les 8 XP de révision et les 15 XP de signalement.
  - **Calcul** : dans `mutate` de `answers-post`, le serveur lit déjà `ATT#<questionId>#` ; il lit en plus `ATT#<docId>:` (même `Query` que celle du tirage, lecture cohérente), calcule `payé = somme des xp des lignes ATT de la fiche`, puis `restant = 50 - payé`.
  - **Définition de `xp`** : `xp = min(gain normal de la question, restant)`, calculé **après** le plafond de fiche et **avant** le plafond quotidien de 250 XP et la quarantaine (`credit()` rogne ensuite le gain réellement ajouté au profil). Sinon, un jour déjà à 250 XP « libérerait » des points de fiche que `rewarded` a pourtant fermés pour toujours. `rewarded` est vrai si `xp > 0` ; au-delà du plafond de fiche, `xp = 0` et `rewarded` reste faux. La ligne `ATT` écrite porte `xp`.
  - **Anciennes lignes (sans `xp`)** : comptées **5 si `rewarded`**, sinon 0 (valeur haute). Un QCM payé 2 au 2e essai est donc compté 3 de trop : une ancienne fiche peut afficher « 50 sur 50 » alors qu'elle n'a rapporté que 35, et **un ajout de questions (Q1-X) sur cette fiche ne rapportera rien de plus**. Aucun point déjà gagné n'est retiré ; c'est le reste à gagner d'anciennes fiches qui est sous-estimé, d'au plus 15 XP. Accepté, dit dans P5.
  - **Le plafond suit le `docId`, pas le contenu (décision, relecteur m4).** Supprimer une fiche puis rescanner le même cours crée une **nouvelle fiche**, donc un nouveau plafond de 50 XP. Cela coûte des pages de quota et une génération, et le plafond quotidien de 250 XP reste. Accepté : les lignes `ATT` d'une fiche supprimée restent, le `docId` n'est jamais réutilisé, et suivre le contenu demanderait de comparer les cours entre eux (donnée de plus à garder).
  - **Au-delà du plafond** : la réponse reste corrigée (juste ou fausse, essais, historique de test), `xpGained = 0`, et la ligne `ATT` n'est pas marquée `rewarded`. Aucune limite d'essais ne change. Le plafond ne baisse jamais, donc une question refusée aujourd'hui ne sera jamais payée plus tard.
  - **Deux réponses en même temps** : `mutate` est conditionnel à la version de `PROFILE`, chaque réponse écrit `PROFILE`, donc les réponses d'un même élève passent l'une après l'autre (3 essais, puis 409 « Réessaie » : comportement actuel) ; le calcul est refait à chaque rejeu. Pas de dépassement possible de 50. Suppression d'une fiche : ses lignes `ATT` restent (non supprimées par `deleteDocTree`) mais le `docId` n'est jamais réutilisé, donc aucun effet sur une autre fiche. Le plafond est **par fiche**, dans un dossier comme pour une fiche seule (le `docId` fait partie du `questionId`).
  - **Série de 10 (correction B1)** : dans le code actuel, une réponse compte pour la série si `att.attempts === 1 && !paidBefore && sessionToday`. Une question refusée par le plafond de fiche n'est pas `rewarded`, donc `paidBefore` resterait faux et sa première tentative de chaque jour compterait pour la série : sur une fiche pleine, 10 réponses (même fausses) rapporteraient +20 XP (+30 si parfaites) chaque jour. **Règle : la réponse ne compte pour la série que si la question peut encore rapporter**, c'est-à-dire `!paidBefore && restant > 0` (`restant` de la fiche **avant** cette réponse). Une réponse sur une fiche pleine ne fait avancer ni `series.n`, ni `perfect`, ni `risky`, et ne remet rien à zéro. Un test sur une fiche pleine donne donc 0 bonus de série ; un test sur un dossier dont 3 fiches sur 5 sont pleines ne compte que les réponses des 2 autres. (Une question jamais payée d'une fiche non pleine, par exemple ratée à chaque essai, garde le comportement d'aujourd'hui : borné par les 50 XP de la fiche et le plafond quotidien.)
  - **Anti-triche** : la règle s'ajoute à la liste de `docs/game-rules.md` section 7 (point 10, « 50 XP par fiche au plus, et la série ne compte que les questions qui peuvent encore rapporter »). Le tirage ne favorise ni les fiches pleines ni les autres : il tire sur la banque. La ligne `ATT` n'est jamais renvoyée au site ni au parent : `family.ts` projette explicitement `questionId`, `date`, `attempts` (test : `xp` ne sort pas dans l'export).
  - **Affichage** : `Session.xpRemaining` et `AnswerResult.capped` (section 8) permettent de dire « Tu as gagné tous les points de cette fiche (50 sur 50). Tu peux continuer pour t'entraîner. » La série de 10 reste payable **sur les fiches qui ont encore des points**.
- Une série (`SERIES_LENGTH = 10`) correspond à 10 réponses **qui comptent** (règle B1 ci-dessus) : un test de 20 questions donne au plus deux séries.

### Effacement d'un passage multi-fiches (correction B2)

`deleteDocTree` supprime aujourd'hui les `TEST#` dont `docId === docId`, et son port `TreeDb` n'a que `list` et `remove`. Avec un passage multi-fiches (`docId` = la première fiche), supprimer la première fiche efface tout le passage et supprimer une autre n'efface rien : la promesse « effacé tout de suite » serait fausse. Le lot Q1-D (propriétaire de `shared/delete-tree.ts`) fait donc :

1. **Port étendu.** `TreeKey` gagne `docIds?: string[]` (la projection de `dynamoTreeDb.list` devient `PK, SK, studentId, docId, docIds`). `TreeDb` gagne `mutateTest(key, fn)` : lit l'élément (lecture cohérente), applique `fn(item)` qui renvoie `'supprimer'`, `'garder'` ou l'élément réécrit, puis écrit avec une **condition sur la version** (`v = :lue`) ; sur `ConditionalCheckFailed`, relit et recommence (**5 essais** avec attente exponentielle comme `remove`, puis erreur « suppression incomplète », jamais d'oubli silencieux). `memoryTreeDb` l'implémente avec une version, pour que les tests simulent une réponse concurrente.
2. **Règle dans `deleteDocTree`.** Pour chaque `TEST#` de l'élève :
   - `docIds` absent ou de longueur 1 et `docId` égal : suppression du passage (comme aujourd'hui) ;
   - `docIds` contient `docId` (passage multi-fiches) : `mutateTest` retire de `items[]` les lignes dont `q` commence par `<docId>:`, retire `docId` de `docIds`, puis **recalcule** `answered`, `correct`, `firstTry`, `xpGained`, `mode` à partir des lignes restantes. S'il ne reste **aucune ligne** : suppression du passage (la **dernière fiche** efface donc le passage). `docId` devient la première fiche restante. `total` : si le passage était complet (`answered = total`), `total` = nombre de lignes restantes ; sinon `max(lignes restantes, total - lignes retirées)` (valeur approchée : le tirage n'est pas stocké dans `TEST#`, on ne sait pas quelles questions non répondues venaient de la fiche). `scope` : s'il reste **une** seule fiche, `scope = fiche` ; pour `scope = fiches`, `titre` est recalculé (« 2 fiches », puis « 1 fiche » quand il n'en reste qu'une) ; pour `dossier`, il reste le nom du dossier (un nom, pas un nombre) ;
   - la clé `SK` ne change pas (elle ne dépend que de l'heure et du `testId`).
3. **`deleteStudentTree` et `deleteFamilyTree`** passent par `deleteDocTree` pour chaque fiche, puis suppriment tout ce qui n'est pas `DOC#` dans la partition de l'élève (donc tous les `TEST#`). Pour ne pas réécrire des passages supprimés juste après, `deleteDocTree` reçoit une option `{ garderTests: true }` que ces deux fonctions utilisent : aucun `mutateTest` n'est appelé pendant la suppression d'un élève ou d'une famille.
4. **Ordre.** `deleteDocTree` supprime d'abord la fiche et ses questions, puis réécrit les passages ; une réponse en vol sur cette fiche échoue à son tour (fiche relue dans `mutate`, section 6).

Tests (`shared/delete-tree.test.ts`) : supprimer la **première** fiche d'un passage de 3 fiches (le passage reste avec 2 fiches, `docId` = la 2e, compteurs recalculés) ; supprimer une **autre** fiche (ses lignes disparaissent, le passage reste) ; supprimer la **dernière** fiche restante (le passage disparaît) ; **réponse concurrente** (le port simule un conflit de version : la réécriture est refaite sur l'élément relu, une ligne ajoutée entre-temps n'est pas perdue) ; 5 conflits de suite : erreur levée ; passage d'une seule fiche : supprimé comme avant ; `deleteStudentTree` et `deleteFamilyTree` : aucun `TEST#` ne reste, **y compris multi-fiches**, et `mutateTest` n'est jamais appelé.

## 8. Contrat proposé (additif, **non appliqué** : à intégrer par le lot Q1-K)

Version : **le numéro est pris à la fusion du lot contrat Q1-K, dans l'ordre d'arrivée** : 1.6.0 pour le premier lot contrat fusionné (F10 ou Q1), 1.7.0 pour le suivant (ID1 prévoit 1.7.0 « après eux »), 1.8.0 pour le troisième. Aucun numéro n'est figé ici. Aucun champ obligatoire nouveau, aucune route existante modifiée de façon incompatible. `npm run gen` obligatoire après toute modification de `openapi.yaml`, même d'un exemple.

### 8.1 `GET /docs/{docId}/session` (route existante)
Paramètre de requête facultatif `size` (`5`, `10`, `15`, `20`, défaut `10`). Réponse `Session` (champs ajoutés, tous facultatifs) :

| Champ | Type | Sens |
|---|---|---|
| `available` | integer | nombre de questions distinctes utilisables dans la banque (hors proches) |
| `short` | boolean | `true` si moins de questions que demandé |
| `xpRemaining` | integer (0 à 50) | points encore gagnables sur la fiche (`50 - payé`) |

Un client 1.5 qui ignore ces champs reçoit simplement 10 questions au plus (il en recevait déjà 10 au plus).

### 8.2 `POST /practice/session` (route nouvelle, élève seulement)
Corps `PracticeRequest` : exactement **un** de `docIds` (1 à 10 identifiants, **motif `^[A-Za-z0-9_-]{1,64}$`**, le même que `shared/delete-tree.ts`, parce que le `docId` sert ensuite de préfixe de requête `ATT#<docId>:`) ou `folderId` (même motif), plus `size` facultatif comme ci-dessus. Réponse 200 `PracticeSession` :

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
    xpRemaining:
      type: array
      description: "Points encore gagnables par fiche (50 au plus par fiche)"
      items: { type: object, required: [docId, xpRemaining], properties: { docId: { type: string }, xpRemaining: { type: integer, minimum: 0, maximum: 50 } } }
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

### 8.2 bis `AnswerResult`
Champ facultatif `capped` (boolean) : `true` si la réponse aurait rapporté des points mais que la fiche a atteint 50 XP. `xpGained` vaut alors 0.

### 8.3 `DocSummary`
Champ facultatif `questionCount` (integer, taille de la banque de la fiche). C'est un **nombre**, jamais un contenu : visible aussi par le parent.

### 8.4 `TestSummary` / `TestParentDetail` / `TestDetail` (H1)
`TestSummary` gagne `scope` (`fiche`, `fiches`, `dossier`) et `docIds` (tableau, 10 au plus). `docId` reste présent (première fiche). Les lignes `TestQuestionStatus` et `TestQuestionResult` n'ont pas de champ nouveau : leur `questionId` contient le `docId`. `TestQuestionResult` (élève) garde seule `choice`. **Description à mettre à jour** : `TestSummary.titre` est décrit dans le contrat 1.4 comme « titre de la fiche (copie, supprimée avec la fiche) » ; il devient « titre de la fiche, nom du dossier ou `N fiches` (copie ; pour un passage multi-fiches, seules les lignes de la fiche supprimée partent) ». `skipped[].title` n'est renseigné que pour une fiche **de l'élève** (jamais pour un `docId` inconnu ou d'un autre élève).

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
- **Tirages** : `POST /practice/session` et `GET /docs/{id}/session` ouvrent un passage. Pas de plafond de plus : les points sont plafonnés à 250 XP par jour et à 50 XP par fiche (section 7). Lectures : borne de la section 6 (au plus 32 `Query`, de quelques Ko chacune), de l'ordre de 0,0001 EUR par tirage.

## 11. Droits et confidentialité

| Règle | Détail |
|---|---|
| Élève seulement | `POST /practice/session` : 403 pour un parent. Partition `STUDENT#<sid>` prise du jeton ; aucun paramètre `studentId` |
| Fiches de l'élève seulement | chaque `docId` est lu par `keys.doc(sid, docId)` ; un autre élève ou une autre famille : rangé en `skipped`, indiscernable d'un identifiant inconnu. Un `folderId` d'un autre élève : 404 |
| Parent sans accès aux questions | aucune route parent ne renvoie `prompt`, `choices`, `correctAnswer` ni la banque. `questionCount` est un nombre. L'historique parent reste « juste ou faux par question, sans texte » (H1 P4). Test de contrat : `PracticeSession` n'est lisible que par l'élève (aucune route `/students/{sid}/...` ne la renvoie), et `DocSummary.questionCount` est un entier |
| Pas de fuite par le tirage | `Question` n'a jamais `cle` ni `attendu` ; le tirage n'expose que les questions tirées, jamais le reste de la banque. `answers-post` refuse une question hors de `draw` (section 6) |
| Aucun texte dans les journaux | le tirage journalise seulement le nombre de fiches, la taille demandée et obtenue, jamais un énoncé ni un titre |
| Rôle de la nouvelle fonction | **Décision (relecteur m2) : `practice-post` partage le rôle `play` de `session-get` et `answers-post`** (lecture de `DOC#*` et `STUDENT#*`, écriture `FAMILY#*`/`STUDENT#*`, aucun joker d'action). Un rôle dédié limité à l'écriture de `PROFILE` n'est pas fait : IAM ne filtre pas la clé de tri, donc il n'apporterait pas d'isolation réelle. À reprendre si IAM le permet un jour |

**Confidentialité (RGPD).** Rien de nouveau n'est collecté : mêmes affirmations envoyées au même sous-traitant (Bedrock, UE), pas de nouvelle catégorie de donnée, pas de profilage (le tirage n'utilise que « déjà répondu ou non »). Deux points à écrire :
- l'historique garde le **titre du dossier** (nom écrit par l'élève, 200 caractères au plus, nettoyé) et plusieurs fiches par passage : une ligne dans le registre (T5b) et dans la politique (tableau des durées) ;
- la suppression d'une fiche retire seulement ses lignes d'un passage multi-fiches (section 7).

Aucune règle de points n'apparaît dans les textes légaux (les points ne sont pas une donnée supplémentaire) : le commit légal ne change donc pas avec la décision sur P5. Ces deux modifications sont dans un **commit séparé `docs(legal)`** de cette PR, à valider par le propriétaire. **`POLICY_VERSION` n'est pas relevé** (décision de fusion à part : les parents déjà inscrits n'ont pas à ré-accepter pour un changement de ce niveau, mais c'est au propriétaire d'en juger, point P13). Aucun ID de compte, aucune clé et aucun chemin local dans ce dépôt.

## 12. Tests

**Unitaires (`shared/pool.test.ts`)** : `closeness` sur des paires jugées à la main (même réponse même affirmation : proche ; autre mot masqué : pas proche ; deux fiches avec la même phrase : proche par R2/R3 ; accents et majuscules ignorés) ; `drawQuestions` avec un hasard fixe : pas de doublon, pas de paire proche, jamais répondues d'abord, puis les plus anciennes, test court quand la banque est petite, répartition égale entre fiches, fiche à court qui passe son tour, 10 questions de 10 fiches de 1 question chacune, 1 fiche de 40 questions ; `poolCap` aux bornes (1, 2, 10, 11, 20 faits).
**Points (plafond de 50 par fiche)** : une fiche à 40 questions : les bonnes réponses paient jusqu'à 50 XP puis 0 (`capped: true`, juste ou faux inchangé) ; une fiche à 10 questions paie comme avant (10 x 5 = 50) ; un QCM payé 2 au 2e essai compte 2 ; `xp` est le gain après plafond de fiche et **avant** plafond quotidien (un jour à 250 XP : `xp` de la ligne reste le gain de fiche, `xpGained` = 0) ; ligne `ATT` ancienne sans `xp` : comptée 5 si `rewarded`, 0 sinon ; deux fiches : plafond par fiche, pas global ; une fiche supprimée puis une autre : plafond propre à chaque fiche ; plafond par fiche dans un test sur un dossier ; bonus de série +20/+30 payés hors des 50 ; 250 XP par jour toujours appliqué en plus ; deux réponses rejouées après conflit ne dépassent pas 50 ; une question refusée n'est pas marquée `rewarded` ; `xp` ne sort ni dans la réponse, ni dans l'export, ni dans la vue parent. **Série (B1)** : 10 réponses sur une fiche pleine = **0 bonus** (ni +20 ni +30, `series.n` inchangé) ; 10 réponses réparties sur une fiche pleine et une non pleine : seules celles de la seconde comptent ; fiche presque pleine (restant 5) : la réponse qui atteint 50 compte, les suivantes non.
**API** : `session-get` renvoie `size` questions sans clé ; deux tirages de suite sans recoupement ; `answers-post` refuse un `questionId` hors `draw` (409), accepte celui du tirage, refuse après 3 h (409), refuse après l'ouverture d'un autre test (deux onglets) et ne crée plus de passage implicite ; 429 « trop rapide » toujours distinct du 409 ; `POST /practice/session` : parent 403, fiches d'un autre élève en `skipped` sans titre, dossier d'un autre élève 404, aucune question 409, 11 fiches 400, les deux paramètres 400, `docId` hors motif 400, remise à zéro de `tick` et `series`, dossier de 25 fiches : les 10 les moins récemment travaillées ; `TEST#` multi-fiches : `docIds`, `scope`, `rank` dans l'ordre du tirage ; effacement multi-fiches : section 7.
**Tests existants à adapter (P10)** : `api/src/game/game.test.ts` (une trentaine d'appels à `postAnswer` sans session ouverte, dont « sans session ouverte, la première réponse est acceptée » : ils ouvrent d'abord une session), `api/src/game/tests.test.ts` (« une réponse sans session ouverte crée un passage implicite » : à supprimer ou inverser en 409), `api/src/family/family.test.ts`, `api/src/handlers/handlers.test.ts`. Le code « passage implicite » de `recordTest` est retiré, pas laissé mort. Côté site, `Quiz.tsx` appelle déjà `api.session` avant de répondre : pas de régression.
**Pipeline** : second tour avec faux modèle (`testkit`) : questions retenues, jumelles jetées, **toute** erreur d'appel (plafond du job, garde de coût, sortie illisible, limitation de débit, délai) = fiche publiée avec le premier tour sans relance de `generate`, sortie coupée récupérée, **4 appels au modèle au total au lieu de 2** (`generation`, `controle-qcm`, `variantes`, `controle-qcm`), 2 si le second tour est sauté ; **pas de second tour** sans fait vérifié, ni si le premier tour est vide, ni après 120 s ; numérotation à partir de `max(nn)+1`, aucun écrasement à la reprise (`attribute_not_exists`), arrêt à 99 ; `nbQuestions` écrit sur la fiche.
**Contrat** : aucun champ `cle`/`attendu`/`correctAnswer` dans `PracticeSession` ; `docIds` borné à 10 ; exemple valide.
**e2e Playwright (`e2e/tests/08-banque.spec.ts`, mock ; le faux serveur `e2e/mock-api/server.mjs` doit d'abord apprendre le contrôle du tirage et `POST /practice/session`, sinon le scénario « hors tirage = 409 » passe à vide)** : deux tests de suite sur la même fiche ne partagent aucune question ; choisir 3 fiches, voir les fiches d'origine, finir, retrouver le passage dans « Mes tests » avec « 3 fiches » ; entraînement sur un dossier ; dossier avec une fiche sans question (message et test lancé sur les autres) ; dossier vide (bouton grisé) ; banque trop petite (message « N questions différentes ») ; fiche supprimée pendant un test (la question est sautée) ; une fiche déjà à 50 XP : le test continue, le message « tous les points de cette fiche » s'affiche et les points ne bougent plus ; deux onglets (le premier reçoit 409 et rouvre); **le parent ne voit aucune question** (vue parent après un test multi-fiches : seulement juste/faux) ; un `POST /answers` direct sur une question hors tirage répond 409.
**Mesure réelle (hors CI, point P12)** : 10 fiches de l'échantillon, mode `real`, 2 passages au plus (garde de `docs/cost-guard.md`), budget d'environ 0,05 EUR. À mesurer : coût réel des 4 appels, **jetons de sortie du second tour (coupure à 6 000 ?)**, **durée de `generate` avec le second tour** (limite 240 s), part de jumelles qui passent, seuils 0,6 et 0,35 avec des paires jugées à la main.

## 13. Découpage en lots (propriétaires de fichiers distincts)

Ordre : **Q1-S** d'abord (fichier nouveau, aucun conflit). **Q1-G, Q1-D, Q1-E et Q1-X attendent R1-A** (R1-A édite `steps-doc.ts`, `prompts.ts`, `shared/items.ts`, `shared/delete-tree.ts`, `mock/**` et `e2e/mock-api/**`, que ces lots touchent aussi), et **Q1-D et Q1-X attendent aussi R1-B (PR #91)**, qui touche `infra/lib/game-stack.ts` et `pipeline-stack.ts`. Puis **Q1-G** et **Q1-D** en parallèle ; **Q1-W** contre le mock en parallèle de Q1-D ; **Q1-E** à la fin ; **Q1-X** facultatif en dernier. Le lot contrat **Q1-K** prend son numéro de version à la fusion (section 8).

| Lot | Contenu | Fichiers (propriétaire unique) |
|---|---|---|
| **Q1-C** (cette PR) | conception, commit légal séparé. **Ne touche pas** au contrat | `docs/Q1-design.md`, `docs/legal/**` (registre, politique) |
| **Q1-K** contrat | intégrer la section 8 dans le contrat. Un seul lot touche `openapi.yaml` à la fois ; numéro de version pris à la fusion (section 8) | `shared/contract/**` |
| **Q1-S** fonctions pures | `closeness`, `drawQuestions`, `poolCap`, normalisation des mots, tests | `shared/pool.ts`, `shared/pool.test.ts` |
| **Q1-G** génération | second tour, prompt `variantes`, contrôle de proximité, écriture des questions suivantes, mesure sur 10 fiches et calibrage des seuils (P12) | `api/src/pipeline/pool-gen.ts` (+ tests), 3 lignes dans `api/src/pipeline/steps-doc.ts` (`generate`, dont l'écriture de `nbQuestions`), `shared/items.ts` (champ facultatif `nbQuestions`), une fonction dans `api/src/pipeline/prompts.ts`, `docs/cost-guard.md` (une ligne : estimation et mesure) |
| **Q1-D** tirage et API | `draw.ts`, `session.ts` (tirage), `answers.ts` (contrôle `draw`, plafond de 50 XP par fiche, attribut `xp` de `ATT`), `rules.ts` (`DOC_XP_CAP = 50`), `docs/game-rules.md` (point 10 de la section 7, PR vers son propriétaire L1c), `practice-post`, `PROFILE.currentTest.draw` / `docIds`, `TEST#` multi-fiches, suppression par fiche, `DocSummary.questionCount`, **ROUTES** | `api/src/game/{draw,session,answers,tests}.ts`, `api/src/handlers/{session-get,practice-post,answers-post}.ts`, `api/src/docs/docs.ts` (`questionCount`), `shared/delete-tree.ts` (port `mutateTest`, projection `docIds`, option `garderTests`, + tests de la section 7), `infra/lib/*` (rôle de `practice-post`), `shared/tests-history.ts` (champs facultatifs), `docs/data-model.md`, `infra/lib/api-stack.ts` (**un seul lot touche `infra/`**), `mock/**` |
| **Q1-W** site élève | sélection de fiches, bouton du dossier, choix de la taille, affichage de la fiche d'origine, messages | `web/src/screens/Practice.tsx` (nouveau), `web/src/screens/Quiz.tsx`, une ligne dans `Docs.tsx` et `Folders.tsx`, `web/src/router.ts` (une route), `web/src/api.ts`, `web/src/types.ts` (**un seul lot à la fois**) |
| **Q1-E** e2e | scénarios de la section 12 | `e2e/tests/08-banque.spec.ts`, `e2e/mock-api/server.mjs`, `e2e/support/**` |
| **Q1-X** (facultatif) | « Ajouter des questions » pour les anciennes fiches : handler, compteur `POOL#`, rôle de traitement, test M2 | `api/src/pool/**`, `api/src/handlers/pool-post.ts`, `infra/lib/*` (après Q1-D), `infra/test/m2-bedrock.test.ts` |

**Piège d'ordre et CI verte** (comme H1 section 8) : `infra/test/stacks.test.ts` vérifie que `ROUTES` couvre exactement les routes du contrat. Fusionner Q1-K seul met la CI de `main` au rouge. Donc Q1-K et Q1-D forment une pile : Q1-D est fondée sur Q1-K, et on fusionne Q1-K puis Q1-D dans la foulée, ou Q1-D seule rebasée avec le contrat. `main` ne doit jamais être rouge, et on n'ajoute aucune exception au test.

**Croisements à surveiller**
- **R1 (PR #82, fusionnée ; lots R1-A et R1-B)** : voir l'ordre au début de cette section. La fiche passe en paragraphes (`Doc.body`, `Doc.recall`) ; le second tour lit les mêmes affirmations vérifiées, pas la fiche.
- **F10 (conception fusionnée)** : un ajout de pages est un scan ordinaire (décision D12 de F10) : il **ne régénère pas** les questions d'une fiche existante. Les cas réels de « numéro réutilisé » sont (a) la **reprise de `generate`** avant publication, sans risque (aucune réponse n'existe encore) ; (b) le futur bouton Q1-X. Règle : le second tour et Q1-X **n'effacent jamais** et écrivent à partir de `max(nn) + 1` avec `attribute_not_exists` ; une question retirée laisse un trou ; limite 99 par type (format `[0-9]{2}`), au-delà Q1-X s'arrête sans erreur.
- **H1** : `recordTest` lit l'ordre de `docQuestions` ; Q1-D le remplace par `currentTest.draw`. Pas de changement de forme des routes H1.

## 14. Points à trancher

**Décision du propriétaire** : P1 à P13 validés avec la réponse par défaut, **sauf P5** (50 points au plus par fiche, voir ci-dessous).

| # | Question en mots simples | Réponse proposée par défaut |
|---|---|---|
| **P1** | Combien de questions prépare-t-on par fiche ? | Environ **deux questions pour chaque fait vérifié**, jusqu'à 20 QCM et 20 textes à trous (40 au plus). Une fiche à 4 faits aura jusqu'à 16 questions |
| **P2** | Combien de questions dans un test ? | **10** par défaut. L'élève peut choisir 5, 10, 15 ou 20 |
| **P3** | Que faire si la fiche n'a pas assez de questions vraiment différentes ? | Le test est **plus court**, avec un message (« cette fiche n'a que 6 questions différentes »). On ne repose jamais une question qui ressemble à une autre du même test, même pour faire le compte |
| **P4** | Quand reproposer une question déjà posée ? | **Seulement quand toutes les autres ont été posées.** Ensuite, on reprend d'abord les plus anciennes. Une question qu'on a vue sans y répondre n'est pas comptée comme posée |
| **P5** | Les nouvelles questions rapportent-elles des points ? | **Décidé par le propriétaire : 50 points au plus par fiche, au total** (pour toute la vie de la fiche). Le plafond de 250 points par jour reste. Les questions au-delà restent corrigées et comptent dans l'historique, sans points, et ne comptent plus pour le bonus de série. **À savoir** : une ancienne fiche peut afficher « 50 sur 50 » alors qu'elle a rapporté un peu moins (jusqu'à 15 points de moins), donc des questions ajoutées plus tard ne lui rapporteraient rien. Aucun point déjà gagné n'est retiré |
| **P6** | Les fiches déjà créées ont peu de questions. Ajoute-t-on un bouton pour en créer d'autres ? | **Oui, mais plus tard** (lot facultatif Q1-X). Environ 0,14 centime par fiche, une fois par fiche et par jour, 10 par jour et par élève |
| **P7** | Comment partager les questions entre plusieurs fiches ? | **À parts égales** entre les fiches (10 fiches au plus). Un dossier de plus de 10 fiches : on prend les 10 les moins travaillées récemment |
| **P8** | Que fait-on des fiches d'un dossier qui n'ont pas de questions, ou qui ont été supprimées ? | On les **saute** et on le dit avant de commencer (« 2 fiches n'ont pas encore de questions »). Si aucune fiche n'a de question, le bouton est grisé |
| **P9** | Comment garder dans l'historique un test fait sur plusieurs fiches ? | **Un seul passage** (« Dossier Histoire, 12 questions »). Si on supprime une des fiches, on enlève seulement ses questions du passage ; le passage disparaît s'il n'en reste plus aucune |
| **P10** | L'application peut-elle refuser une réponse à une question qui n'est pas dans le test en cours ? | **Oui.** Sinon un élève pourrait deviner une question et voir sa réponse sans jouer. Conséquence : il faut ouvrir un test avant de répondre |
| **P11** | Le parent voit-il quelque chose de plus ? | Seulement **le nombre de questions** de chaque fiche et le nom du dossier ou « 3 fiches » dans l'historique. Jamais une question ni une réponse |
| **P12** | Mesure-t-on avant de décider des seuils de ressemblance et du coût ? | **Oui**, sur 10 vraies fiches, avec un coût d'environ 5 centimes, avant d'ouvrir la fonction. Les chiffres de ce document sont des estimations |
| **P13** | Les textes légaux changent un peu (titre du dossier, plusieurs fiches dans un passage). Fait-on ré-accepter la politique aux parents ? | **Décidé : pas de hausse propre à Q1.** Commit séparé, `POLICY_VERSION` **non relevé** par cette PR ; la version sera relevée **une seule fois, avec R1** (PR #82). Q1 ne fusionne donc ses textes légaux qu'avec ou après cette hausse unique |
