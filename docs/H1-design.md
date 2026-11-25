# H1: historique des tests (issue #44) et vue parent (issue #45)

Statut: **conception**, aucun handler ecrit. Contrat: `shared/contract/openapi.yaml` v**1.4.0** (additif). Les textes legaux sont dans un commit separe, **proposition, a valider par Alexis**.
Contexte: #42 (banque de questions et tirage) change le contenu d'un test, pas la forme de son historique (voir section 9).

## 1. Ce qui existe deja (et ce qui manque)

- Une reponse (`POST /answers`) ecrit `PROFILE`, `DAY`, `WEEK`, `ATT#<questionId>#<jour>` en une transaction (`docs/l3-backend.md`). `ATT` ne garde que `attempts`, `done`, `rewarded` **par question et par jour**: pas de notion de passage, pas de score, pas de reponse donnee.
- Un « test » n'a pas d'identite. La seule trace d'un passage est `PROFILE.series {n, perfect, risky, startedAt}`, ecrasee a chaque ouverture de session.
- `GET /docs/{docId}/session` ouvre la session (pose `PROFILE.tick` et `series.startedAt`). Le client n'envoie aucun identifiant de session.

**Definition retenue d'un passage de test**: une ouverture de session sur une fiche, et toutes les reponses qui suivent sur les questions de cette fiche, jusqu'a la prochaine ouverture de session (sur n'importe quelle fiche) ou 3 h sans reponse. Le client n'a rien a changer pour l'ecriture.

## 2. Modele de donnees

Une entree par passage, dans la partition de l'eleve. Aucune table, aucun index, aucune cle de partition nouvelle.

| Type | PK | SK | Attributs | Ecrit par |
|---|---|---|---|---|
| Test (H1) | `STUDENT#<sid>` | `TEST#<aaaa-mm-jjThh:mm:ssZ>#<testId>` (heure UTC; `testId` = ULID) | `docId`, `titre` (copie courte de la fiche, 200 car. au plus), `matiere`, `mode` (`mixte`, `qcm`, `gap`), `startedAt`, `endedAt`, `total` (questions de la session), `answered`, `correct`, `firstTry`, `xpGained`, `items[]`, `ttl` (secondes epoch), `v` | `answers-post` (seul) |

`items[]`, une ligne par question repondue dans le passage: `{ q: questionId, k: qcm|gap, ok: bool, n: essais (1 ou 2), f: juste du premier coup, xp, at: ISO, c: derniere reponse donnee }`. Au plus 20 lignes (taille de session), **aucun texte de question, de choix ni de cours** (`c` est ce que l'eleve a tape ou choisi, 300 caracteres au plus).

Champs derives, jamais stockes: `scorePct = round(100 x correct / total)`, `status = complet` si `answered == total`.

**Pointeur de passage ouvert**: `PROFILE.currentTest = { testId, sk, docId, openedAt }`, pose par `session-get` dans l'ecriture de `PROFILE` qu'il fait deja (`tick`). Pas d'entree `TEST#` tant qu'aucune reponse n'est donnee: ouvrir une fiche sans repondre ne laisse rien.

**Ecriture** (dans la transaction existante de `answers-post`, un 5e element):
1. La question appartient a `currentTest.docId` et `now - tick < 3 h`: mise a jour de l'entree existante (`items` en `list_append` si la question est nouvelle, sinon remplacement de sa ligne), compteurs recalcules.
2. Sinon (pas de session ouverte, autre fiche, delai depasse): creation d'une entree implicite (`mode` deduit du type de la question, `total` = nombre de questions de la fiche), et `currentTest` est remplace. Une reponse sans session reste donc visible dans l'historique.

Une question rejouee dans le meme passage met a jour sa ligne (dernier etat). Rejouer une question deja payee garde `xp = 0` (regle « une recompense par question pour toujours », `game-rules.md` 7.2): l'historique montre le score, pas le gain unique.

La transaction compte deja 4 elements; elle en aura 5 (plafond DynamoDB: 100). Les cles `DAY`/`ATT` ne changent pas.

## 3. Durees de conservation (proposition)

| Donnee | Duree proposee | Mecanisme |
|---|---|---|
| Detail d'un passage (`TEST#`, avec les reponses donnees) | **12 mois apres `startedAt`** | attribut `ttl` (deja le TTL de la table). Le TTL DynamoDB efface avec jusqu'a 48 h de retard: les handlers **filtrent** `ttl < maintenant` en lecture, une entree expiree n'est jamais renvoyee |
| Profil de jeu (XP, serie, badges, niveau) | jusqu'a suppression (inchange) | `PROFILE` |
| Tout l'historique d'un eleve | suppression immediate avec l'eleve ou la famille | `deleteStudentTree` supprime deja tout sauf `DOC#` sous `STUDENT#<sid>`: **couvert sans changement**, un test est a ajouter |
| Entrees d'une fiche | suppression immediate avec la fiche | `deleteDocTree` etendu (section 7) |

Justification RGPD (eleves mineurs, dont moins de 15 ans):
- **Limitation de la conservation** (art. 5.1.e): le detail des reponses d'un mineur n'a d'utilite que pour reviser et suivre une annee scolaire. 12 mois couvrent une annee de suivi plus la comparaison avec l'annee precedente, et evitent une accumulation sans fin. Les chiffres durables (XP, serie, badges) restent dans le profil, ils ne contiennent aucune reponse.
- **Minimisation** (art. 5.1.c): pas de texte de cours ni de question dans l'historique; la reponse donnee n'est gardee que pour que l'eleve revoie ses erreurs. Le parent ne la voit pas (section 5).
- **Base legale**: celle de T5 (consentement du parent pour les moins de 15 ans, de l'eleve a partir de 15 ans), meme finalite (suivi par l'eleve et le parent). Pas de profilage automatise, pas de decision automatique.
- **Droits**: acces et portabilite par l'export (section 6), effacement par suppression de la fiche, de l'eleve ou de la famille. Pas de route d'effacement partiel de l'historique (point a trancher P3).
- La vue parent est un nouveau **destinataire** de donnees deja collectees (le parent voyait deja la progression): a mentionner dans la politique et le registre. L'AIPD (brouillon) doit citer ce suivi comme risque (surveillance de l'enfant); mesure: score global seulement, aucune reponse ni question.

## 4. Acces DynamoDB (aucune ressource nouvelle)

| Besoin | Requete |
|---|---|
| Liste d'un eleve, recente d'abord | `Query PK=STUDENT#<sid>, SK begins_with TEST#, ScanIndexForward=false, Limit=limit` |
| Filtre de dates | `SK between TEST#<debut UTC> and TEST#<fin UTC>~` (les jours Europe/Paris sont convertis en bornes UTC) |
| Filtre par fiche | `FilterExpression docId = :d` (filtre apres lecture, acceptable: au plus ~1 100 entrees, voir section 8) |
| Detail | `Query` sur la partition de l'eleve avec `FilterExpression testId = :t` (le `testId` termine la cle; un index n'est pas justifie pour ~1 100 entrees, environ 1 RCU) |
| Pagination | `ExclusiveStartKey` = `{PK, SK}` reconstruit cote serveur; le curseur renvoye au client est **uniquement le `SK`** en base64url. La partition vient toujours du jeton: un curseur trafique ne peut pas lire une autre partition. Curseur mal forme (pas de prefixe `TEST#`, trop long): 400 |
| Vue parent | par eleve: `Query TEST#` sur 12 semaines (borne `SK >= TEST#<il y a 84 jours>`), agregation en memoire (semaines, matieres, meilleur et dernier score par fiche). Au plus 5 eleves par famille |

