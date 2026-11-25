# Backend famille et jeu (lot L3)

Code: `api/src/game/**` (regles du jeu), `api/src/family/**` (comptes), `api/src/handlers/*.ts` (13 Lambda), `api/src/lib/**` (acces donnees, HTTP, Cognito), `infra/lib/game-stack.ts`.
Source des regles: `docs/game-rules.md` (propriete de L1c). Modele de donnees: `docs/data-model.md`. Ce fichier decrit ce que L3 ajoute et les choix faits.

## Routes (`owner: 'game'` dans `api-stack.ts`)

| Handler (`qcm-<env>-<handler>`) | Routes | Qui | Role IAM (`qcm-<env>-game-<role>-role`) |
|---|---|---|---|
| `me-get` | `GET /me`, `GET /me/progress` | parent ou eleve | `read` |
| `family-read` | `GET /family/dashboard` (parent), `GET /family/leaderboard` (parent ou eleve) | | `read` |
| `session-get` | `GET /docs/{docId}/session` | eleve | `play` |
| `answers-post` | `POST /answers` | eleve | `play` |
| `docs-mark-read` | `POST /docs/{docId}/read` | eleve | `play` |
| `reports-validate` | `POST /reports/{id}/validate` | parent | `play` |
| `students-create`, `family-create` | `POST /students`, `POST /family` | parent | `account` |
| `students-link`, `students-update` | `POST /students/{sid}/activation-link`, `PATCH /students/{sid}` | parent | `manage` |
| `students-delete`, `family-admin` | `DELETE /students/{sid}`, `GET /family/export`, `DELETE /family` | parent | `admin` |
| `activation-post` | `POST /activation` (**publique**) | personne (jeton du lien) | `activation` |

Identite: toujours le **jeton** (`custom:famille_id`, `cognito:groups`, `cognito:username`). Un parent qui demande l'eleve ou le signalement d'une autre famille obtient 404 (la cle est `FAMILY#<famille du jeton>/...`). Un eleve est reconnu par son nom d'utilisateur Cognito, qui est son `studentId` (choisi par le serveur), et par le `sub` enregistre sur `STUDENT#`. Un eleve suspendu ou supprime recoit 403 meme avec un jeton encore valide.

## Creation de la famille: le jeton doit etre rafraichi

