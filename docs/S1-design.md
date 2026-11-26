# S1 : partage de QCM avec des tiers (#34)

Statut : **conception**, aucun code écrit, **contrat d'API non modifié**, **`POLICY_VERSION` non relevé** (les ajouts de contrat sont proposés en section 10, à intégrer par le lot S1-K).
Base : `main` au commit `8ebf5f8` (contrat 1.11.0, `POLICY_VERSION` 2026-11-28). Dépend de Q1 (banque de questions, fusionnée), H1 (historique, fusionné), ID1 (pseudo et identifiant, fusionné), M1 (modification d'un cours, fusionné) et E1 (exercices, fusionné).
Les coûts et les durées sont **estimés, pas mesurés** (aucun appel n'a été fait pour ce document). Les prix unitaires AWS sont des ordres de grandeur à vérifier avant tout déploiement.

## 0. Résumé des décisions proposées

| Sujet | Proposition |
|---|---|
| Qui crée un partage | **L'élève**, et seulement si le **parent a activé le partage pour cet élève** (désactivé par défaut pour tous, y compris les plus de 15 ans). Le parent voit la liste et peut tout révoquer. |
| Ce qui est partagé | Une **copie figée** de 5 à 20 questions (énoncé, choix, bonne réponse) d'**une** fiche, plus un titre court écrit par l'élève. **Jamais** : cours, photos, schémas, copies d'exercices, affirmations, sources, nom, pseudo, identifiant, points, historique, identifiants internes de fiche ou de question. |
| Quelles questions | Seulement celles dont l'élève **connaît déjà la réponse** au sens du jeu : déjà payées (`rewarded`), ou toutes si la fiche a atteint ses 50 points. Cela empêche de lire la clé d'une question avant de la jouer. |
| Le lien | Jeton de 128 bits au hasard, **jamais stocké** (seul son hachage SHA-256 l'est), montré **une seule fois**. Expire en 1, 7 (défaut) ou 30 jours. Révocable à tout moment par l'élève ou le parent, effet immédiat. |
| Le destinataire | **Anonyme**, sans compte, sans cookie, sans trace de ses réponses. Il joue dans son navigateur, **sans point** pour lui ni pour l'élève. |
| Route publique | Deux routes `POST` sans jeton de connexion (`/shares/open`, `/shares/report`), le jeton dans le **corps** (jamais dans l'URL ni les journaux), et un rôle IAM qui ne lit **que** la partition des partages. |
| Abus | Jeton non devinable, limite de débit par route, plafond de lectures par lien et par jour, 5 liens actifs par élève, signalement par le destinataire, **suspension automatique à 3 signalements**. |
| Suppression | Supprimer la fiche, le cours (avec ses fiches), l'élève ou la famille, ou couper le partage chez le parent, **efface les partages concernés avant le reste**. |
| Points | **Aucun effet** sur les 50 points par fiche, le plafond de 250 par jour ni l'historique. Un partage n'écrit aucune ligne `ATT#` ni `TEST#`. |
| Textes légaux | Commit `docs(legal)` **séparé**, à valider par le propriétaire, sans relever `POLICY_VERSION`. |
| Lots | S1-K, S1-D, S1-A, S1-W, S1-G, S1-T (section 15). Aucun fichier à deux propriétaires, et **aucun fichier de `api/src/game/*`** (le partage ne passe pas par `answers-post`, `session-get` ni `practice-post`). |

## 1. Ce qui existe aujourd'hui (lu dans `main`)

- **Rôles.** Un parent (compte famille) et des élèves (jusqu'à 5 par famille). Les routes élève prennent `sid` dans le jeton (`activeStudent`, `api/src/game/access.ts`), jamais dans la requête. Le parent n'a aucune route qui renvoie un énoncé, un choix ou une réponse (Q1 section 11, H1 P4).
- **Une seule route publique** : `POST /activation` (`public: true` dans `ROUTES`, `HttpNoneAuthorizer`). Son jeton est dans le **corps**, jamais dans le chemin ; réponse `404` unique pour tout jeton inutilisable ; limitation **globale** de la route (1 requête par seconde, rafale 3), pas par IP ni par jeton ; risque accepté en v1 (`docs/api-security.md`). Un test vérifie qu'elle est la seule : S1 devra le faire évoluer (section 14).
- **Pas de limitation par IP.** L'API est une API HTTP (pas de WAF possible) ; la limite d'une route est la même pour tous les appelants.
- **Questions.** `DOC#<docId>` / `QCM#<nn>` et `GAP#<nn>`, avec la clé réservée au serveur. `Question` (contrat) n'a jamais `cle` ni `attendu`. La correction d'un trou utilise `normalizeGap` (`api/src/game/rules.ts`).
- **Points.** Une récompense par question pour toujours (`ATT#<questionId>#<jour>`, `rewarded`), 50 points au plus par fiche (`DOC_XP_CAP`, attribut `xp` des lignes `ATT`), 250 par jour (Q1 section 7). Les questions retirées par une modification de cours portent `retiree` (M1).
- **Suppression en cascade.** `shared/delete-tree.ts` (`deleteDocTree`, `deleteStudentTree`, `deleteFamilyTree`, `deleteCoursTree`) ; chaque type d'élément nouveau doit y être ajouté et son test compte les éléments avant et après.
- **Droits.** Une condition `dynamodb:LeadingKeys` par partition utilisée ; IAM ne filtre pas la clé de tri. Le test « droits déclarés = droits réels » existe pour M1 (`shared/m1-access.ts`, `shared/revise-access.ts`, `infra/test/m1-access.test.ts`) et E1 (`shared/exo-access.ts`, `infra/test/e1-access.test.ts`).
- **Site.** CloudFront devant un bucket privé, `Referrer-Policy: no-referrer` et `X-Frame-Options: DENY` déjà posés ; repli SPA vers `index.html`.
- **Rien sur le partage** : aucun code, aucune route, aucun élément nommé `SHARE` dans `main`.

## 2. Ce qui est partagé, et ce qui ne l'est jamais

**Partagé** : une **copie figée** (« instantané ») de questions, écrite au moment de la création, dans un élément à part. Le destinataire ne lit jamais la fiche, ni la banque, ni la partition de l'élève.

| Champ de la copie | Source | Règle |
|---|---|---|
| `title` | écrit par l'élève | 3 à 60 caractères ; mêmes règles de forme et même liste de mots que le pseudo (`shared/pseudo-rules.ts`, `shared/pseudo-blocklist.ts`), plus : pas de `@`, pas d'adresse web, pas de suite de 6 chiffres. **Pas** repris automatiquement du titre de la fiche (texte libre, éditable). |
| `subject` | matière de la fiche (liste fermée du site) | facultatif |
| `questions[]` (5 à 20) | `QCM#` et `GAP#` de la fiche | `kind`, `prompt`, `choices` (4) et `answer` (indice) pour un QCM ; `prompt` (phrase à trou) et `expected` (mot attendu) pour un trou. Numérotées 1 à N dans la copie. LaTeX permis comme dans `Question` (rendu en texte par le site, jamais en HTML). |
| `createdAt`, `expiresAt` | serveur | |

**Jamais** dans la copie, ni dans aucune réponse publique : le texte du cours, une photo, un schéma, une figure, une copie d'exercice, un exercice E1 (`EXO#`), les affirmations et leurs sources, `docId`, `questionId`, `claimId`, `sid`, `fid`, nom, pseudo, identifiant de connexion, niveau scolaire, indicateur « moins de 15 ans », points, série, historique, `loginId`. Un test de contrat (section 14) vérifie que le schéma public ne contient aucun de ces noms.

**Filtre à la création** (côté serveur, fonction pure `shared/share-rules.ts`) : une question est **écartée** (et l'élève voit « écartée : elle contient une donnée personnelle ») si son texte contient une adresse e-mail, un numéro de téléphone, une adresse web, le pseudo ou l'identifiant de connexion de **n'importe quel** élève de la famille. Raison : le texte d'une question vient d'une affirmation tirée du cours, que l'élève a pu corriger ou compléter (M1) ; la liste de mots et l'écart de forme ne garantissent pas l'absence d'un nom propre (limite dite, section 13).

**Question dépendant d'une figure** : écartée si la question renvoie à une figure ou à un schéma (le contrat actuel de `Question` n'en porte pas ; à confirmer dans le code par S1-A).

## 3. Qui peut partager

| Acteur | Peut |
|---|---|
| **Élève** (partage activé par le parent) | choisir des questions, créer un lien, voir ses liens (titre, dates, nombre de lectures, état), révoquer un lien. Ne revoit **jamais** un lien déjà créé (il n'est pas stocké). |
| **Parent** | activer ou couper le partage **par élève** ; voir la liste des liens de ses élèves (titre, nombre de questions, dates, lectures, état, jamais le contenu des questions ni le lien) ; **révoquer** n'importe quel lien. Ne crée pas de partage (il n'a pas accès aux questions : Q1 section 11). |
| **Destinataire** | ouvrir, jouer, signaler. Rien d'autre. |

- **Pourquoi le parent d'abord** (réponse au ticket) : le ticket dit « accord du parent ou désactivable par le parent » pour les moins de 15 ans. Un seul réglage suffit pour tous : **désactivé par défaut**, le parent l'active élève par élève, ce qui vaut accord. Même règle pour les plus de 15 ans : le compte est créé et géré par le parent, et une règle unique est plus simple à tester et à expliquer. Alternative écartée : accord par lien (le parent n'a pas accès au contenu, donc il approuverait à l'aveugle).
- **Réglage** : attribut `sharing` (booléen, absent = faux) de l'élément élève, modifié par `PATCH /students/{sid}` (route parent existante, rôle `manage` existant).
- **Couper le partage** : `PATCH` avec `sharing: false` **supprime tous les liens de l'élève** dans la même requête (section 8). Un lien déjà donné cesse de fonctionner immédiatement.
- **Élève suspendu** (`statut: suspendu`) : ne crée rien (`activeStudent`) ; ses liens existants restent valides jusqu'à leur échéance, le parent peut les révoquer.

## 4. Le lien : jeton, expiration, révocation

- **Jeton** : 16 octets de `crypto.randomBytes`, encodés en base64url (22 caractères), soit **128 bits**. Deviner un jeton valide est hors de portée : même à 3 requêtes par seconde pendant un an (environ 10⁸ essais), la probabilité de succès est de l'ordre de 10⁻³¹ avec un seul lien actif (10⁶ liens actifs : de l'ordre de 10⁻²⁵).
- **Stockage** : seul `SHA-256(jeton)` en hexadécimal sert de clé (`SHARE#<hache>`). Une fuite de la table ne donne **aucun lien utilisable**. Le jeton est renvoyé **une fois**, dans la réponse de création. Pour partager à nouveau, l'élève crée un nouveau lien (nouvelle expiration, nouveau jeton).
- **Forme du lien** : `https://<site>/p#t=<jeton>`. Le jeton est dans le **fragment** (`#`), donc jamais envoyé au serveur par le navigateur, absent de l'en-tête `Referer` (déjà `no-referrer`), des journaux CloudFront et des journaux d'accès de l'API. La page lit le fragment puis appelle `POST /shares/open` avec le jeton dans le **corps** (même principe que `POST /activation`). Le journal d'accès de l'API ne contient pas les corps (`docs/api-security.md`).
- **Expiration** : choix de l'élève, **1, 7 (défaut) ou 30 jours**, jamais illimité. `expiresAt` est **contrôlé par le code à chaque ouverture** ; le `ttl` DynamoDB (`expiresAt` + 2 jours) ne sert qu'au nettoyage, car DynamoDB peut supprimer jusqu'à 48 h après l'échéance (même raisonnement que `EXPORT#`). Durée maximale d'existence d'une copie après sa dernière utilité : 32 jours.
- **Révocation** : `DELETE` de l'élément `SHARE#<hache>` (suppression, pas drapeau) puis de la référence de l'élève. Effet **immédiat** : la lecture suivante ne trouve rien. Les réponses de l'API portent `Cache-Control: no-store`. Un navigateur qui a déjà chargé le QCM le garde jusqu'à fermeture de l'onglet : **limite dite**, rien ne rappelle une page déjà ouverte.
- **Réponse uniforme** : jeton inconnu, expiré, révoqué, suspendu, plafond du jour atteint : la **même** réponse `404` (`lien_indisponible`), même corps, sans différence de temps mesurable voulue (une lecture d'élément dans tous les cas ; limite : le chemin « trouvé » fait en plus une écriture de compteur, section 7).
- **Plafonds par élève** : **5 liens actifs** au plus et **10 créations par jour** ; **10 liens actifs par famille**. Un lien expiré ou révoqué ne compte plus. Compteurs : liens actifs = nombre de références `SHAREREF#` non expirées de l'élève (au plus 5, une `Query` de préfixe) ; créations du jour = élément `STUDENT#<sid>` / `SHAREJ#<jour>` avec `ttl` de 2 jours, incrémenté **dans la même transaction** que la création (même méthode que `REVJ#` de M1, rien ne se compte en cas d'échec).

## 5. Accès du destinataire : anonyme, sans point

**Décision proposée : anonyme, sans compte, sans point, pas d'import.**

| Question du ticket | Réponse proposée | Raison |
|---|---|---|
| Lien public ou seulement vers un compte QCMonster ? | **Lien public, anonyme.** | Un camarade, un parent ou un professeur n'a pas de compte ; créer un compte exige une invitation et un parent (l'application est sur invitation). Un partage « vers un compte » demanderait de désigner un autre élève, donc de **mettre en relation des mineurs de familles différentes** : écarté. |
| Le destinataire peut-il jouer et gagner des points ? | **Il joue, sans point.** Correction faite **dans son navigateur** ; rien n'est envoyé ni enregistré. | Aucun point de jeu hors du compte de l'élève : pas d'écriture `ATT#`, pas de tricherie possible (un élève ne peut pas s'envoyer des points en ouvrant son propre lien), pas de donnée de plus sur le destinataire. |
| Le destinataire connecté a-t-il un avantage ? | **Non.** Un élève connecté ouvre le lien comme n'importe qui. Pas de bouton « ajouter à mes questions ». | Un import créerait des questions sans affirmation ni vérification dans une banque (Q1) et un plafond de points à définir. Hors périmètre : à rouvrir plus tard si le propriétaire le veut. |

- **Clé envoyée au navigateur.** La réponse publique contient les bonnes réponses : le but est de **partager le QCM**, et la correction locale évite une route de plus à protéger et une écriture par réponse. Conséquence acceptée : quelqu'un qui a le lien voit les réponses.
- **Comparaison d'un trou** : la même fonction que le serveur (`normalizeGap`) est importée par le site, comme `shared/policy.ts` ; aucune réimplémentation.
- **Page** `/p` : aucune bibliothèque tierce nouvelle, aucun script ni police externe, aucun cookie, aucun `localStorage` ; `<meta name="robots" content="noindex">` ; bannière « QCM partagé par un élève, non relu par un enseignant » et bouton « Signaler ». Le mélange de l'ordre des choix est fait par le navigateur.

## 6. Modèle de données

Nouvelle partition **`SHARE#<hache>`**. Elle existe pour une seule raison : le rôle de la route publique ne lit **que** cette partition (`LeadingKeys`), donc même une faille dans la route publique n'atteint ni `STUDENT#`, ni `DOC#`, ni `FAMILY#`.

| Type | PK | SK | Attributs | Écrit par |
|---|---|---|---|---|
| Partage (copie) | `SHARE#<hache>` | `META` | `shareId` (ULID), `title`, `subject?`, `questions[]` (section 2), `createdAt`, `expiresAt`, `state` (`actif` ou `suspendu`), `reports` (entier), `docRev` (valeur de `rev` de la fiche à la copie), `ttl`. Environ **12 Ko** pour 20 questions (limite 400 Ko). **Aucun** champ d'identité (`sid`, `fid`, `docId` absents). | `shares-create` seul ; `shares-open` met à jour `reports` et `state` |
| Compteur de lectures | `SHARE#<hache>` | `DAY#<aaaa-mm-jj>` | `n` ; `ttl` 2 jours. Plafond **1 000 lectures par lien et par jour**, mis à jour avec une **condition** `n < 1000`. | `shares-open` seul |
| Signalement | `SHARE#<hache>` | `REPORT#<ulid>` | `reason` (`inapproprie`, `donnees_perso`, `autre`), `at`, `ttl` 30 jours. **Aucun texte libre, aucune adresse IP, aucun identifiant du signaleur.** | `shares-report` (même fonction que `shares-open`) |
| Référence (propriétaire) | `STUDENT#<sid>` | `SHAREREF#<shareId>` | `hash` (pour supprimer la copie), `docId`, `title`, `count` (nombre de questions), `createdAt`, `expiresAt`, `ttl` (échéance + 2 jours). **Pas de jeton.** | `shares-create` ; supprimée par `shares-manage` |
| Compteur de créations | `STUDENT#<sid>` | `SHAREJ#<aaaa-mm-jj>` | `n`, `ttl` 2 jours | `shares-create` |

- **Pourquoi une copie et pas une référence** : une référence obligerait la route publique à lire `DOC#` (les clés de réponse), donc à avoir ce droit. La copie coûte 12 Ko par lien et rend l'isolation vraie.
- **Le nombre de lectures** montré à l'élève et au parent est la somme des `DAY#` : la route de liste lit `SHARE#<hache>` avec une `Query` (au plus 31 éléments `DAY#`, plus `META`) ; au plus 5 liens par élève.
- **Le parent ne reçoit que** `title`, `count`, `createdAt`, `expiresAt`, `state`, `reads`, `reports` (jamais les questions).
- **Fiche corrigée après la copie (M1)** : la copie reste figée. `shares-manage` compare `docRev` à `rev` de la fiche (élément `STUDENT#<sid>` / `DOC#<docId>`, partition déjà lue) et renvoie `outdated: true` si la fiche a été modifiée depuis ; le site affiche « La fiche a été corrigée depuis : refais un lien ». **Aucune révocation automatique** (point S1-P13). Un lien dont la fiche est supprimée n'existe plus (section 8).
- **Changements de données** : champ facultatif `sharing` (élément élève, `shared/items.ts`), schémas Zod des cinq types ci-dessus, `keys.share`, `keys.shareRef`, `keys.shareDay`, `keys.shareCreateDay`, ligne dans `docs/data-model.md`. Aucun élément existant n'est modifié ni migré.

## 7. Abus : énumération, débit, signalement, modération

**Énumération.** Les 128 bits rendent la recherche de liens impraticable (section 4). La route publique renvoie une réponse unique pour tout lien inutilisable (section 4). `POST /shares/open` ne renvoie **jamais** d'identifiant, de liste ni de lien voisin.

**Débit.** Les limites d'API Gateway sont par route et **globales** (pas par IP) : un tiers peut épuiser la route et empêcher un destinataire de lire (même risque que `POST /activation`, accepté en v1). Réglages proposés (`ROUTES`) : `POST /shares/open` **3 requêtes par seconde, rafale 6** ; `POST /shares/report` **1 par seconde, rafale 3** ; routes connectées : création 1/s rafale 3, liste 5/s rafale 10, suppression 2/s rafale 5. Une route publique saturée ne gêne **aucune autre route**. Défense plus fine (par IP) = **WAF devant CloudFront**, hors périmètre : coût fixe d'environ 6 € par mois pour une ACL et une règle (ordre de grandeur, à vérifier) et une API à placer derrière CloudFront ; à reprendre si l'usage sort du cercle familial (point S1-P16).

**Plafonds par lien.** 1 000 lectures par jour et par lien : au-delà, la même réponse `404`. Cela protège contre un lien diffusé largement par erreur et contre un coût de lecture non voulu. L'élève voit le nombre de lectures et peut révoquer.

**Interrupteur.** Une variable d'environnement `SHARE_PUBLIC_ENABLED` de la fonction publique (valeur `false` : `404` immédiat sans lecture de table) coupe tout accès public en un redéploiement, sans toucher aux données.

**Signalement.** Un destinataire (qui a forcément le jeton : seul un détenteur du lien peut signaler, donc aucun tiers ne peut suspendre le lien de quelqu'un d'autre) choisit un motif dans une liste fermée. Chaque appel écrit un `REPORT#` et incrémente `reports` ; **à 3 signalements, `state` passe à `suspendu`** et le lien répond `404`. Plusieurs signalements d'une même personne comptent plusieurs fois (le destinataire est anonyme : on ne peut pas distinguer ; un seul détenteur de lien peut donc suspendre ce lien en 3 appels, ce qui est sans gravité, le lien étant le sien à ouvrir).

**Modération.** Pas de file d'attente humaine : l'échelle est familiale et le propriétaire n'a aucun accès au contenu des questions de ses utilisateurs (pas de lecture de la partition de l'élève hors besoin). Le dispositif est : filtre à la création (section 2), suspension automatique, **information du parent dans la liste** (« suspendu après 3 signalements »), révocation par le parent. Le parent ne voit pas le contenu : il ne peut juger que d'après le titre, le nombre de questions et les signalements. Alerte au propriétaire : **non en v1** (point S1-P11) ; si elle est voulue, elle réutilise le mécanisme d'alerte par e-mail du budget (sujet SNS, abonnement à confirmer par le propriétaire) et n'envoie **que** « n signalements ce jour », jamais un titre ni une question.

**Abus par l'élève lui-même.** Écartés par construction : partage limité aux questions déjà connues (sections 0 et 9), pas de point pour le partage ni pour les lectures, 5 liens actifs et 10 créations par jour, filtre à la création.

## 8. Suppression en cascade

La règle générale est : **la copie publique est supprimée d'abord**, puis le reste. Si la suppression de la copie échoue, l'opération échoue et rien d'autre n'est supprimé (aucune copie orpheline publique). Le `ttl` (échéance + 2 jours, 32 jours au plus) est un filet, pas la garantie.

| Événement | Effet sur les partages |
|---|---|
| `DELETE /docs/{docId}` (`deleteDocTree`) | Les références `SHAREREF#` de l'élève dont `docId` est la fiche sont listées (`Query` de préfixe, 5 au plus), leurs copies `SHARE#<hache>` supprimées (`META`, `DAY#`, `REPORT#`), puis les références, puis la fiche. |
| `DELETE /cours/{coursId}?fiches=supprimer` (`deleteCoursTree` puis `deleteDocTree` par fiche) | Idem, pour chaque fiche. Avec `fiches=garder` : **aucun effet** (les fiches restent). |
| Échec du scan (`failJob`) | Aucun effet (aucune fiche orpheline n'a de partage, un partage exige une question déjà payée). |
| `DELETE /students/{sid}` (`deleteStudentTree`) | **Avant** la suppression de tout ce qui n'est pas `DOC#` : toutes les références de l'élève sont listées, leurs copies supprimées. |
| `DELETE /family` (`deleteFamilyTree`) | Pour chaque élève, idem. |
| `PATCH /students/{sid}` avec `sharing: false` | Toutes les références de l'élève, copies d'abord. |
| `DELETE /me/shares/{shareId}` ou route parent | La copie, puis la référence. |
| Modification du cours (M1) | Aucune suppression ; `outdated` seulement (section 6). Le rôle `revise` **ne reçoit aucun droit** sur `SHARE#*`. |
| Suspension après signalements | La copie reste (état `suspendu`), pour que l'élève et le parent voient pourquoi ; supprimée à la révocation, à l'expiration ou à la suppression de l'élève. |

Fonction commune `deleteSharesOf(studentId, filtre)` dans `shared/delete-tree.ts` (propriétaire : lot S1-D, section 15). Le port `TreeDb` gagne la liste des références (`Query` de préfixe `SHAREREF#`, **déjà couverte** par `STUDENT#*`) et la suppression sur `SHARE#*`. Test (`shared/delete-tree.test.ts`, qui **compte les éléments avant et après**) : fiche supprimée avec 2 liens (plus aucun `SHARE#`, plus de `SHAREREF#`), cours supprimé avec `garder` (liens conservés), élève supprimé, famille supprimée, partage coupé, **échec de suppression d'une copie** (la fiche reste, erreur levée, rien d'orphelin), **un lien d'une autre fiche n'est pas touché**.

## 9. Points (50 par fiche), historique et autres fonctions

- **Plafond de 50 points par fiche.** Le partage n'écrit aucune ligne `ATT#`, aucun `PROFILE`, aucun `DAY#` de jeu. Le plafond, `rewarded`, `xp`, la série de 10 et le plafond de 250 par jour **ne changent pas**. Test : un partage créé et ouvert laisse `PROFILE`, `ATT#` et `DAY#` identiques.
- **Pourquoi seulement les questions « déjà connues »** (point S1-P5). Sans cela, un élève verrait la bonne réponse de questions qu'il n'a pas encore jouées, puis gagnerait les points de la fiche en les rejouant (les 50 points sont plafonnés, mais un lien suffirait à les prendre tous sans connaître le cours). Règle : une question est **partageable** si une ligne `ATT#<questionId>#` porte `rewarded`, **ou** si les lignes `ATT#<docId>:` de la fiche totalisent déjà 50 points payés (même lecture que le tirage de Q1 : une `Query` de préfixe, aucune écriture). Une question jamais réussie n'est pas partageable : l'écran de choix la montre grisée (« réponds-y d'abord »), sans énoncé ni réponse. La route de choix (`GET /docs/{docId}/shareable`) ne renvoie les réponses que des questions partageables. Une ancienne fiche sans `xp` compte 5 par `rewarded` (règle de Q1) : une fiche peut donc être jugée « pleine » un peu tôt, jamais plus tard ; **risque accepté**, la différence est d'au plus 15 points.
- **Historique (H1).** Aucun `TEST#`. Les destinataires ne laissent aucune trace. Pour l'élève, la liste de ses liens n'est pas dans l'historique des tests ; elle n'est pas exportée en archive avec les passages (section 13 pour l'export).
- **Banque (Q1).** La copie est prélevée dans les questions **non retirées** (`retiree` de M1 exclu). Un partage ne retire rien de la banque et ne compte pas dans le tirage.
- **Exercices (E1).** Ni exercices, ni copies, ni solutions : seulement `QCM#` et `GAP#`. Un test vérifie qu'aucun préfixe `EXO#` n'est lu par `shares-create`.
- **Dossiers.** Un partage porte sur **une** fiche. Les partages multi-fiches ou de dossier sont hors v1 (point S1-P14).
- **Export de l'élève (H1-B).** `GET /family/export` et l'archive ne contiennent pas les copies (qui ne sont pas des données de l'élève au sens du parcours) mais la **liste des liens** (titre, dates, état, sans jeton) : une ligne par lien, ajoutée par le lot S1-A. Point S1-P15.

## 10. Contrat proposé (additif, 1.12.0 provisoire, **non appliqué**)

À intégrer par S1-K. Le numéro de version est le **premier libre au moment de la fusion** (pas d'autre PR de contrat ouverte au 2026-11-26).

| Route | Qui | Corps / réponse |
|---|---|---|
| `GET /docs/{docId}/shareable` | élève | `{ questions: [{ questionId, kind, prompt, choices?, answer?, expected?, shareable, reason? }] }` : seules les questions partageables portent `answer` ou `expected` ; `reason` ∈ `a_jouer`, `donnee_personnelle`, `retiree`. |
| `POST /me/shares` | élève | `{ docId, questionIds[5..20], title, ttlDays: 1\|7\|30 }` → `201 { shareId, token, expiresAt }` ; `token` **n'est renvoyé qu'ici**. Erreurs : `403` (partage coupé), `404` (fiche inconnue), `409 questions_non_partageables`, `429 plafond_partages`, `400 titre_refuse` (comme `pseudo_refuse`). |
| `GET /me/shares` | élève | `{ shares: [{ shareId, title, count, createdAt, expiresAt, state, reads, reports, outdated }] }` |
| `DELETE /me/shares/{shareId}` | élève | `204`, `404` si inconnu ou d'un autre élève (indiscernable) |
| `GET /students/{sid}/shares` | parent | même forme, **sans** `outdated` ni contenu |
| `DELETE /students/{sid}/shares/{shareId}` | parent | `204` |
| `PATCH /students/{sid}` | parent | champ `sharing: boolean` ajouté à `StudentUpdate` ; `Student.sharing` ajouté à la lecture |
| `POST /shares/open` | **public** | `{ token }` → `200 { title, subject?, questions[], expiresAt }` ou `404 lien_indisponible` unique |
| `POST /shares/report` | **public** | `{ token, reason }` → `204` ou `404 lien_indisponible` |

- Les deux routes publiques ont `security: []` et `public: true` dans `ROUTES`. Le test qui dit « `POST /activation` est la seule route sans JWT » devient « les routes publiques sont **exactement** : `/activation`, `/shares/open`, `/shares/report` ».
- Le schéma public `SharedQuiz` n'a **que** les champs de la section 2 : test de contrat par liste blanche.
- Pas de chemin avec jeton (`/shares/{token}`) : le jeton dans le chemin se retrouverait dans les journaux d'accès.
- Version : 1.12.0 (additif, aucune rupture). `info.version`, `generated/*` et `ROUTES` sont écrits par S1-K seul.

## 11. Droits IAM minimaux, par rôle

Aucun ARN complet ni ID de compte dans ce document ni dans le dépôt. Convention de `main` : `dynamodb:LeadingKeys` (`ForAllValues:StringLike`, `Null` à faux) sur les partitions utilisées ; IAM ne filtre pas la clé de tri. Chaque ligne indique ce que le handler **lit**, **écrit** (avec l'action : `put` = `PutItem`, `update` = `UpdateItem`, `batch` = `BatchWriteItem`, `delete` = `DeleteItem`) et fait en **nettoyage ou échec** (leçon des relectures #95, #96 et #99 : les droits sont écrits d'après ce que la fonction **fait en cas d'échec**, pas seulement d'après ce qu'elle crée). Aucun rôle de cette conception n'a S3, Bedrock, Step Functions ni `COST#`.

| Rôle | Fonctions | lit | écrit | nettoyage, échec | Remarque |
|---|---|---|---|---|---|
| **`shareMake`** (nouveau) | `shares-shareable`, `shares-create` | `STUDENT#*` : `GetItem`, `Query` (élève, fiche, `ATT#<docId>:`, `SHAREREF#`) ; `DOC#*` : `GetItem`, `Query` (`QCM#`, `GAP#` : **clés de réponse**) ; `FAMILY#*` : `GetItem` (`activeStudent`), `Query` (noms de la famille pour le filtre) | transaction de création : `SHARE#*` `put` (`META`) ; `STUDENT#*` `put` (`SHAREREF#`) et `update` (`SHAREJ#`) | échec de la transaction : rien d'écrit (une seule transaction, moins de 8 éléments) | Rôle exposé à une route, seul à lire les clés. Ne lit **aucune** partition `JOB#*`, aucun `EXO#`. |
| **`shareManage`** (nouveau) | `shares-list`, `shares-delete`, `shares-parent-list`, `shares-parent-delete` | `STUDENT#*` : `GetItem`, `Query` (références, `rev` de la fiche) ; `FAMILY#*` : `GetItem`, `Query` (`callerOf` parent) ; `SHARE#*` : `GetItem`, `Query` (lectures, signalements) | `SHARE#*` : `batch` ; `STUDENT#*` : `delete` | échec au milieu : la copie est supprimée **avant** la référence ; une référence sans copie est supprimée au rejeu (idempotent) | **Pas de `DOC#*`** : ce rôle ne peut jamais lire une clé de réponse. Test de synthèse. |
| **`sharePublic`** (nouveau) | `shares-open`, `shares-report` | `SHARE#*` : `GetItem` (`META`) | `SHARE#*` : `update` (`META.reports`, `META.state`, compteur `DAY#` conditionnel), `put` (`REPORT#`) | refus par le plafond du jour : `update` conditionnel refusé, rien d'écrit | **Aucun `Query`**, aucune autre partition, aucune écriture hors `SHARE#*`. Variable `SHARE_PUBLIC_ENABLED`. |
| **`manage`** (existant) | `students-update` (nouveau champ `sharing`) | + `STUDENT#*` : `Query` (références, déjà permis) | + `SHARE#*` : `batch` | idem `shareManage` | Seul ajout : la partition `SHARE#*` pour la suppression. |
| **`deleteRole`** (existant) | `docs-delete` | inchangé (`STUDENT#*` : `Query` des références) | + `SHARE#*` : `batch` | la copie d'abord ; en cas d'échec, la fiche n'est pas supprimée | |
| **`coursRole`** (existant) | `cours-delete` | inchangé | + `SHARE#*` : `batch` | idem | `fiches=garder` : aucune écriture sur `SHARE#*` (test) |
| **`admin`** (existant) | `students-delete`, `family-admin` | inchangé | + `SHARE#*` : `batch` | idem | |
| **`play`**, **`confirmRole`**, **`revise`**, **`revise-start`**, **`pipeline-role`**, **`verify-role`**, **`coursReadRole`**, **`readRole`**, **`writeRole`** | | | | | **Aucun droit nouveau.** `revise` ne touche pas aux partages (section 8). |

**Un seul fichier source des droits** : `shared/share-access.ts` (sur le modèle de `shared/revise-access.ts` et `shared/exo-access.ts`) déclare, par handler, les partitions et actions ; `infra/lib/share-access.ts` en dérive les instructions IAM.

**Test « droits déclarés = droits réels »** (même méthode que M1 7.3) :
1. **Enregistreur d'accès** : un enrobage de `Db` et du port de suppression qui note chaque appel `(action, partition)` ; `api/src/shares/access.test.ts` rejoue, pour **chaque** handler, les scénarios chemin heureux, refus (partage coupé, plafond), échec en milieu de travail, nettoyage et rejeu, et vérifie que tout ce qui est observé est **déclaré** dans `shared/share-access.ts`.
2. **Synthèse** (`infra/test/s1-access.test.ts`) : le gabarit synthétisé de chaque rôle est comparé à la même source **dans les deux sens** (un droit déclaré et absent, ou accordé et non déclaré, fait échouer).
3. **Cas obligatoires** : `shares-open` n'écrit rien hors `SHARE#*` ; `shareManage` n'a pas `DOC#*` ; `sharePublic` n'a ni `Query` ni autre partition ; `docs-delete` avec 2 liens ; `cours-delete` avec `garder` (aucune écriture `SHARE#*`) ; `students-delete` ; `students-update` avec `sharing: false` ; `shares-create` ne lit ni `JOB#*` ni `EXO#`.
4. **Limites dites** : le test ne voit que ce que les scénarios exercent ; IAM ne filtre pas la clé de tri ; il ne remplace pas un essai réel sur l'environnement de développement (section 14).

## 12. Coûts estimés (non mesurés)

Hypothèses de prix unitaires (ordres de grandeur, **à vérifier avant déploiement**) : écriture DynamoDB à la demande environ 0,7 € le million d'unités, lecture environ 0,15 € le million, API HTTP environ 1 € le million de requêtes, Lambda environ 0,3 € le million pour 128 Mo et 50 ms.

| Poste | Estimation |
|---|---|
| Création d'un lien (copie de 12 Ko, référence, compteur) | environ 15 unités d'écriture, **moins de 0,00002 €** |
| Ouverture d'un lien (lecture de 12 Ko, compteur du jour) | environ 1,5 unité de lecture et 1 d'écriture, plus API et Lambda : **environ 0,000002 €** |
| Usage familial (5 élèves, 10 liens par mois, 20 ouvertures par lien) | **moins de 0,01 € par mois** |
| **Pire cas : route publique saturée en permanence** à 3 requêtes par seconde | environ 7,8 millions de requêtes par mois, soit **environ 10 € par mois** (API et Lambda dominent). Les requêtes refusées par la limite d'API Gateway ne coûtent pas de Lambda. |
| Ressources nouvelles | **trois rôles, cinq fonctions, aucune table, aucun bucket, aucun index** (la partition `SHARE#` est dans la table existante). Stockage : 12 Ko par lien, négligeable. |
| WAF (hors périmètre) | environ 6 € par mois fixes, plus la mise de l'API derrière CloudFront : non retenu en v1 |

Le pire cas est borné par la limite de la route (réglable, et à 0 en dernier recours) et vu par l'alerte de budget existante. **Estimation à faire valider par le propriétaire avant tout déploiement de ressources nouvelles**, toutes taguées `Project`, `Environment`, `ManagedBy`, `Owner`.

## 13. Vie privée : analyse d'impact et textes légaux

### 13.1 Ce qui change pour la vie privée

- **Première donnée qui sort de la famille.** Jusqu'ici, rien de ce que l'élève produit n'est lisible hors de l'application et de sa famille. Une copie de questions devient lisible par toute personne qui a le lien, **sans compte ni vérification d'identité**, y compris un enfant. C'est la rupture que la conception encadre.
- **Pas de donnée personnelle du destinataire** : pas de cookie, pas de compte, pas d'adresse IP conservée par l'application (les journaux d'accès AWS de l'API gardent ce qu'ils gardent aujourd'hui, 14 jours, sans corps ni jeton), pas de réponses enregistrées, pas de traceur, aucune bibliothèque tierce sur la page `/p`.
- **Pas de donnée personnelle de l'élève dans la copie** (section 2) ; le **titre** est un texte libre (3 à 60 caractères) écrit par un mineur, filtré (forme, liste de mots, adresses, nombres) mais pas relu.
- **Base légale** : consentement du titulaire de l'autorité parentale pour les moins de 15 ans, **par activation du partage** (désactivé par défaut) ; pour les autres élèves, même mécanisme (le compte est géré par le parent).

### 13.2 Risques (lignes à ajouter à l'AIPD, section 4)

| Risque | Gravité | Probabilité | Mesures | Risque restant |
|---|---|---|---|---|
| **Texte d'un mineur diffusé par un lien public** (titre libre, énoncés dérivés du cours qu'il a pu corriger ou compléter) | Moyenne | Moyenne | Partage désactivé par défaut et activé par le parent ; copie sans identité ; filtre des adresses, téléphones, pseudos et identifiants de la famille ; titre filtré ; aperçu avant création ; expiration de 30 jours au plus ; révocation immédiate par l'élève ou le parent | À évaluer. **Limite : un nom propre dans un énoncé n'est pas détecté** (pas de détecteur de noms) |
| **Lien transmis plus loin que prévu** (le destinataire le republie) | Moyenne | Moyenne | Jeton non devinable, expiration, plafond de 1 000 lectures par jour, révocation, aucune donnée d'identité derrière le lien | Accepté : on ne peut pas empêcher une personne de recopier des questions |
| **Contenu inapproprié diffusé** (titre ou énoncé) | Moyenne | Faible | Filtre à la création, signalement, **suspension automatique à 3 signalements**, information du parent | À évaluer ; pas de modération humaine |
| **Droits d'auteur d'un cours** (les questions viennent d'un cours d'enseignant) | Faible | Moyenne | Seulement des questions vérifiées contre des sources, jamais le texte du cours ni ses figures ; bannière « non relu par un enseignant » | À faire relire par la personne compétente |
| **Accès non voulu à d'autres données par la route publique** | Élevée | Faible | Copie dans une partition à part, rôle limité à cette partition, aucun `Query`, test « droits déclarés = droits réels » | Faible |
| **Réponses lues avant d'être jouées par l'élève** (points) | Faible | Moyenne | Partage limité aux questions déjà payées ou à la fiche pleine | Faible |
| **Surveillance du destinataire** | Faible | Faible | Aucun cookie, compte ni traceur ; correction dans le navigateur | Faible |
| **Copie qui survit à la fiche** | Moyenne | Faible | Suppression en cascade, copie supprimée **avant** la fiche, `ttl` de secours (32 jours au plus) | Faible |

### 13.3 Commit légal (séparé, `docs(legal)`, **à valider par le propriétaire**)

Un **commit distinct** de cette PR modifie `docs/legal/*`. Ce sont des textes de travail pour la personne compétente (déjà un point ouvert de l'AIPD), pas un avis juridique. **`POLICY_VERSION` n'est pas relevé** (`shared/policy.ts` et la ligne `**Version : …**` de la politique restent à 2026-11-28 ; un test les compare) : la hausse commune se décide à part, comme pour Q1, E1 et M1. Le texte décrit une fonction **pas encore livrée** : il est écrit au conditionnel (« quand la fonction de partage sera disponible », même formule que pour M1).

| Fichier | Changement |
|---|---|
| `docs/legal/registre.md` | Ligne **T5c « Partage de QCM par lien »** : finalité (partager des questions avec une personne de son choix), personnes (élèves dont mineurs ; destinataires anonymes), données (copie de questions, titre, dates, compteur de lectures, signalements ; **aucune donnée du destinataire**), base légale (consentement du titulaire de l'autorité parentale, par activation du partage), destinataires (toute personne ayant le lien), durée (1 à 30 jours ; plus 2 jours techniques ; effacement avec la fiche, l'élève ou la famille), mesures. |
| `docs/legal/politique-confidentialite.md` | « Quelles données » : la copie partagée. « Combien de temps » : ligne **liens de partage** (au plus 30 jours, effacés avec la fiche, l'élève ou la famille, ou quand le parent coupe le partage). « Qui voit les données » : **toute personne qui a le lien**, sans compte ; le parent voit la liste mais pas les questions. « Tes droits » : le parent coupe le partage ou révoque un lien à tout moment. Un encadré simple : « Ne mets jamais de nom ni de coordonnées dans le titre ». |
| `docs/legal/aipd-brouillon.md` | Les lignes de la section 13.2, et un point ouvert pour la personne compétente (droits d'auteur, filtre des noms propres, diffusion à des mineurs d'autres familles). |
| `docs/legal/sous-traitants.md` | **Aucun changement** : pas de sous-traitant nouveau (même table DynamoDB, mêmes Lambda). |

## 14. Tests

- **Contrat** : routes et schémas de la section 10 ; `SharedQuiz` par liste blanche (aucun des champs interdits de la section 2) ; test des routes publiques (exactement trois) ; `Question` inchangée ; `sharing` facultatif dans `Student`.
- **Règles pures** (`shared/share-rules.test.ts`) : titre (forme, liste de mots, `@`, adresse, chiffres) ; filtre des questions (e-mail, téléphone, adresse web, pseudo et identifiant d'un frère) ; partageable (payée, fiche pleine, ancienne fiche sans `xp`, retirée) ; jeton (longueur, alphabet, pas de collision sur 10 000 tirages) ; hachage.
- **Handlers** : isolation (une fiche, un lien ou une référence d'un autre élève ou d'une autre famille : `404` indiscernable d'un inconnu) ; `sid` toujours issu du jeton ; création refusée si `sharing` faux, élève suspendu, plafonds (5 actifs, 10 par jour, 10 par famille), question non partageable ; **transaction** (un échec ne laisse ni copie ni compteur ; deux créations simultanées ne dépassent pas le plafond) ; ouverture (valide, expirée, révoquée, suspendue, plafond du jour : **même corps et même statut** `404`) ; signalement (compteur, suspension à 3, motif hors liste refusé) ; `Cache-Control: no-store` ; **aucun jeton, titre ni question dans les journaux** (test comme celui des journaux de Q1).
- **Points et historique** : après création et ouverture, `PROFILE`, `ATT#`, `DAY#`, `TEST#` identiques (comparaison avant et après).
- **Suppression en cascade** : section 8 (comptage avant et après).
- **Droits** : section 11 (`access.test.ts`, `s1-access.test.ts`).
- **Site** : lien reconstruit avec le fragment ; la page `/p` n'écrit ni cookie ni `localStorage` (test) ; aucun appel hors API ; `noindex` ; correction d'un trou avec `normalizeGap` ; clavier et lecteur d'écran sur l'écran de choix ; **captures PC et mobile relues avant rapport** ; écrans clairs, vifs et joyeux (pas de thème sombre).
- **e2e** (faux modèle, aucun appel réel) : le parent active le partage ; l'élève ne voit pas les questions non jouées ; il crée un lien ; un navigateur sans session l'ouvre et joue ; l'élève révoque ; la page répond « lien indisponible » ; la suppression de la fiche supprime un lien actif.
- **Essai réel sur l'environnement de développement** (**jamais fait ici**) : création et ouverture avec un vrai jeton de 22 caractères, vérification que le journal d'accès ne contient pas le jeton, mesure du temps réel d'ouverture, essai de la limite de débit.

## 15. Découpage en lots, un seul propriétaire par fichier

Ordre : **K → D → A → W → G** ; **T** à la fin. S1-D (droits et suppression) ne dépend que de S1-K ; S1-A le suit pour que le test de droits existe **avant** les handlers (leçon de M1-D). Aucune PR de lot n'est ouverte à ce jour sur ces fichiers (au 2026-11-26) ; en cas de conflit avec un lot qui arrive, **l'ordre de fusion tranche, le second rebase**.

| Lot | Contenu | Fichiers propres |
|---|---|---|
| **S1-K** contrat et modèle | routes, schémas, erreurs, version 1.12.0 ; schémas Zod et clés ; ligne `ROUTES` des cinq fonctions et des deux routes publiques ; adaptation du test « routes publiques » | `shared/contract/openapi.yaml`, `shared/contract/generated/*`, `infra/lib/api-stack.ts` (table `ROUTES`), `shared/items.ts` (`sharing`, types `SHARE`), `shared/ddb/keys.ts`, `docs/data-model.md`, `infra/test/stacks.test.ts` (test des routes publiques) |
| **S1-D** droits et suppression | `shared/share-access.ts`, rôles `shareMake`, `shareManage`, `sharePublic`, droits ajoutés à `manage`, `deleteRole`, `coursRole`, `admin` ; **test statique des droits** ; `deleteSharesOf` | `shared/share-access.ts`, `infra/lib/share-access.ts`, `infra/lib/game-stack.ts` (rôles, fonctions de partage), `infra/lib/pipeline-stack.ts` (`deleteRole`, `coursRole`), `shared/delete-tree.ts`, `shared/delete-tree.test.ts`, `infra/test/s1-access.test.ts` |
| **S1-A** API | règles pures, jeton, création, liste, révocation, ouverture, signalement, interrupteur, champ `sharing` dans `students-update`, exports (liste des liens) | `shared/share-rules.ts` (+ test), nouveau `api/src/shares/*` (dont `access.test.ts`), `api/src/handlers/shares-*.ts`, `api/src/family/students.ts` (champ `sharing`, **conflit possible avec ID1 : fusionné, aucun conflit à ce jour**), `api/src/handlers/students-update.ts`, `api/src/handlers/family-read.ts` ou le constructeur d'export (liste exacte par `grep` au démarrage du lot) |
| **S1-W** site | réglage du parent, écran de choix des questions et aperçu, liste des liens (élève et parent), page publique `/p` | `web/src/screens/Parent.tsx` (réglage et liste), `web/src/screens/Doc.tsx` (bouton « Partager »), nouveaux `web/src/screens/Share*.tsx` et CSS, `web/src/screens/PublicQuiz.tsx` et son CSS, routage (`web/src/App.tsx` : une route `/p` sans connexion) |
| **S1-G** légal | registre, politique, AIPD, dans un commit `docs(legal)` séparé ; **sans relever** `POLICY_VERSION` | `docs/legal/*` |
| **S1-T** e2e | parcours de la section 14 | `e2e/*` (fichiers nouveaux) |

Fichiers qu'un autre lot **pourrait** vouloir : `shared/contract/openapi.yaml` et `shared/ddb/keys.ts` (tout futur lot de contrat : ordre de fusion), `shared/delete-tree.ts` (tout futur type d'élément), `web/src/screens/Doc.tsx` et `Parent.tsx` (écrans les plus partagés). Le lot S1-W ne touche à `Doc.tsx` et `Parent.tsx` que pour ajouter un bouton et une carte, dans une PR courte, rebasée en dernier.

Seeds de lot : écrire « le propriétaire » et jamais son prénom (la garde `scripts/guards.test.ts` échoue sinon) ; aucun ID de compte, ARN complet, clé ou secret dans le dépôt (`<ID_COMPTE>` dans les documents) ; commits `Worxfr <worx@pouf.org>` ; `git push` avec le nom de branche littéral, une commande par push ; aucun appel réel à un modèle ; **estimation de coût à faire valider avant tout déploiement de ressources nouvelles**.

## 16. Points à trancher par le propriétaire

Notés **S1-P1 à S1-P17**. Chaque point a une réponse par défaut, utilisée tant que rien d'autre n'est décidé.

| # | Question (en mots simples) | Défaut proposé |
|---|---|---|
| S1-P1 | Qui peut créer un lien ? | **L'élève seulement**, et seulement si le parent a **activé** le partage pour cet élève. Le parent ne crée pas de lien (il ne voit pas les questions). |
| S1-P2 | Le partage est-il ouvert ou fermé au départ ? | **Fermé pour tous**, y compris les plus de 15 ans. Le parent l'ouvre élève par élève. |
| S1-P3 | Le lien est-il public ou réservé à un autre compte QCMonster ? | **Public, sans compte.** Pas de partage entre comptes (cela mettrait en relation des enfants de familles différentes). |
| S1-P4 | Le destinataire peut-il jouer et gagner des points ? | **Il peut jouer, sans aucun point**, et rien n'est enregistré. Pas de bouton « ajouter à mes questions ». |
| S1-P5 | Quelles questions l'élève peut-il partager ? | Seulement celles **qu'il a déjà réussies** (ou toutes si la fiche a déjà ses 50 points). Sinon il lirait les réponses avant de jouer. |
| S1-P6 | Combien de questions par partage ? | **5 à 20**, d'une seule fiche. |
| S1-P7 | Combien de temps vit un lien ? | **7 jours** par défaut ; au choix 1 ou 30 jours ; jamais sans fin. |
| S1-P8 | Combien de liens à la fois ? | **5 par élève**, 10 par famille, 10 créations par jour et par élève. |
| S1-P9 | Peut-on revoir un lien déjà créé ? | **Non** (seul le hachage est gardé). Pour repartager : nouveau lien. |
| S1-P10 | Que voit le parent ? | Titre, nombre de questions, dates, nombre de lectures, signalements, état. **Pas les questions** (comme pour l'historique). Il peut tout révoquer. |
| S1-P11 | Faut-il prévenir le propriétaire d'un signalement ? | **Non en v1** : suspension automatique à 3 signalements et information du parent. Option : un e-mail « n signalements », sans contenu. |
| S1-P12 | Que fait un signalement ? | **3 signalements** (motifs d'une liste fermée) suspendent le lien. Pas de modération humaine. |
| S1-P13 | Si l'élève corrige la fiche après avoir partagé ? | Le lien reste, **figé**, avec l'indication « la fiche a été corrigée depuis ». Pas de révocation automatique. |
| S1-P14 | Partager plusieurs fiches ou un dossier ? | **Non** en v1 : une fiche par partage. |
| S1-P15 | La liste des liens est-elle dans l'export de données de l'élève ? | **Oui** (titre, dates, état, sans le lien ni les questions). |
| S1-P16 | Protection renforcée contre les abus (WAF, limite par adresse) ? | **Non en v1** (environ 6 € par mois plus une refonte de l'accès à l'API). Limite par route et plafond de lectures par lien. À reprendre si l'usage sort du cercle familial. |
| S1-P17 | Les textes de confidentialité changent-ils tout de suite ? | Le commit existe, **à valider par le propriétaire** ; la version de la politique **n'est pas relevée** (hausse commune plus tard). |

## 17. Ce qui n'a pas été mesuré ni vérifié

- **Aucun coût, aucune durée, aucune taille n'est mesuré.** Les 12 Ko par copie, les prix unitaires et le pire cas de 10 € par mois sont des estimations. Les prix AWS ne sont pas relus ici.
- **Aucun `cdk synth`**, aucun test lancé : les droits de la section 11 sont écrits à partir de `game-stack.ts` et `pipeline-stack.ts` de `main` lus partiellement. Les rôles `manage`, `deleteRole`, `coursRole` et `admin` doivent être relus ligne à ligne par S1-D (en particulier l'ensemble `FAM` du rôle `manage` et si `admin` a déjà `BatchWriteItem` sur une partition en `SHARE#*`, qui est nouvelle).
- **Contrat non écrit en YAML**, donc non validé par Prism (`npm run mock:check` non lancé).
- **Limites de l'API HTTP** : l'absence de WAF possible est lue dans `docs/api-security.md` et `api-stack.ts`, pas vérifiée sur l'environnement. Le comportement réel de la limitation par route sous charge n'a pas été mesuré.
- **`Question` et figures** : l'absence de lien entre une question et une figure vient du schéma du contrat ; à confirmer dans le code de génération (S1-A).
- **Lecteur d'export** : le constructeur à modifier pour S1-P15 est à trouver par `grep` (non fait).
- **Filtre des données personnelles** : aucune mesure de son efficacité (pas de jeu de questions réelles) ; il ne détecte pas un nom propre. Même limite pour le titre.
- **Textes légaux** : brouillons, non relus par un juriste ; le point sur les droits d'auteur d'un cours d'enseignant n'est pas tranché.
- **Réception du lien par d'autres appareils** : comportement de l'aperçu de lien des messageries (certaines chargent la page à l'envoi et pourraient compter une lecture) non étudié.
- **Rien n'a été testé dans un navigateur** : ce document ne produit aucun écran.