`GSI1` n'est pas utilise. Seuil de reprise (a mettre dans le code): au-dela de 3 000 entrees par eleve ou 300 ms pour la vue parent, ajouter un element d'agregat hebdomadaire `WEEKSTAT#<aaaa-Www>` ecrit par `answers-post` (decision d'un lot suivant).

## 5. Routes et regles d'acces

| Route | Qui | Renvoie |
|---|---|---|
| `GET /me/tests?limit&cursor&docId&from&to` | eleve | `TestPage`: resumes, du plus recent au plus ancien |
| `GET /me/tests/{testId}` | eleve proprietaire | `TestDetail`: resume + une ligne par question, avec `prompt`, `choices`, `choice` (reponse donnee) et `correctAnswer` (seulement si la question est terminee) |
| `GET /students/{sid}/progress` | parent de la famille | `StudentProgressView`: progression de jeu, fiches (titre, matiere, pages, nombre de tests, meilleur et dernier score), scans recents (etape et pages), 12 semaines, matieres, 10 derniers tests |
| `GET /students/{sid}/tests?...` | parent de la famille | `TestPage` (resumes seulement, pas de questions) |

Regles (a tester une par une, comme `access.ts`):
1. **Identite depuis le jeton, ressource depuis la base.** La cle est `STUDENT#<sid>` avec `sid` = `studentId` du jeton (eleve) ou un `sid` dont `FAMILY#<fid-du-jeton>/STUDENT#<sid>` existe (parent).
2. **Eleve**: il ne lit que ses propres passages. Pas de route qui prenne un `sid` cote eleve: pas de lecture entre freres et soeurs. Eleve suspendu: 403 (comme `activeStudent`).
3. **Parent**: `GET /students/{sid}/...` pour un `sid` hors de sa famille repond **404**, identique a un `sid` inexistant (pas de fuite d'existence). Un parent qui appelle `/me/tests` recoit 403, un eleve qui appelle `/students/...` recoit 403 (meme logique que `session` et `me/progress`).
4. **Le parent ne voit jamais**: le texte d'une question, un choix, la reponse donnee, la bonne reponse, le texte d'un cours. Il voit le score global de chaque passage, l'etat de chaque scan (etape, pages), les titres de fiches (deja visibles dans la liste parent). Test de contrat ajoute: `StudentProgressView`, `TestSummary`, `DocProgress`, `ScanProgress` n'ont aucun champ `prompt`, `choices`, `choice`, `correctAnswer`, `questions`.
5. Aucune ecriture cote parent (lecture seule). Aucune route ne prend un `familyId` en parametre.
6. Entrees expirees (`ttl` depasse) filtrees en lecture; `GET /me/tests/{testId}` repond 404.
7. Limite de debit: les 4 routes sont des lectures; meme limitation que `GET /me/progress`.

IAM (lot infra): un role `read` existe deja (`GetItem`, `Query` sur `STUDENT#*` et `FAMILY#*`). `tests-read` et `family-progress` l'utilisent; `answers-post` a deja `play` (transaction). **Aucun changement d'IAM.**

## 6. Export et suppression

- **Export** (`GET /family/export`): `StudentExport.tests` (`TestExport[]`, 12 mois au plus). Les lignes contiennent les reponses donnees mais **pas** le texte des questions (il est deja dans `docs[].questions`, relie par `questionId`). L'export reste un JSON synchrone: taille estimee 1 a 1,3 Ko par passage; 1 passage par jour et par eleve donne 0,5 Mo par eleve et par an, **6 Mo (limite Lambda) atteints a plus de 4 500 passages au total**. Garde-fou: **3 000 passages au plus par eleve**, `testsTruncated: true` au-dela (les plus anciens sont omis). Si un usage reel s'en approche, passer a un export depose sur S3 (hors de ce lot).
- **Suppression d'un eleve ou de la famille**: deja couverte (`deleteStudentTree`, `deleteFamilyTree`). Test a ajouter dans `shared/delete-tree.test.ts`: apres suppression, aucun `TEST#` ne reste.
- **Suppression d'une fiche** (`DELETE /docs/{docId}`, ou suppression d'un cours avec ses fiches): `deleteDocTree` supprime aussi les `TEST#` de l'eleve dont `docId` correspond. Il lui faut `docId` dans les cles listees (comme pour `REPORT#`). Sinon l'historique garderait titre et reponses d'un cours que l'eleve a voulu effacer. Contre-partie: l'historique perd ces passages (point a trancher P2).
- Politique et registre: voir le commit separe `docs/legal`.

## 7. Cout estime

Base: 5 eleves, 3 passages par jour et par eleve (hypothese haute), 10 reponses par passage, eu-west-3 en facturation a la demande.

| Poste | Calcul | Ordre de grandeur |
|---|---|---|
| Ecritures | 5 x 3 x 10 x 365 = 54 750 reponses/an; un element de plus dans une transaction (2 WCU par ko, double en transaction) soit environ 4 WCU par reponse: 220 000 WCU/an | environ 0,30 EUR par an |
| Stockage | 5 x 1 100 passages x 1,5 Ko = 8 Mo | moins de 0,01 EUR par mois |
| Lectures (liste, detail, vue parent) | quelques dizaines de `Query` par jour, de 1 a 10 RCU chacune | negligeable |
| Lambda | 2 handlers de lecture, quelques centaines d'appels par mois | dans le palier gratuit |
| Bedrock | **aucun appel**. L'historique ne genere rien | 0 |
| **Total** | | **moins de 0,10 EUR par mois, sans ressource nouvelle** |

A valider avant tout deploiement (regle du projet): aucune ressource AWS creee par ce lot; le deploiement ajoute 2 fonctions Lambda et 4 routes.

## 8. Decoupage en lots (proprietaires de fichiers distincts)

Ordre: **H1-C** (cette PR, contrat) puis **H1-A** et **H1-W** en parallele (le front travaille contre le mock), **H1-P** apres H1-A.

| Lot | Contenu | Fichiers (proprietaire unique) |
|---|---|---|
| **H1-C** (cette PR) | contrat 1.4.0, conception, propositions legales | `shared/contract/**`, `docs/H1-design.md`, `docs/legal/**` |
| **H1-A** API ecriture et lecture | `PROFILE.currentTest` dans `session-get`; element `TEST#` dans `answers-post`; `tests-read` (`GET /me/tests`, `/me/tests/{testId}`); export; suppression par fiche; cles et fonctions pures (score, `ttl`, curseur) | `api/src/game/{session,answers,tests}.ts`, `api/src/handlers/{session-get,answers-post,tests-read}.ts`, `shared/ddb/keys.ts` (cle `test`), `shared/tests-history.ts` (+ test), `shared/delete-tree.ts` (+ test), `api/src/family/family.ts` (export), `docs/data-model.md`, `infra/lib/api-stack.ts` (**ROUTES: 4 routes + 2 handlers**), `mock/**` |
| **H1-P** vue parent API | `family-progress`: `GET /students/{sid}/progress` et `/students/{sid}/tests` (agregation, regles 3 et 4) | `api/src/game/family-progress.ts`, `api/src/handlers/family-progress.ts` (+ tests). Lit les elements `TEST#`, `DOC#`, `JOB#`, `PROFILE`; n'ecrit rien |
| **H1-W** site eleve | ecran « Mes tests » (liste paginee, filtre par fiche, detail avec correction) et lien depuis la fiche | `web/src/screens/Tests.tsx`, `web/src/screens/TestDetail.tsx`, `web/src/tests-api.ts` (+ tests), `web/src/router.ts` (une ligne de route) |
| **H1-V** site parent | section « Suivi » dans l'ecran parent: cartes par eleve, courbe 12 semaines, matieres faibles, liste des tests | `web/src/screens/Suivi.tsx`, `web/src/suivi-api.ts` (+ tests). `Parent.tsx` ne recoit qu'un lien, a faire par H1-V seul |

**Piege d'ordre**: `infra/test/stacks.test.ts` verifie que `ROUTES` couvre exactement les routes du contrat. Fusionner le contrat 1.4.0 seul met la CI de `main` au rouge (4 tests). Donc **H1-A ajoute les 4 routes a `ROUTES` (avec les handlers, meme s'ils repondent 501 au debut) et se fusionne avec ou juste apres H1-C**; H1-P remplace ensuite le handler `family-progress`. `web/src/api.ts` et `web/src/types.ts` (types generes du contrat) sont modifies par un seul lot a la fois: H1-W, puis H1-V.