`POST /family` (premiere connexion d'un parent invite; **idempotent**: refaire l'appel complete ce qui manque, par exemple le groupe si l'ajout avait echoue) cree `FAMILY#<fid>/META`, pose `custom:famille_id` et ajoute l'utilisateur au groupe `parent` (`AdminUpdateUserAttributes`, `AdminAddUserToGroup`). `fid` est derive du `sub` du parent: deux appels simultanes visent le meme element, un seul gagne.

**Le jeton deja emis ne contient ni groupe ni `famille_id`.** Le front doit, apres la reponse 201:
1. demander un nouveau jeton avec le refresh token (`InitiateAuth` `REFRESH_TOKEN_AUTH`; le jeton d'identite renvoye contient les nouvelles valeurs), ou a defaut se reconnecter;
2. seulement ensuite appeler les autres routes.

Tant que le jeton est ancien, `GET /me` repond **404** pour un parent (c'est le signal « appeler `POST /family` »). Les autres routes parent repondent 403.

## Comptes eleve et activation

- `POST /students`: `parentalAuthority: true` est impose par le contrat (Zod `z.literal(true)`, test). Cree l'utilisateur Cognito (nom = `studentId`, groupe `eleve`, `famille_id`, `preferred_username` = pseudo avec suffixe aleatoire de 4 caracteres, **aucun message envoye**), puis l'eleve et le jeton d'activation dans **une transaction**; si l'ecriture echoue, l'utilisateur Cognito est supprime. Au plus 10 eleves par famille.
- **E-mail factice**: le pool exige un e-mail (attribut requis, non modifiable apres creation du pool). L'eleve recoit `<studentId>@eleve.invalid`, jamais verifie ni utilise. A verifier au premier deploiement (voir plus bas).
- Jeton: 256 bits (`randomBytes(32)`, base64url), seul le hache SHA-256 est stocke (`ACTIVATION#<hache>`, `expiresAt` + TTL 24 h). Le lien est `<origine du front>/activer#token=<jeton>` (le jeton est dans le fragment, il n'est jamais envoye au serveur du front).
- `POST /activation` (sans JWT): jeton inconnu, expire (verifie sur `expiresAt`, le TTL DynamoDB peut tarder), deja utilise ou remplace: **le meme 404**. Comparaison du hache en temps constant (`timingSafeEqual`). Le jeton est reserve par une ecriture conditionnelle a la version avant de poser le mot de passe (`AdminSetUserPassword`, permanent); la politique du pool refusee = 400 et le jeton est libere. Le corps n'est jamais journalise (`shared/log` n'accepte que des champs techniques).
- `POST /students/{sid}/activation-link`: nouveau lien, l'ancien est supprime.
- `PATCH`: la suspension passe d'abord par la base (refus immediat par l'API), puis `AdminDisableUser` et `AdminUserGlobalSignOut` (revoque les refresh tokens). Le quota (`quotaPages`, au plus le plafond de la famille) est ecrit sur `STUDENT#` et applique au quota du mois par `setLimit`.
- Suppression: Cognito, photos de jobs en cours (`scans/<jobId>/`), lien d'activation, puis `deleteStudentTree` / `deleteFamilyTree` de `shared/delete-tree.ts` (appelees, pas reecrites). `DELETE /family` supprime aussi l'utilisateur Cognito du parent, en dernier (un echec en cours de route se relance).

## Elements DynamoDB ecrits par L3 (attributs)

| Element | Attributs |
|---|---|
| `FAMILY#<fid>/META` | `createdAt`, `ownerSub`, `plafondPages` (defaut `quotaDefaults(env).familyPages`), `bonusMonth`, `bonusPages` (bonus de serie du mois, plafond 6) |
| `FAMILY#<fid>/STUDENT#<sid>` | `pseudo`, `niveau`, `moins15`, `statut`, `cognitoSub`, `quotaPages`, `activationHash`, `createdAt` |
| `STUDENT#<sid>/PROFILE` | `xp`, `correct`, `perfectSeries`, `validReports`, `readFirst`, `streak`, `lastValidDay`, `freezes`, `freezeMonth`, `badges[]`, `xpBySubject{}`, `subjects{month,list}`, `tick`, `series{n,perfect,risky,startedAt}`, `recent[]`, `quarantineDay`, `quarantineXp` |
| `STUDENT#<sid>/DAY#<jour>` | `xp`, `pagesPaid`, `valid`, `reads{docId: scan/review/none}` |
| `STUDENT#<sid>/ATT#<questionId>#<jour>` | `attempts`, `done`, `rewarded` |
| `FAMILY#<fid>/WEEK#<aaaa-Www>#<sid>` | `xp`, `days[]` (jours valides) |
| `ACTIVATION#<hache>/META` | `hash`, `sid`, `fid`, `expiresAt`, `creeLe`, `ttl`, `usedAt` (pendant la reservation) |

Chaque element porte un compteur `v`. Une reponse ecrit `PROFILE`, `DAY`, `WEEK` et `ATT` en **une transaction conditionnelle aux versions lues**: deux requetes simultanees ne peuvent ni depasser le plafond ni payer deux fois (la perdante relit; 3 essais, puis 409). Lus: `Fiche` (matiere, `pagesConsommees`, `doublon`, `createdAt`), `QCM`, `GAP`, `VERDICT`, `Signalement`, quotas.

## Choix sur les regles (a relire)

- **Une recompense par question, pour toujours** (decision du conducteur, conforme a `game-rules.md`). La cle `ATT#<questionId>#<jour>` garde la date; avant de payer, L3 lit les `ATT#<questionId>#` des autres jours (prefixe) et ne paie que si aucun n'a `rewarded`. Une question jamais reussie hier peut donc etre payee aujourd'hui, une seule fois. Rejouer une question deja payee ne donne ni XP, ni badge (`correct` ne compte que les premieres reussites), ni progression de serie de 10.
- QCM: 5 XP au premier essai, 2 au second, ensuite rien; la bonne reponse n'est revelee (`correctAnswer`) qu'une fois la question terminee (juste, ou 2 essais). Texte a trous: un seul essai par jour, reponse revelee si faux.
- **Moment d'affichage** (`shownAt`): le client n'envoie pas d'heure. Le serveur prend `PROFILE.tick` = ouverture de la session (`GET .../session`) ou derniere reponse acceptee. Reponse a moins de 1 s: **refus 429 `etat_invalide`, sans rien reveler** (ni justesse, ni reponse), aucun essai compte, le temps de reference n'est pas remis a zero. Serie de 10: mesuree depuis le `startedAt` pose par l'ouverture de la session **du jour**; une reponse sans session ouverte aujourd'hui ne compte pas pour la serie (elle garde son XP); seule la premiere tentative du jour d'une question jamais payee compte; fin en moins de 20 s: ni +20 ni +30.
- Serie parfaite (+30): 10 sur 10 du premier coup **et** chaque question liee a une affirmation `verifiee` ou `non_factuelle`. Une affirmation `erreur`, `non_verifiable` ou **sans verdict** bloque le bonus.
- Plus de 100 bonnes reponses en 10 minutes: `quarantineDay` = aujourd'hui, plus aucun XP credite ce jour-la (`quarantineXp` compte ce qui a ete retenu). Elle se leve le lendemain. Le parent est « notifie » par ce marqueur, mais le contrat n'a **aucun champ** pour l'afficher (voir limites).
- Lecture de la fiche (`POST /docs/{docId}/read`, option b du plan C4): fiche creee **aujourd'hui** = 10 XP par page consommee, 2 pages payees par jour, rien pour un doublon; fiche d'un autre jour = 8 XP (revue). Une seule recompense par fiche et par jour. Une fiche creee a 23 h 50 et lue a 00 h 10 compte comme une revue.
- Jour valide a 30 XP; un trou de `n` jours consomme `n` gels, sinon la serie repart de 1; gels remis a 2 au premier passage de chaque mois. +2 pages a chaque multiple de 7 jours de serie, au plus +6 par famille et par mois (compteur dans `FAMILY#/META`, puis `addBonus`). Si `addBonus` echoue apres le compteur, le bonus est perdu (pas de rejeu).
- « Jours actifs » du classement = jours **valides** (>= 30 XP). Classement: au moins 3 jours actifs, tri par XP puis pseudo.
- Badges: catalogue `api/src/game/badges.ts`, test de coherence avec `docs/game-rules.md` section 4.

## Limites connues, non faites

- **Jours de repos du parent** (3 par semaine, game-rules 3): aucune route du contrat ne permet de les designer. Non implemente.
- **Classement « progression relative »** (base `max(moyenne 4 semaines, 150)`): le contrat `Leaderboard` n'a pas de champ pour le pourcentage. Non expose; les donnees (`WEEK#`) le permettent.
- **Notification de quarantaine au parent**: pas de champ dans `Dashboard`. Le marqueur est dans `PROFILE`.
- `Student.pageQuota` a `maximum: 50` dans le contrat, mais le quota par defaut d'un eleve en **dev** est 200 (`quotaDefaults`, x10). La reponse porte 200 en dev.
- Pas de TTL sur `ATT#`, `DAY#`, `WEEK#` (quelques elements par eleve et par jour; supprimes avec l'eleve).
- L2a n'ecrit pas `studentId` sur le signalement: `reports-validate` retrouve l'eleve par la fiche (parmi les eleves de la famille). Ajouter `studentId` au signalement le rendrait direct (il est deja lu s'il existe).
- Les routes `GET /me/progress` et `session` sont refusees (403) a un parent.
- **XP de revue non verifie** (limite connue): `POST /docs/{docId}/read` rapporte 8 XP par fiche et par jour sans preuve de lecture (le serveur ne mesure pas « jusqu'au bout »). Avec 4 fiches, 4 appels donnent 32 XP: un jour valide, donc une serie et, tous les 7 jours, +2 pages (plafond 6 par famille et par mois). Le plafond de 250 XP par jour borne le gain, pas la serie. Piste: exiger une reponse enregistree sur la fiche le meme jour.
- **Droits IAM**: `dynamodb:LeadingKeys` limite chaque role a ses partitions (voir `game-stack.ts`), mais IAM ne filtre pas la cle de tri: `play` pourrait ecrire n'importe quel element `STUDENT#`/`FAMILY#`; « un type, un ecrivain » repose sur le code et ses tests.
- **Risque accepte, Cognito**: IAM ne filtre pas par groupe. `AdminSetUserPassword` (role `activation`, route publique) vaut pour tout le pool, parents compris, si le code etait contourne. Mitigation: jeton de 256 bits a usage unique, nom d'utilisateur lu en base (jamais dans la requete). Idem `AdminDeleteUser`, `AdminDisableUser` des autres roles.
- Limite de 10 eleves par famille non atomique (comptage puis creation); la route est limitee a 1 requete/s.
- La suppression d'une grande famille peut depasser les 29 s de l'API Gateway (503 avant la fin); tout est idempotent, relancer termine.

## A verifier au premier deploiement en dev (non verifiable en local)

1. `AdminCreateUser` accepte un utilisateur avec e-mail factice et `MessageAction: SUPPRESS` (declencheur PreSignUp `PreSignUp_AdminCreateUser` deja accepte).
2. La connexion d'un eleve par son alias `preferred_username` (le client web n'a que `USER_SRP_AUTH`) apres `AdminSetUserPassword`.
3. Le jeton d'identite d'un eleve contient `cognito:username` = `studentId` et `cognito:groups`; celui d'un parent, apres rafraichissement, contient `custom:famille_id`.
4. L'API accepte l'integration vers une fonction qui n'existe pas encore: deployer **Auth, Data, puis Api, puis Game**; la stack Game depend des trois autres.
5. `POST /activation` sans jeton repond 404/400 (pas 401), avec un jeton inconnu le meme 404 qu'un jeton expire.
6. Le plafond de limitation globale de la route d'activation (1 req/s) suffit en usage familial (risque accepte, `docs/api-security.md`).
