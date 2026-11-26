# H1: historique des tests (issue #44) et vue parent (issue #45)

Statut: **conception**, aucun handler ecrit. Contrat: `shared/contract/openapi.yaml` v**1.4.0** (additif). Les decisions du proprietaire sur P1 a P10 sont integrees (section 10). Les textes legaux sont dans un commit separe, a relire par le proprietaire.
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
| Test (H1) | `STUDENT#<sid>` | `TEST#<aaaa-mm-jjThh:mm:ssZ>#<testId>` (heure UTC; `testId` = ULID) | `docId`, `titre` (copie courte de la fiche, 200 car. au plus), `matiere`, `mode` (`mixte`, `qcm`, `gap`), `anneeScolaire` (derive de `startedAt`, section 3), `startedAt`, `endedAt`, `total` (questions de la session), `answered`, `correct`, `firstTry`, `xpGained`, `items[]`, `v`. **Pas de `ttl`** | `answers-post` (seul) |

`items[]`, une ligne par question repondue dans le passage: `{ q: questionId, r: rang (position dans la session, a partir de 1), k: qcm|gap, ok: bool, n: essais (1 ou 2), f: juste du premier coup, xp, at: ISO, c: derniere reponse donnee }`. Au plus 20 lignes (taille de session), **aucun texte de question, de choix ni de cours** (`c` est ce que l'eleve a tape ou choisi, 300 caracteres au plus).

Champs derives, jamais stockes: `scorePct = round(100 x correct / total)`, `status = complet` si `answered == total`.

**Annees scolaires**: `PROFILE.anneesScolaires` (ensemble de chaines `2026-2027`), complete par `answers-post` au premier passage de chaque annee, pour renvoyer la liste sans lire l'historique.

**Pointeur de passage ouvert**: `PROFILE.currentTest = { testId, sk, docId, openedAt }`, pose par `session-get` dans l'ecriture de `PROFILE` qu'il fait deja (`tick`). Pas d'entree `TEST#` tant qu'aucune reponse n'est donnee: ouvrir une fiche sans repondre ne laisse rien.

**Ecriture** (dans la transaction existante de `answers-post`, un 5e element):
1. La question appartient a `currentTest.docId` et `now - tick < 3 h`: mise a jour de l'entree existante (`items` en `list_append` si la question est nouvelle, sinon remplacement de sa ligne), compteurs recalcules.
2. Sinon (pas de session ouverte, autre fiche, delai depasse): creation d'une entree implicite (`mode` deduit du type de la question, `total` = nombre de questions de la fiche), et `currentTest` est remplace. Une reponse sans session reste donc visible dans l'historique.

Une question rejouee dans le meme passage met a jour sa ligne (dernier etat). Rejouer une question deja payee garde `xp = 0` (regle « une recompense par question pour toujours », `game-rules.md` 7.2): l'historique montre le score, pas le gain unique.

La transaction compte deja 4 elements; elle en aura 5 (plafond DynamoDB: 100). Les cles `DAY`/`ATT` ne changent pas.

## 3. Conservation et annee scolaire (decision P1)

**Conservation: jusqu'a suppression** (decision du proprietaire, responsable du traitement). Pas de TTL sur `TEST#`. Un passage disparait avec:

| Evenement | Effet | Mecanisme |
|---|---|---|
| Suppression de l'eleve ou de la famille | tout l'historique est efface tout de suite | `deleteStudentTree` supprime deja tout sauf `DOC#` sous `STUDENT#<sid>`: **couvert sans changement**, un test est a ajouter |
| Suppression d'une fiche (P2) | ses passages sont supprimes | `deleteDocTree` etendu (section 6) |
| Rien d'autre | rien n'est efface automatiquement | |

**Regle de l'annee scolaire** (champ derive, additif): du **1er septembre au 31 aout**, selon la date `startedAt` convertie en fuseau **Europe/Paris** (jour local, pas UTC). `anneeScolaire` = `<A>-<A+1>` ou `A` = annee de la date si le mois est septembre a decembre, annee precedente si janvier a aout.

| `startedAt` (Paris) | `schoolYear` |
|---|---|
| 2026-09-01 00:00 | 2026-2027 |
| 2026-12-31 23:59 | 2026-2027 |
| 2027-01-01 00:00 | 2026-2027 |
| 2027-08-31 23:59 | 2026-2027 |
| 2027-09-01 00:00 | 2027-2028 |
| 2026-08-31 23:30 Paris (= 21:30 UTC) | 2025-2026 |

La valeur est calculee a l'ecriture et stockee: elle ne change pas si la regle evolue. La fonction pure (`schoolYearOf(date)`) va dans `shared/tests-history.ts` avec les 6 cas ci-dessus en test. Filtre `schoolYear` des listes: borne de cle `SK between TEST#<1er sept. 00:00 Paris en UTC> and TEST#<31 aout suivant 23:59:59 Paris en UTC>`, donc **sans lecture inutile**. La liste `schoolYears` (premiere page, et vue parent) vient de `PROFILE.anneesScolaires`. Le front regroupe par annee, l'annee en cours etant ouverte par defaut.

Justification RGPD (eleves mineurs, dont moins de 15 ans). La conservation sans limite fixe est un **choix du responsable du traitement**, a assumer dans la politique:
- **Limitation de la conservation** (art. 5.1.e): la duree n'est plus un delai, elle est liee a la finalite (suivre et revoir son parcours) et a la **maitrise de l'eleve et du parent**, qui peuvent tout effacer a tout moment (fiche, eleve, famille: effacement immediat, sans copie de secours). Risque: un historique de plusieurs annees sur un mineur. Mesures: pas de texte de cours ni de question dans l'historique, reponses lisibles par l'eleve seul, parent en lecture seule, isolation par famille, export complet, **rappel annuel** propose (point R1: a la rentree, le parent voit le nombre d'annees conservees et un bouton de suppression de l'eleve; aucun code dans ce lot).
- **Minimisation** (art. 5.1.c): voir section 5, regle 4.
- **Base legale**: celle de T5 (consentement du parent pour les moins de 15 ans, de l'eleve a partir de 15 ans), meme finalite. Pas de profilage automatise, pas de decision automatique.
- **Droits**: acces et portabilite par l'archive (section 6), effacement par suppression de la fiche, de l'eleve ou de la famille. Pas de route d'effacement partiel (P3).
- La vue parent est un nouveau **destinataire** de donnees deja collectees. **Risque de surveillance fine d'un mineur** (le parent voit, question par question, ce qui est juste ou faux, et la duree de l'historique): inscrit dans l'AIPD avec ses mesures (aucun texte ni reponse donnee cote parent, lecture seule, famille seulement, suppression possible).

## 4. Acces DynamoDB (aucune ressource nouvelle)

| Besoin | Requete |
|---|---|
| Liste d'un eleve, recente d'abord | `Query PK=STUDENT#<sid>, SK begins_with TEST#, ScanIndexForward=false, Limit=limit` |
| Filtre de dates | `SK between TEST#<debut UTC> and TEST#<fin UTC>~` (les jours Europe/Paris sont convertis en bornes UTC) |
| Filtre par fiche | `FilterExpression docId = :d` (filtre apres lecture, acceptable: au plus ~1 100 entrees, voir section 8) |
| Detail | `GetItem`: le `testId` est un ULID cree a l'ouverture de la session, son prefixe de temps donne `startedAt`, donc la cle exacte `TEST#<startedAt UTC>#<testId>` se reconstruit sans index ni filtre (0,5 RCU). Un `testId` mal forme: 404 |
| Pagination | `ExclusiveStartKey` = `{PK, SK}` reconstruit cote serveur; le curseur renvoye au client est **uniquement le `SK`** en base64url. La partition vient toujours du jeton: un curseur trafique ne peut pas lire une autre partition. Curseur mal forme (pas de prefixe `TEST#`, trop long): 400 |
| Annee scolaire | `SK between` sur les bornes de l'annee (section 3); aucune lecture hors annee |
| Vue parent | par eleve: `Query TEST#` sur 12 semaines (borne `SK >= TEST#<il y a 84 jours>`), agregation en memoire (semaines, matieres, meilleur et dernier score par fiche). Au plus 5 eleves par famille |

`GSI1` n'est pas utilise. **Sans TTL, la partition grossit** (environ 1 100 passages par eleve et par an a 3 par jour): la liste par annee reste bornee, mais le filtre `docId` et la suppression d'une fiche lisent toute la partition de l'eleve. Seuil de reprise (a mettre dans le code): au-dela de 6 000 entrees par eleve ou 300 ms pour la vue parent ou ces deux operations, ajouter un index sur `docId` (`GSI2`, decision d'infra separee) et/ou un element d'agregat hebdomadaire `WEEKSTAT#<aaaa-Www>` ecrit par `answers-post`.