Tests d'acceptation a ecrire par H1-A/H1-P: parent d'une autre famille: 404 sur `progress` et `tests`; eleve frere ou soeur: pas de route; curseur trafique (SK d'un autre eleve): 400 ou liste vide, jamais les donnees d'un autre; vue parent sans `prompt` ni `choice` (test sur le JSON); entree expiree non renvoyee; suppression eleve, fiche et famille: plus de `TEST#`; une reponse sans session ouverte cree un passage; deux reponses simultanees ne perdent aucune ligne.

## 9. Lien avec #42 (banque de questions)

L'historique stocke des `questionId` et des resultats, jamais le contenu: il suit sans changement un tirage aleatoire. `mode` est ouvert (`tirage` s'ajoutera, le contrat dit aux clients de traiter une valeur inconnue comme `autre`). Si le tirage change `total` (nombre de questions tirees), `total` est celui du tirage au moment de l'ouverture de session. Si les `questionId` d'un pool sont retires a une regeneration de fiche, `prompt` est absent dans `TestDetail` et le front affiche « question retiree ».

## 10. Points a trancher par Alexis (valeur par defaut)

- **P1. Duree de conservation du detail**: 12 mois (defaut). Alternatives: l'annee scolaire en cours, ou jusqu'a suppression (plus simple, moins conforme).
- **P2. Suppression d'une fiche**: supprime aussi ses passages (defaut, minimisation). Alternative: garder score et date, vider `titre` et reponses (historique plus complet, plus de code).
- **P3. Effacer l'historique sans supprimer l'eleve**: pas de route (defaut, `DELETE /students/{sid}` et suppression de fiche suffisent). Alternative: `DELETE /me/tests` (l'eleve) et `DELETE /students/{sid}/tests` (le parent), 2 routes de plus.
- **P4. Niveau de detail pour le parent**: score global par passage, **pas** de detail par question (defaut). Alternative: bonne ou mauvaise reponse par question, sans texte. Apport pour le parent: voir quelles questions posent probleme; risque: surveillance fine d'un mineur.
- **P5. Reponse donnee**: gardee 12 mois et lue seulement par l'eleve (defaut). Alternative: ne garder que juste ou faux (moins de donnees, correction moins utile).
- **P6. Titre de la fiche copie dans le passage**: oui (defaut, evite une lecture par ligne). Alternative: lire la fiche a chaque liste.
- **P7. Eleves de 15 ans et plus**: le parent voit le meme resume (defaut). Alternative: l'eleve peut masquer son suivi a partir de 15 ans (consentement propre).
- **P8. Passage « incomplet »** (session abandonnee) compte dans la moyenne: oui, avec `answered/total` visible (defaut). Alternative: seulement les passages complets.
- **P9. Ordre de fusion**: H1-C avec H1-A (defaut, la CI de `main` reste verte). Alternative: H1-A en premier avec des routes 501 sans contrat.
- **P10. Export**: borne a 3 000 passages par eleve, JSON synchrone (defaut).
