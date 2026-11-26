# ID1: identifiant de connexion visible pour l'eleve et pseudo choisi par l'eleve (issue #33)

Statut: **valide par le proprietaire** (les 12 points de la section 9 sont tranches avec leur valeur par defaut). Conception, aucun code. La PR #82 (R1, contrat 1.5.0) et la PR #84 (F10) sont fusionnees dans `main`. Ce document ne modifie pas `shared/contract/openapi.yaml`: le contrat additif propose est en section 6. F10 et Q1 (#88) visent deja 1.6.0: ID1 prend le **numero libre suivant apres eux** (section 10).
Vocabulaire du document: **identifiant de connexion** = ce que l'eleve tape pour entrer (ex. `lila-7k2f`). **Pseudo affiche** = le nom vu dans l'application (accueil, classement de la famille, espace parent).

## 1. Etat actuel (code lu sur `main`, tete c526a96)

- **Creation.** Le parent saisit un pseudo (`Parent.tsx`, `Invite`). Regle front et contrat: `^[A-Za-z][A-Za-z0-9 -]{1,19}$`, donc 2 a 20 caracteres ASCII, sans accent. `createStudent` (`api/src/family/students.ts`) remplace les espaces par des tirets, ajoute `-` et 4 caracteres `[a-z0-9]` au hasard (`deps.suffix`), et tente jusqu'a 3 fois si Cognito refuse un doublon (`AliasTakenError`).
- **Un seul champ pour deux usages.** Le resultat (`Lila-7k2f`) est stocke dans `STUDENT#<sid>.pseudo` ET pose dans l'attribut Cognito `preferred_username` (`api/src/lib/identity.ts`). Le nom d'utilisateur Cognito est un identifiant aleatoire interne (le `studentId`). L'alias `preferred_username` est donc l'identifiant de connexion (`signInAliases` dans `infra/lib/auth-stack.ts`). Le pseudo affiche et l'identifiant de connexion sont la meme chaine.
- **Affichage.** Le parent voit la chaine dans la carte « Lien d'activation de Lila-7k2f », dans sa liste d'eleves et dans le classement. L'eleve la voit en haut de l'accueil (« Salut Lila-7k2f ! ») une fois connecte, et les freres et soeurs la voient dans le classement de la famille.
- **Activation.** `POST /activation` renvoie `204` sans corps. L'ecran `Activate.tsx` dit « Connecte-toi avec ton pseudo » sans jamais l'ecrire. Le jeton est a usage unique: apres activation, l'eleve n'a aucun endroit de l'application ou lire son identifiant tant qu'il n'est pas connecte. S'il l'a oublie, il doit le demander au parent.
- **Connexion.** `Login.tsx` accepte « Pseudo ou e-mail » (les parents utilisent l'e-mail). `preventUserExistenceErrors` est actif sur les deux clients Cognito: un identifiant inconnu et un mauvais mot de passe donnent la meme erreur.
- **Pas de changement possible.** `updateStudent` ne change pas le pseudo. La politique de confidentialite (section sur la correction) dit qu'il faut supprimer l'eleve et le recreer.
- **Majuscules.** Le pool n'est pas declare insensible a la casse (`signInCaseSensitive` absent, valeur par defaut du CDK: sensible). `Lila-7k2f` et `lila-7k2f` sont donc probablement deux identifiants differents. **A verifier sur le pool dev** avant le lot 1 (point 7 de la section 9). Ce reglage ne se change pas apres la creation du pool.
- **Ce qui ne depend PAS du pseudo** (bonne nouvelle pour un changement): le classement est indexe par `studentId` (`api/src/game/family-read.ts`), les jetons de session portent le `sub` et le nom Cognito interne, jamais le pseudo, et le pseudo n'est ni journalise ni envoye a Wikimedia (politique, `sous-traitants.md`).

## 2. Problemes a resoudre

1. L'eleve ne voit jamais son identifiant de connexion avant d'avoir a s'en servir.
2. Le pseudo est fixe par le parent et ressemble a un code (`Lila-7k2f`). L'eleve ne peut pas choisir un nom qui lui plait.
3. Pour les comptes deja crees, le classement de la famille montre l'identifiant de connexion complet aux autres eleves. Un frere ou une soeur connait alors la moitie des informations pour se connecter (il manque le mot de passe). A corriger par la separation des deux champs.
4. Aucun filtre sur les pseudos (mots grossiers, donnees personnelles).

## 3. Propositions

### Option A: afficher seulement (minimum)
Montrer l'identifiant a l'eleve a la fin de l'activation et dans un profil. Rien d'autre ne change. Regle le probleme 1 seulement.

### Option B: separer identifiant et pseudo (recommandee)
- L'**identifiant de connexion** reste genere par le serveur et ne change pas, sauf demande du parent. Il garde le suffixe au hasard.
- Le **pseudo affiche** devient un champ a part, choisi par l'eleve a l'activation (propose par defaut: la partie avant le suffixe du nom donne par le parent), modifiable ensuite par le parent.
- L'identifiant est montre a l'eleve (fin d'activation, profil) et au parent.

Regle les problemes 1 a 4.

### Option C: le pseudo choisi sert aussi d'identifiant
Rejetee. Pour garantir l'unicite dans tout le pool, il faudrait dire a l'eleve « ce pseudo est deja pris » (c'est un test d'existence de compte, donc une enumeration possible de pseudos) ou reintroduire un suffixe, ce qui redonne l'option B. Un identifiant choisi par un enfant est aussi plus facile a deviner par un camarade (« prenom + annee »).

## 4. Securite et vie privee

### 4.1 Enumeration d'identifiants
- Option B n'ajoute aucun test « ce pseudo est-il libre ? » sur le pool entier: le pseudo affiche n'est unique que **dans la famille** (contrôle fait sur les eleves de `FAMILY#<fid>`, dix au plus). L'identifiant de connexion reste produit par le serveur.
- Le message d'erreur de connexion reste identique pour identifiant inconnu et mauvais mot de passe (`preventUserExistenceErrors`, inchange). La protection contre la devinette repose sur le verrouillage temporaire de Cognito apres des essais rates (comportement **non mesure** ici) et sur le mot de passe de 12 caracteres.
- Aucune nouvelle route publique ne repond selon l'existence d'un identifiant. `POST /activation` reste publique mais exige un jeton valide et garde sa reponse `404` unique pour tout jeton inutilisable.
- Nouveau format des identifiants (comptes crees apres le lot 1): base en **minuscules** sans accent, suffixe de **5 caracteres** pris dans un alphabet sans caracteres ambigus (sans `0 o 1 l i`), soit 31 caracteres et environ 28 millions de combinaisons par base (contre 1,7 million avec 4 caracteres). Le tirage se fait **par rejet** (on ecarte les octets au-dela du plus grand multiple de 31) pour eviter le biais du `b % 36` actuel. Moins de collisions, moins d'erreurs de frappe, et pas de difference majuscule/minuscule a retenir. Les identifiants existants continuent de fonctionner tels quels.

### 4.2 Unicite
- Identifiant de connexion: Cognito refuse deja un alias deja pris (`AliasExistsException`); la boucle de 3 essais existe. Elle est conservee, en passant a 5 caracteres.
- Pseudo affiche: refuse s'il est deja porte par un autre eleve de la famille (comparaison sans accent ni casse). **Le champ `v` de l'element eleve ne suffit pas**: chaque eleve est un element distinct, la condition de version de l'un ne voit pas l'ecriture de l'autre (et `v` n'existe que si l'element a deja ete reecrit, sinon `when: 'any'` n'est pas une condition). L'unicite repose donc sur une **reservation de nom par famille**:
  - element `PK = FAMILY#<fid>`, `SK = NAME#<nom normalise>` (nom NFC, sans accent, minuscules, espaces et tirets unifies), attributs `sid` et `creeLe`;
  - ecrit avec `when: 'absent'` **dans le meme `store.commit`** que la mise a jour de l'eleve (le port accepte plusieurs ecritures, comme `createStudent`); si la reservation existe deja, le commit echoue et rien n'est ecrit;
  - **liberee** au renommage (le meme commit supprime l'ancienne reservation et pose la nouvelle), a la suppression de l'eleve (`purgeStudent`) et a la suppression de la famille (`shared/delete-tree.ts`, **et son test de comptage**);
  - declaree dans `docs/data-model.md` (ligne « Reservation de nom ») et `shared/ddb/keys.ts` (`keys.name(fid, normalise)`);
  - **anciens comptes**: ils n'ont pas de reservation. Le controle compare aussi le **nom derive** (section 5.3) des eleves de la famille, sinon `Lila-7k2f` et `Lila-9x1z` auraient tous deux « Lila ». Au premier renommage ou a la premiere activation d'un ancien compte, sa reservation est posee.

### 4.3 Pseudos inappropries
Controle **cote serveur** (le front applique la meme fonction pour guider, il ne decide pas). Une fonction pure partagee `shared/pseudo-rules.ts` (front et API l'importent, comme `shared/policy.ts`):
- Forme: 2 a 20 caracteres (comptes en caracteres Unicode apres NFC, pas en unites UTF-16), **lettres latines seulement** (accents autorises, ex. `Lea`, `Leo`; cyrillique, grec et autres alphabets refuses, pour ne pas contourner la liste avec des lettres qui ressemblent aux latines), chiffres, espace, tiret, apostrophe. Premier caractere = une lettre. Refuses: caracteres de controle, emoji, **toute categorie Unicode `Cf`** (joints et espaces de largeur nulle, marques de direction) et marques combinantes en exces apres NFC. Normalisation NFC avant tout test.
- **Les memes regles s'appliquent au surnom de depart du parent** (`StudentCreateRequest.pseudo`, qui devient la base de l'identifiant et le pseudo par defaut): le serveur le passe par `shared/pseudo-rules.ts` a la creation (liste de mots, chiffres, mots de role, `@`) en plus de la regle ASCII du contrat. Refus: meme code d'erreur.
- **Code d'erreur**: un surnom refuse renvoie `400` avec `code: pseudo_refuse` (a declarer dans le contrat). Le site distingue ainsi ce cas du mot de passe refuse, qui est aussi un `400` (`Activate.tsx` traite aujourd'hui tout `400` comme « mot de passe refuse »).
- Liste de mots refuses: comparaison apres mise en minuscules, retrait des accents, retrait des separateurs et remplacement des chiffres usuels (`0 o`, `1 i`, `3 e`, `4 a`, `5 s`, `7 t`). Contient des insultes, mots sexuels, termes haineux, noms de drogues, le nom du produit et des mots de role (`admin`, `parent`, `moderateur`). Fichier `shared/pseudo-blocklist.ts`, tenu a jour par le proprietaire.
- Le refus renvoie toujours le meme message neutre (« Ce pseudo n'est pas possible, essaie-en un autre »), sans nommer le mot, pour ne pas servir de test de gros mots.
- Faux positifs (un prenom qui contient un fragment de la liste): le message ne les distingue pas; l'eleve en essaie un autre. Limite assumee, a revoir si des plaintes arrivent.

### 4.4 Mineurs: aucune donnee personnelle dans le pseudo
Le pseudo est affiche aux freres et soeurs et au parent, jamais hors de la famille, jamais journalise, jamais envoye a un tiers. Regles en plus de la forme:
- Refuse: `@`, `http`, `www`, `.com`/`.fr`, plus de **2 chiffres** au total (annee de naissance, numero de telephone, numero de classe precis).
- Refuse: une chaine qui ressemble a une adresse e-mail ou a l'e-mail du parent (partie avant `@`), si le serveur la connait au moment de l'appel.
- Impossible a detecter par code: un vrai nom de famille ou le nom de l'ecole. La seule protection est le texte d'aide, le fait que le parent voit le pseudo et peut le changer, et le fait que le pseudo ne quitte jamais la famille.
- Texte d'aide a l'eleve: « Invente un surnom. Pas ton nom de famille, ni ton ecole, ni ta date de naissance. »

## 5. Changement d'identifiant et impacts

### 5.1 Changer le pseudo affiche
Ecriture d'un seul champ dans `STUDENT#<sid>` (condition de version). Aucun impact sur Cognito, sur les sessions ouvertes, sur le classement (cle `studentId`), ni sur l'historique des tests (rattache a `studentId`). L'ecran affiche le nouveau nom au prochain chargement. Pas de limite de frequence cote parent. Pas de changement cote eleve apres l'activation (voir point a trancher 3).

### 5.2 Regenerer l'identifiant de connexion (parent seulement)
Usage: l'identifiant a ete vu par quelqu'un qui ne devrait pas, ou il est inapproprie. Le serveur:
0. lit l'alias courant (`AdminGetUser`). Si Cognito porte deja un alias X different de celui de la base, c'est le reste d'un appel interrompu: **on ecrit X en base** au lieu d'en generer un troisieme;
1. sinon genere un nouvel identifiant (meme regles que 4.1) et pose le nouvel alias avec `AdminUpdateUserAttributes` (`preferred_username`). Si Cognito refuse (`AliasExistsException`), nouvel essai;
2. ecrit `loginId` dans `STUDENT#<sid>` (condition de version);
3. appelle `AdminUserGlobalSignOut` pour revoquer les jetons de rafraichissement, de sorte que l'ancien appareil doive se reconnecter avec le nouvel identifiant. **La deconnexion globale est faite a chaque appel**, meme quand l'alias et la base sont deja coherents: si elle echouait apres l'ecriture en base, un rejeu qui voit « coherent » ne la referait jamais.

Ordre: Cognito d'abord, base ensuite, comme pour l'activation du compte; si la base echoue apres Cognito, rejouer la meme requete repare (idempotent: la requete lit l'alias courant et ne regenere que si la base ne le contient pas). Impacts:
- Le nom d'utilisateur Cognito interne (`studentId`) et le `sub` ne changent pas: aucune donnee n'est rattachee a l'alias. Le jeton d'acces d'une session deja ouverte reste valide **jusqu'a 1 heure** (`accessTokenValidity` du client Web) et l'API ne consulte pas Cognito a chaque appel: la coupure n'est pas immediate. Acceptable, l'identifiant n'est pas un secret. La deconnexion globale revoque seulement les jetons de rafraichissement.
- L'ancien identifiant est libere et peut etre reattribue par hasard a un autre eleve. Probabilite negligeable avec 5 caracteres sur alphabet de 31; acceptee.
- Le mot de passe ne change pas. Le parent peut aussi demander un nouveau lien d'activation (`POST /students/{sid}/activation-link`, existant).
- Il n'y a pas de fonction « l'eleve change son propre identifiant ».
- **Limite de debit**: la route `POST /students/{sid}/login-id` a un plafond de **1 requete par seconde, rafale de 3**, comme `activation-link` et `POST /students`.
- **Droits IAM**: le handler a **son propre role**, avec seulement `cognito-idp:AdminGetUser`, `AdminUpdateUserAttributes` et `AdminUserGlobalSignOut` sur le pool, et `dynamodb:GetItem`/`PutItem`/`UpdateItem` limites par `LeadingKeys` a la partition de la famille. Il ne reutilise ni le role `account` ni le role `manage` (aujourd'hui l'un porte l'ecriture d'attributs, l'autre la deconnexion globale, dans `game-stack.ts`).

### 5.3 Comptes existants
Aucune migration obligatoire. Pour un eleve sans `loginId` en base, le serveur lit l'ancien champ `pseudo` (c'est le meme texte que l'alias Cognito). Le pseudo affiche d'un ancien compte est ce meme texte **sans le suffixe** (`^(.+)-[a-z0-9]{4}$` -> groupe 1) tant que le parent ne l'a pas change; ainsi le classement cesse de montrer l'identifiant de connexion. Le champ `pseudo` brut d'un ancien compte n'est **jamais reecrit** par une regeneration d'identifiant (il garde l'ancien alias, sans effet). Les **nouveaux** comptes n'ont plus de champ `pseudo`: ID1-A migre toutes les lectures de `String(s.pseudo)` (`api/src/game/family-read.ts`, `api/src/game/access.ts`, le helper de test `testkit.ts`) vers une seule fonction `displayNameOf(item)` / `loginIdOf(item)`. Un script de migration optionnel (hors lot 1) peut ecrire les deux champs une fois pour toutes.

## 6. Contrat additif propose (a integrer apres la fusion de #82)

Rien n'est supprime. Deux points ne sont pas strictement additifs: la reponse de `POST /activation` (204 vers 200) et le **sens de `pseudo`**, qui est aujourd'hui l'identifiant de connexion complet (`Lila-7k2f`, voir la description du contrat) et deviendrait le pseudo affiche. **Regle de deploiement (D1)**: ID1-A, ID1-C et ID1-W sont mis en ligne **ensemble, dans un seul deploiement**. Tant que le site ID1-W n'est pas en ligne, l'API ne change pas le sens de `pseudo` (il reste egal a l'identifiant); si un deploiement par etapes etait impose, l'API garde `pseudo` = `loginId` jusqu'a la mise en ligne du site. Le nouveau site contre une ancienne API (reponse 204 sans corps) doit tenir: l'ecran de fin d'activation, sans `loginId`, affiche « Demande ton identifiant a ton parent ».

- `Student` (reponse parent): ajouter `loginId: string` (identifiant de connexion, ex. `lila-7k2f`) et `displayName: string` (pseudo affiche). `pseudo` est conserve et vaut `displayName` pour la compatibilite. Pour les anciens comptes, `loginId` = ancien `pseudo`.
- `Me` (reponse eleve): ajouter `loginId` (eleve seulement) et `displayName`. `pseudo` conserve (= `displayName`). Pour un parent, aucun des deux nouveaux champs.
- `StudentCreateRequest.pseudo`: le champ garde son nom et sa regle de forme (le parent donne la **base** de l'identifiant). Description precisee: il sert de base a l'identifiant et de pseudo affiche par defaut. La regle ASCII reste (l'identifiant est de l'ASCII).
- `ActivationRequest`: ajouter `displayName?: string` (optionnel; absent = on garde le pseudo par defaut). Contrat: `minLength: 2`, `maxLength: 20` (en caracteres Unicode), `pattern` des lettres latines (la liste de mots et les chiffres sont controles par le serveur). Les regles des sections 4.3 et 4.4 sont appliquees **avant de consommer le jeton**: `400` avec `code: pseudo_refuse`, le jeton reste utilisable. Un nom **deja pris dans la famille** est aussi detecte avant le jeton (lecture de la reservation, section 4.2): `409` avec `code: pseudo_pris` et le message « Ce surnom est deja pris dans ta famille, essaie-en un autre ».
- `POST /activation`: la reponse passe de `204` a `200` avec `{ loginId: string, displayName: string, displayNameChanged?: boolean }`. C'est le seul point non strictement additif: le client genere et les tests (`web/src/flows.test.tsx`, `e2e/mock-api/server.mjs`, `api/src/handlers/handlers.test.ts`) doivent suivre. Alternative si le proprietaire refuse: garder `204` et ajouter `GET /activation/preview` (jeton dans l'en-tete, meme `404` unique, renvoie `loginId` et `displayName`), a appeler avant la saisie du mot de passe. Recommandation: `200` (un seul appel, pas de nouvelle route publique).
- **Activation: ecriture finale controlee.** Aujourd'hui `activation.ts` ne lit pas le resultat de son dernier `commit` (il ne retire que `activationHash`). Avec `displayName`, une perte silencieuse ferait croire a l'eleve que son surnom est pris. Le design impose: on **controle le resultat** du commit (element eleve + reservation du nom, `when: 'absent'`); sur conflit de version (le parent change le niveau au meme instant), on **relit l'eleve et on reessaie** (3 essais); si la reservation du nom est devenue indisponible entre-temps, on prend le **nom par defaut** (la base du parent, ou ce nom suivi d'un chiffre libre si lui aussi est pris) et la reponse `200` le dit (`displayNameChanged: true`), l'ecran de fin affiche « Ton surnom etait deja pris, on t'a donne X. Ton parent pourra le changer ». Le mot de passe est deja pose, le compte est actif: on ne renvoie pas d'erreur apres ce point.
- `StudentUpdateRequest` (`PATCH /students/{sid}`): ajouter `displayName?: string` (le parent renomme; memes regles; `409` si le nom est deja pris dans la famille).
- Nouvelle route parent `POST /students/{sid}/login-id` (operationId `regenerateLoginId`), sans corps. Reponse `200 { loginId }`, plafond de debit 1/3 (5.2), jeton d'acces valable jusqu'a 1 h (5.2). Roles: parent de la famille du jeton seulement (meme garde que `activation-link`), `404` si l'eleve n'est pas de la famille.
- Les reponses d'erreur gardent le format existant. Le message pour un pseudo refuse est neutre (4.3) et porte `code: pseudo_refuse`.

## 7. Parcours et ecrans

### 7.1 Eleve: activation (`Activate.tsx`)
1. Champ « Ton surnom » (prérempli avec la base donnee par le parent, modifiable), texte d'aide de 4.4, verification en direct de la forme seulement (jamais de la liste de mots). Un `400` avec `code: pseudo_refuse` affiche le message neutre pres du champ surnom; un `400` sans ce code garde le message sur le mot de passe; un `409 pseudo_pris` affiche le message de la section 6.
2. Mot de passe et confirmation, comme aujourd'hui.
3. Ecran de fin: « Ton identifiant pour te connecter: **lila-7k2f** », gros, avec un bouton « Copier » et la phrase « Ecris-le quelque part, ou demande a ton parent: il peut le retrouver ». Puis le bouton « Aller a la connexion », qui pre-remplit le champ identifiant (via la memoire de la session, jamais l'URL).
4. L'identifiant n'est jamais dans l'URL ni dans le stockage local; il n'est montre qu'a l'ecran.

### 7.2 Eleve: connexion et profil
- `Login.tsx`: le champ passe de « Pseudo ou e-mail » a « Identifiant ou e-mail », avec un texte d'aide « Ton identifiant ressemble a lila-7k2f ». L'espace de debut et de fin est retire. Le champ porte `autoCapitalize="none"`, `autoCorrect="off"` et `spellCheck={false}` (sinon un clavier de telephone met la premiere lettre en majuscule et la connexion echoue avec le message generique). La saisie est passee en **minuscules cote client** quand elle a le format neuf (base en minuscules, tiret, suffixe de 5 caracteres de l'alphabet autorise). Un ancien identifiant avec majuscules (`Lila-7k2f`) est envoye tel quel, car le pool est probablement sensible a la casse (point 7 de la section 9).
- Accueil: « Salut {pseudo affiche} ! » (aujourd'hui l'identifiant complet). Un lien « Mon profil » ouvre une carte avec le pseudo affiche, l'identifiant de connexion et le bouton « Copier ». Pas de modification dans cette carte.

### 7.3 Parent (`Parent.tsx`)
- Liste: le pseudo affiche, et en dessous, en petit, « Identifiant: lila-7k2f ».
- Creation: le champ devient « Surnom de depart (l'eleve pourra en choisir un autre) » avec le texte d'aide de 4.4. La carte du lien d'activation montre aussi l'identifiant qui sera cree.
- Bouton « Changer le surnom » (champ + enregistrer) et bouton « Nouvel identifiant de connexion » avec confirmation: « Ton enfant devra se reconnecter avec le nouvel identifiant. Son mot de passe reste le meme. »
- Le classement de la famille montre les pseudos affiches uniquement.

## 8. Tests

Api, un fichier de tests par module existant (pas de nouveau banc):
- `shared/pseudo-rules.test.ts`: formes valides et invalides; accents; cyrillique `а` a la place du `a` latin; caracteres `Cf` (joint de largeur nulle); marques combinantes; mots refuses avec chiffres, tirets et majuscules (`L0l1ta`-style); `@`, `http`, plus de 2 chiffres; chaine vide; 21 caracteres; emoji; NFC contre NFD.
- `students.test`/`family.test.ts`: la creation donne un `loginId` en minuscules, 5 caracteres d'alphabet autorise; la boucle de collision (`failCreate`) fonctionne; `studentView` renvoie `loginId` et `displayName` pour un eleve neuf ET pour un ancien eleve (sans `loginId`: derive du `pseudo`; sans suffixe: affichage); le `PATCH displayName` refuse un doublon de famille (`409`) et accepte le meme nom pour un eleve d'une autre famille; un parent ne renomme pas l'eleve d'une autre famille.
- `activation.test` (dans `family.test.ts`): `displayName` refuse => `400` ET le jeton reste utilisable; `displayName` accepte => stocke, reponse `200` avec `loginId`; sans `displayName` => valeur par defaut; deux activations en course sur le meme nom de famille => une seule gagne (**reservation `NAME#`**, section 4.2), l'autre `409 pseudo_pris` avant le jeton; nom devenu indisponible apres le mot de passe => nom par defaut et `displayNameChanged`; conflit de version sur l'eleve => relecture et reessai; un `PATCH displayName` et une activation en course sur le meme nom => une seule gagne; le renommage libere l'ancienne reservation; la suppression de l'eleve et de la famille libere les reservations (test de comptage de `delete-tree`); deux anciens freres au meme nom derive sont refuses.
- `regenerateLoginId`: l'alias Cognito change (`memoryIdentity` etendu: `updateAlias`, avec `AliasTakenError` simulable), l'ancien alias est libre, `AdminUserGlobalSignOut` est appele, la base contient le nouvel identifiant; echec de la base apres Cognito puis rejeu => etat coherent; autre famille => `404`.
- `regenerateLoginId` en plus: la regeneration ne touche pas le champ `pseudo` brut; un rejeu refait la deconnexion globale; l'alias deja pose dans Cognito mais absent de la base est ecrit en base; plafond de debit 1/3 dans `infra/test`; le role dedie n'a que les trois actions Cognito.
- Test de contrat (`shared/contract`): `displayName` a `minLength`, `maxLength` et `pattern`; un exemple valide existe pour la reponse 200 de `POST /activation`; les nouveaux champs sont dans les schemas et les exemples sont valides; `Me` d'un parent n'a pas `loginId`.
- Anciens comptes: le classement ne contient jamais le suffixe (test de non-regression sur `family-read.ts`).

Web (vitest + e2e):
- `flows.test.tsx`: **nouveau site contre ancienne API** (204, pas de corps): l'ecran de fin n'affiche pas `undefined` et renvoie au parent; `Login` a `autoCapitalize="none"` et met en minuscules une saisie au format neuf; l'ecran de fin d'activation montre l'identifiant renvoye; surnom refuse => message neutre et le formulaire reste actif; pas d'identifiant dans l'URL ni dans `localStorage`.
- `e2e/tests/02-famille.spec.ts` (mock): parcours parent cree un eleve, ouvre le lien, choisit un surnom, voit l'identifiant, se connecte avec lui, voit « Salut {surnom} ». Etendre `e2e/mock-api/server.mjs` pour renvoyer `loginId`.
- Verification sur le site dev reel apres deploiement (parcours complet, compte de test), car la casse des identifiants depend du vrai pool et le faux serveur ne la reproduit pas.
- Axe (accessibilite): le champ surnom a un label, le message d'erreur est annonce (`role="alert"`), le bouton Copier a un nom accessible.

## 9. Decisions du proprietaire (points 1 a 12 valides avec la valeur par defaut indiquee)

Chaque point ci-dessous est une **decision**: la valeur « Defaut » est celle retenue. Les textes legaux (politique, registre, AIPD) sont dans un commit separe de cette PR. **La version de la politique (`POLICY_VERSION`) n'est pas augmentee par ID1**: une seule hausse commune avec R1, faite par le lot qui les regroupe (decision du proprietaire).

1. **Le surnom sert-il aussi pour se connecter ?** Defaut: **non**. L'enfant se connecte avec un identifiant fabrique par le site (ex. `lila-7k2f`). Son surnom, lui, sert seulement a l'affichage. Raison: on ne peut pas verifier si un surnom est libre sans reveler quels surnoms existent chez d'autres familles.
2. **Le parent valide-t-il le surnom avant qu'il serve ?** Defaut: **non**, pas d'etape de validation. Le parent voit le surnom dans sa liste et peut le changer a tout moment. Raison: une validation obligatoire bloque l'enfant qui n'a pas son parent a cote.
3. **L'enfant peut-il changer son surnom plus tard ?** Defaut: **non**, seul le parent le change apres l'activation. L'enfant choisit une fois, au debut.
4. **Peut-on mettre son prenom ?** Defaut: **oui, mais on conseille un surnom inventé**; le site refuse les chiffres en trop, les adresses, les mots grossiers. On ne peut pas empecher un nom de famille ecrit a la main: c'est le parent qui surveille.
5. **L'enfant revoit-il son identifiant plus tard ?** Defaut: **oui**, dans « Mon profil », et le parent le voit dans sa liste.
6. **Bouton « Nouvel identifiant » pour le parent ?** Defaut: **oui**. L'enfant se reconnecte avec le nouvel identifiant, son mot de passe ne change pas.
7. **Majuscules et minuscules dans l'identifiant.** Defaut: **identifiants neufs en minuscules seulement**. A verifier d'abord sur le site de test: si les anciens identifiants (`Lila-7k2f`) ne marchent qu'avec la bonne casse, on ajoute un message d'aide sur l'ecran de connexion. On ne peut pas modifier ce reglage du pool apres sa creation; changer de pool est hors sujet de ce lot.
8. **Deux freres avec le meme surnom ?** Defaut: **non** dans la meme famille. Deux familles differentes peuvent avoir le meme.
9. **Anciens comptes.** Defaut: **on ne change rien d'office**. Leur surnom affiche devient le nom sans le code (`Lila`), leur identifiant reste le meme, et le parent peut renommer.
10. **Reponse de `POST /activation`.** Defaut: **renvoyer l'identifiant dans la reponse** (`200` au lieu de `204`). Seul changement du contrat qui n'est pas un simple ajout.
11. **Liste de mots refuses.** Defaut: **une liste courte maintenue dans le depot**, a faire evoluer apres les premiers retours. Tu n'as pas a la relire mot a mot.
12. **Textes legaux.** La politique (« pseudo choisi par le parent ») et la section « correction » (« supprimer et recreer ») changent. Decision: **le proprietaire relit les nouveaux textes** (commit separe). **Pas de hausse propre de `POLICY_VERSION`**: hausse unique commune avec R1.

## 10. Decoupage en lots et proprietaires de fichiers

Dependance: le lot 1 attend la fusion de #82 (contrat 1.5.0). Le lot 2 peut commencer avec le faux serveur des que les formes de la section 6 sont arretees.

| Lot | Contenu | Fichiers (proprietaire du lot) |
|---|---|---|
| ID1-A (api, shared) | Regles de pseudo, liste, format des identifiants, creation, activation avec `displayName`, `PATCH displayName`, `POST login-id`, vues `Student` et `Me`, classement | `shared/pseudo-rules.ts`, `shared/pseudo-blocklist.ts`, leurs tests, `api/src/lib/identity.ts` (ajout `updateAlias`, `memoryIdentity`), `api/src/family/students.ts`, `api/src/family/activation.ts`, `api/src/game/access.ts`, `api/src/game/family-read.ts`, `api/src/handlers/me-get.ts`, `activation-post.ts`, nouveau handler `students-login-id-post.ts`, tests api |
| ID1-C (contrat) | Passage au contrat additif, fichiers generes, tests de contrat | `shared/contract/openapi.yaml`, `shared/contract/generated/*`, tests de contrat. Un seul proprietaire apres #82; commit avant ID1-A |
| ID1-I (infra) | Route API Gateway `POST /students/{sid}/login-id` avec plafond 1/3, **role IAM dedie** (`AdminGetUser`, `AdminUpdateUserAttributes`, `AdminUserGlobalSignOut`, table limitee a la partition famille) | `infra/lib/api-stack.ts` ou `game-stack.ts`, `infra/test/*` |
| ID1-W (web) | Ecrans Activate, Login (texte), Home (salut + profil), Parent (identifiant, renommer, nouvel identifiant), composant `LoginIdCard`, styles | `web/src/screens/Activate.tsx`, `Login.tsx`, `Home.tsx`, `Parent.tsx`, `web/src/components/LoginIdCard.tsx`, `web/src/api.ts`, `web/src/styles*.css`, `web/src/flows.test.tsx` |
| ID1-E (e2e et faux serveur) | Parcours e2e, faux serveur | `e2e/mock-api/server.mjs`, `e2e/tests/02-famille.spec.ts` |
| ID1-L (legal et docs) | Politique, registre, AIPD, modele de donnees | `docs/legal/*` (proprietaire du depot), `docs/data-model.md` (attributs `loginId`, `displayName`) |

### Fichiers partages avec d'autres lots et ordre de passage

Ce tableau remplace l'ancienne affirmation « aucun lot ne touche les memes fichiers » (fausse). Sources: `docs/R1-design.md` section 12, `docs/F10-design.md` et la PR #88 (Q1). Regle: le premier de la colonne « Ordre » edite, les suivants **rebasent sur `main`** avant de commencer; un lot qui n'a pas encore son tour ne touche pas le fichier.

| Fichier | Lots concernes | Ordre de passage |
|---|---|---|
| `shared/contract/openapi.yaml` et `generated/*` | F10 et Q1-K (1.6.0), R1-A, ID1-C | R1 (fait, 1.5.0), puis F10 et Q1 (1.6.0, entre eux dans l'ordre de fusion), puis **ID1-C en dernier: numero libre suivant** (1.7.0 si F10 et Q1 se partagent 1.6.0, a renumeroter sinon) |
| `api/src/family/students.ts` | ID1-A (creation, `PATCH`), R1-A (suppression: S3 `figures/` avant `deleteStudentTree`) | R1-A d'abord (il touche `purgeStudent`), puis ID1-A |
| `shared/delete-tree.ts` et son test de comptage | ID1-A (reservation `NAME#`), R1-A | R1-A d'abord, ID1-A rebase et ajoute la reservation au comptage |
| `shared/ddb/keys.ts`, `docs/data-model.md` | ID1-A (`keys.name`, ligne de reservation), R1-A (proprietaire, relu par le proprietaire de L1c) | R1-A d'abord, puis ID1-A |
| `infra/lib/api-stack.ts` (table `ROUTES`) | ID1-I, R1-A/R1-B (routes `/me/export/archive`), F10 | dans l'ordre de fusion; chaque lot ajoute ses lignes, rebase obligatoire |
| `e2e/mock-api/server.mjs` | ID1-E, R1-A, Q1-E | R1-A, Q1-E, puis ID1-E |
| `e2e/tests/**` | ID1-E (`02-famille.spec.ts`), R1-C (`e2e/**` hors mock-api), Q1-E (`08-banque.spec.ts`) | R1-C, puis ID1-E (fichiers differents, rebase seulement) |
| `web/src/api.ts` | ID1-W, R1-C | R1-C d'abord, puis ID1-W |
| `docs/legal/*` et `POLICY_VERSION` | ID1-L (commit de cette PR), R1-D, Q1 (#88) | une **seule hausse de `POLICY_VERSION`**, faite par R1-D apres la fusion de #86 et #88; ID1-L n'y touche pas. Un essai `git merge-tree` entre #86 et #88 est propre aujourd'hui (lignes differentes des memes fichiers) |

Ordre des lots ID1: ID1-C (apres F10 et Q1), puis ID1-A et ID1-I en parallele, puis ID1-W et ID1-E; ID1-L est deja fait (cette PR). **ID1-A, ID1-C et ID1-W partent en un seul deploiement** (section 6, D1). Les lots F10 et Q1 ne touchent pas les ecrans Activate, Login, Home, Parent.

## 11. Risques et limites connus

- Casse des anciens identifiants: pas verifiee sur le vrai pool (point 7).
- Liste de mots refuses: elle ne remplace pas un controle humain; des variantes passeront. Le parent est le filet. Un faux positif laisse l'enfant bloque sans comprendre (message neutre voulu, 4.3): a surveiller apres la mise en ligne.
- Le verrouillage Cognito apres des essais rates n'a pas ete mesure (4.1).
- Le texte de la politique decrit un pseudo choisi par l'eleve sans validation du parent avant affichage (point 2 de la section 9); pour les moins de 15 ans, a signaler a la personne qui relit les textes. La hausse de version commune avec R1 est ce qui fait relire le texte aux familles deja consenties.
- Le nom de famille ecrit a la main n'est pas detectable (4.4).
- Les gabarits d'ecran sont decrits, non maquettes; une maquette sera faite en ID1-W avant la PR.
- Aucun appel Cognito reel n'a ete fait pour cette conception: le comportement de `AdminUpdateUserAttributes` sur `preferred_username` (liberation de l'ancien alias, erreur de doublon) est celui de la documentation et sera teste sur dev en ID1-A.