## 5. Routes et regles d'acces

| Route | Qui | Renvoie |
|---|---|---|
| `GET /me/tests?limit&cursor&docId&from&to` | eleve | `TestPage`: resumes, du plus recent au plus ancien |
| `GET /me/tests/{testId}` | eleve proprietaire | `TestDetail`: resume + une ligne par question, avec `prompt`, `choices`, `choice` (reponse donnee) et `correctAnswer` (seulement si la question est terminee) |
| `GET /students/{sid}/progress` | parent de la famille | `StudentProgressView`: progression de jeu, fiches (titre, matiere, pages, nombre de tests, meilleur et dernier score), scans recents (etape et pages), 12 semaines, matieres, 10 derniers tests |
| `GET /students/{sid}/tests?...` | parent de la famille | `TestPage` (resumes seulement) |
| `GET /students/{sid}/tests/{testId}` | parent de la famille | `TestParentDetail`: pour chaque question `questionId`, `rank`, `kind`, juste ou faux, essais, XP. **Aucun texte, aucun choix, aucune reponse donnee, aucune bonne reponse** (P4) |
| `POST /family/export/archive` | parent | `ExportArchive`: lien signe de 10 minutes (section 6) |

Regles (a tester une par une, comme `access.ts`):
1. **Identite depuis le jeton, ressource depuis la base.** La cle est `STUDENT#<sid>` avec `sid` = `studentId` du jeton (eleve) ou un `sid` dont `FAMILY#<fid-du-jeton>/STUDENT#<sid>` existe (parent).
2. **Eleve**: il ne lit que ses propres passages. Pas de route qui prenne un `sid` cote eleve: pas de lecture entre freres et soeurs. Eleve suspendu: 403 (comme `activeStudent`).
3. **Parent**: `GET /students/{sid}/...` pour un `sid` hors de sa famille repond **404**, identique a un `sid` inexistant (pas de fuite d'existence). Un parent qui appelle `/me/tests` recoit 403, un eleve qui appelle `/students/...` recoit 403 (meme logique que `session` et `me/progress`).
4. **Le parent ne voit jamais**: le texte d'une question, un choix, la reponse donnee par l'eleve, la bonne reponse, le texte d'un cours. Il voit le score de chaque passage, **juste ou faux pour chaque question** (identifiee par `questionId` et `rank`), l'etat de chaque scan (etape, pages), les titres de fiches (deja visibles dans la liste parent). Tests de contrat ajoutes: `StudentProgressView`, `TestSummary`, `TestQuestionStatus`, `TestParentDetail`, `DocProgress`, `ScanProgress` n'ont aucun champ `prompt`, `choices`, `choice`, `correctAnswer`. Seule `TestQuestionResult` (eleve) porte `choice`.
5. Aucune ecriture cote parent (lecture seule). Aucune route ne prend un `familyId` en parametre.
6. Un `testId` d'un autre eleve ou d'une autre famille repond 404 (cle reconstruite dans la partition du jeton, jamais dans une autre).
7. Limite de debit: les routes de lecture ont la limitation de `GET /me/progress`; `POST /family/export/archive` a une limite basse (3 par heure et par famille, a mettre dans `ROUTES`).

IAM (lot infra): un role `read` existe deja (`GetItem`, `Query` sur `STUDENT#*` et `FAMILY#*`). `tests-read` et `family-progress` l'utilisent; `answers-post` a deja `play` (transaction). **Pas de changement d'IAM pour les routes de lecture.** L'archive demande un role neuf `family-export-archive`: lecture `STUDENT#*`/`FAMILY#*`/`DOC#*` comme l'export actuel, plus `s3:PutObject` et `s3:GetObject` (pour signer) sur le prefixe `exports/` du bucket prive existant.

## 6. Export et suppression

- **Export en archive** (decision P10). `GET /family/export` reste le JSON synchrone **sans l'historique** (il indique seulement `testsCount` par eleve), pour ne pas depasser la limite de reponse Lambda (6 Mo). `POST /family/export/archive` (parent) produit un **zip** et renvoie un lien signe.
  - Contenu: `export.json` (le meme `FamilyExport`) et, par eleve, `tests/<studentId>.jsonl`: un passage `TestParentDetail` par ligne, toutes annees scolaires. Un fichier par eleve evite de tout charger en memoire; l'archive est ecrite au fil de la lecture (pages de `Query`).
  - Pas de texte de cours ni de question (le texte des questions est dans `docs[].questions` de `export.json`, relie par `questionId`). **Pas de reponses donnees par l'eleve** (`choice`): l'eleve seul les lit (P5). C'est la meme limite que la vue parent: le lien ne donne rien de plus que l'ecran.
  - Format: zip (bibliotheque `fflate`, sans dependance, a ajouter par H1-A; sinon `.tar.gz` avec `zlib` natif). Taille estimee: environ 120 octets par question apres compression, donc 20 a 40 Ko par annee et par eleve.
  - Stockage: prefixe `exports/<familyId>/<ulid>.zip` du **bucket prive existant** (pas de bucket nouveau), regle de cycle de vie sur ce prefixe: suppression apres 1 jour (suppression effective au plus 2 jours). L'archive est aussi supprimee avec la famille (suppression du prefixe, comme les photos).
  - Lien: URL signee **valable 10 minutes**, generee a la demande, jamais enregistree ni journalisee (les journaux n'ont pas de contenu). Le lien ne contient aucune donnee de l'archive. Une 2e archive ne remplace pas la premiere.
  - Borne: **50 000 passages** au plus (environ 9 ans pour 5 eleves a 3 passages par jour). Au-dela, les annees scolaires les plus anciennes sont omises et `truncated: true`. Le zip se construit en moins de 29 s (limite API Gateway) bien en deca de cette borne: 50 000 passages x 1,5 Ko = environ 75 `Query` de 1 Mo. Mesure a faire par H1-A sur 20 000 passages de test; si le delai depasse 20 s, passer en construction asynchrone (hors de ce lot).
- **Suppression d'un eleve ou de la famille**: deja couverte (`deleteStudentTree`, `deleteFamilyTree`). Test a ajouter dans `shared/delete-tree.test.ts`: apres suppression, aucun `TEST#` ne reste, ni objet sous `exports/<familyId>/`.
- **Suppression d'une fiche** (`DELETE /docs/{docId}`, ou suppression d'un cours avec ses fiches): `deleteDocTree` supprime aussi les `TEST#` de l'eleve dont `docId` correspond. Il lui faut `docId` dans les cles listees (comme pour `REPORT#`). Sinon l'historique garderait titre et reponses d'un cours que l'eleve a voulu effacer. Contre-partie: l'historique perd ces passages (decision P2).
- Politique, registre, AIPD et `decisions.md`: voir le commit separe `docs/legal`.

## 7. Cout estime

Base: 5 eleves, 3 passages par jour et par eleve (hypothese haute), 10 reponses par passage, eu-west-3 en facturation a la demande.

| Poste | Calcul | Ordre de grandeur |
|---|---|---|
| Ecritures | 5 x 3 x 10 x 365 = 54 750 reponses/an; un element de plus dans une transaction (2 WCU par ko, double en transaction) soit environ 4 WCU par reponse: 220 000 WCU/an | environ 0,30 EUR par an |
| Stockage DynamoDB (sans TTL, cumul) | 5 x 1 100 passages x 1,5 Ko = 8 Mo par an; 80 Mo apres 10 ans | moins de 0,01 EUR par mois la 1re annee, environ 0,02 EUR apres 10 ans |
| Archive d'export (S3) | fichier de quelques centaines de Ko, supprime sous 2 jours, 1 a 2 par an | negligeable |
| Lectures (liste, detail, vue parent) | quelques dizaines de `Query` par jour, de 1 a 10 RCU chacune | negligeable |
| Lambda | 3 handlers (lecture eleve, vue parent, archive), quelques centaines d'appels par mois | dans le palier gratuit |
| Bedrock | **aucun appel**. L'historique ne genere rien | 0 |
| **Total** | | **moins de 0,10 EUR par mois, sans ressource nouvelle** |

A valider avant tout deploiement (regle du projet): aucune ressource AWS creee par ce lot; le deploiement ajoute 3 fonctions Lambda, 6 routes, un role IAM (archive) et une regle de cycle de vie sur le prefixe `exports/` du bucket existant.

## 8. Decoupage en lots (proprietaires de fichiers distincts)

Ordre: **H1-C** (cette PR, contrat) avec **H1-A**; puis **H1-P**, **H1-X** et **H1-W** en parallele (le front travaille contre le mock); **H1-V** apres H1-W.

| Lot | Contenu | Fichiers (proprietaire unique) |
|---|---|---|
| **H1-C** (cette PR) | contrat 1.4.0, conception, propositions legales | `shared/contract/**`, `docs/H1-design.md`, `docs/legal/**` |
| **H1-A** API ecriture et lecture | `PROFILE.currentTest` dans `session-get`; element `TEST#` dans `answers-post`; `tests-read` (`GET /me/tests`, `/me/tests/{testId}`); `PROFILE.anneesScolaires`; `testsCount` de l'export; suppression par fiche; cles et fonctions pures (score, annee scolaire, curseur) | `api/src/game/{session,answers,tests}.ts`, `api/src/handlers/{session-get,answers-post,tests-read}.ts`, `shared/ddb/keys.ts` (cle `test`), `shared/tests-history.ts` (+ test: annee scolaire, score, curseur), `shared/delete-tree.ts` (+ test), `api/src/family/family.ts` (export), `docs/data-model.md`, `infra/lib/api-stack.ts` (**ROUTES: les 6 routes + 3 handlers**), `mock/**` |
| **H1-P** vue parent API | `family-progress`: `GET /students/{sid}/progress`, `/students/{sid}/tests`, `/students/{sid}/tests/{testId}` (agregation, regles 3 et 4) | `api/src/game/family-progress.ts`, `api/src/handlers/family-progress.ts` (+ tests). Lit les elements `TEST#`, `DOC#`, `JOB#`, `PROFILE`; n'ecrit rien |
| **H1-X** archive d'export | `POST /family/export/archive`: zip, ecriture S3 sous `exports/`, lien signe 10 min; suppression du prefixe avec la famille; role IAM et regle de cycle de vie | `api/src/family/archive.ts`, `api/src/handlers/family-export-archive.ts` (+ tests), `infra/lib/*` pour le role et la regle de cycle de vie (**un seul lot touche `infra/`**: H1-A le fait pour ROUTES, H1-X apres lui) |
| **H1-W** site eleve | ecran « Mes tests » (liste paginee, regroupee par annee scolaire, filtre par fiche, detail avec correction) et lien depuis la fiche | `web/src/screens/Tests.tsx`, `web/src/screens/TestDetail.tsx`, `web/src/tests-api.ts` (+ tests), `web/src/router.ts` (une ligne de route) |
| **H1-V** site parent | section « Suivi » dans l'ecran parent: cartes par eleve, courbe 12 semaines, matieres faibles, liste des tests par annee scolaire, resultat par question (juste ou faux), bouton « Telecharger l'archive » | `web/src/screens/Suivi.tsx`, `web/src/suivi-api.ts` (+ tests). `Parent.tsx` ne recoit qu'un lien, a faire par H1-V seul |

**Piege d'ordre et CI verte.** `infra/test/stacks.test.ts` verifie que `ROUTES` couvre exactement les routes du contrat. Fusionner le contrat 1.4.0 seul met la CI de `main` au rouge (4 tests). Proposition pour garder `main` toujours vert, **sans retirer aucune verification**:
1. **PR #65 (H1-C)** reste ouverte et non fusionnee. Elle est le **premier commit de la pile**.
2. **PR H1-A** est basee sur `feat/h1-contract` (pile). Elle ajoute les 6 routes et les 3 handlers a `ROUTES`, d'abord en **501 `non_implemente`** pour `family-progress` et `family-export-archive` (leurs lots arrivent ensuite), et pour `tests-read` l'implementation reelle. Les 4 tests infra repassent au vert dans cette PR.
3. On fusionne **#65 puis H1-A dans la foulee** (meme session, sans autre fusion entre les deux), ou, si la CI l'exige verte a chaque PR, on **rebase H1-A sur #65 et on fusionne H1-A seule** (elle contient alors le contrat). Dans les deux cas, `main` n'est jamais rouge.
4. H1-P et H1-X remplacent les 501 par leur code, chacun sur sa propre PR verte. Le contrat n'est jamais modifie par eux (sinon nouvelle PR contrat).
Une alternative que je ne recommande pas: ajouter les routes a une liste d'exceptions dans le test infra. Cela affaiblit la verification que les routes du contrat sont toutes protegees et limitees en debit.

`web/src/api.ts` et `web/src/types.ts` (types generes du contrat) sont modifies par un seul lot a la fois: H1-W, puis H1-V.

Tests d'acceptation a ecrire par H1-A/H1-P: parent d'une autre famille: 404 sur `progress` et `tests`; eleve frere ou soeur: pas de route; curseur trafique (SK d'un autre eleve): 400 ou liste vide, jamais les donnees d'un autre; vue parent sans `prompt` ni `choice` (test sur le JSON); entree expiree non renvoyee; suppression eleve, fiche et famille: plus de `TEST#` (ni archive sous `exports/`); `schoolYearOf` sur les 6 cas de la section 3 (31 aout 23:30 Paris, 1er septembre 00:00 Paris, fuseau d'ete); archive sans `choice` ni texte; lien d'archive expire apres 10 minutes; parent d'une autre famille: 404 sur `/students/{sid}/tests/{testId}`; une reponse sans session ouverte cree un passage; deux reponses simultanees ne perdent aucune ligne.

## 9. Lien avec #42 (banque de questions)

L'historique stocke des `questionId` et des resultats, jamais le contenu: il suit sans changement un tirage aleatoire. `mode` est ouvert (`tirage` s'ajoutera, le contrat dit aux clients de traiter une valeur inconnue comme `autre`). Si le tirage change `total` (nombre de questions tirees), `total` est celui du tirage au moment de l'ouverture de session. Si les `questionId` d'un pool sont retires a une regeneration de fiche, `prompt` est absent dans `TestDetail` et le front affiche « question retiree ».

## 10. Decisions du proprietaire (responsable du traitement)

| # | Decision | Effet dans cette conception |
|---|---|---|
| P1 | Conservation **jusqu'a suppression**, regroupement par **annee scolaire** (septembre a aout) | Pas de TTL. `schoolYear` derive, filtre `schoolYear`, `schoolYears` (section 3) |
| P2 | Fiche supprimee = ses passages supprimes | `deleteDocTree` etendu |
| P3 | Pas de route d'effacement partiel | Aucune route `DELETE` d'historique |
| P4 | Le parent voit le **detail par question** (juste ou faux), **sans** texte de question ni reponse de l'eleve | `GET /students/{sid}/tests/{testId}`: `questionId`, `rank`, resultat |
| P5 | Reponses gardees, lues par l'eleve seul | `choice` seulement dans `TestQuestionResult` (route eleve); absente de la vue parent et de l'archive |
| P6 | Titre de fiche copie dans le passage | `titre` dans `TEST#` |
| P7 | Meme resume pour les 15 ans et plus | Pas de masquage par l'eleve |
| P8 | Un passage incomplet compte, `answered/total` visible | `status` et `answered`, `total` |
| P9 | Fusion du contrat avec H1-A | Section 8 (pile, CI verte) |
| P10 | Export sous forme d'**archive** telechargeable, lien court et expirant, sans donnee de cours | `POST /family/export/archive` (section 6) |

### Questions tranchees par le proprietaire

- **Q1. Reponses de l'eleve dans l'archive du parent**: non.
- **Q2. Rappel annuel a la rentree**: plus tard, hors de ce lot.
- **Q3. Version de la politique**: `POLICY_VERSION` relevee a la fusion de H1-A (pas avant). Les parents deja inscrits devront reaccepter.
