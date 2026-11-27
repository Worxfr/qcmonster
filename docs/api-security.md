# Notes de securite de l'API (L1c)

## Routes publiques (sans JWT)

Trois routes seulement (`public: true` dans `ROUTES`, `HttpNoneAuthorizer` dans `infra/lib/api-stack.ts`, `security: []` dans le contrat): `POST /activation`, `POST /shares/open` et `POST /shares/report` (S1 #34, contrat 1.12.0). Un test du contrat et un test de la stack verifient que ce sont **exactement** ces trois routes.

## Route publique `POST /activation`

Sans JWT. Risques connus et regles pour le handler (L3, `activation-post`):

- **Limitation globale, pas par IP ni par jeton**: 1 requete/s, rafale 3, pour toute la route. Un tiers peut l'epuiser et empecher un enfant d'activer son compte. Risque **accepte en v1** (usage familial prive). Pour une ouverture au-dela: WAF avec regle par IP devant l'API.
- **Essais de jetons**: le seul frein est cette limite. Le handler rend **le meme 404** pour un jeton inconnu, expire ou deja utilise; compare en temps constant; ne stocke que le hache (SHA-256, `ACTIVATION#<hache>`, TTL 24 h; design 4.8).
- **Mot de passe**: le contrat impose 12 caracteres minimum; la politique du pool Cognito (majuscule, minuscule, chiffre) s'applique en plus a `AdminSetUserPassword`. Une erreur de politique renvoie 400 `requete_invalide` sans citer la valeur.
- **Journaux**: ne jamais journaliser le corps de la requete (jeton, mot de passe). Le journal d'acces de l'API n'en contient pas; `shared/log` n'accepte que des champs techniques.
- **A verifier en dev apres deploiement**: un appel sans jeton repond 501 (squelette) et non 401.

## Routes publiques `POST /shares/open` et `POST /shares/report` (S1, `docs/S1-design.md` sections 4, 7 et 11)

Squelettes 501 tant que S1-A n'a pas fourni les handlers (`shares-open`, `shares-report`). Le partage reste **ferme**: `SHARE_PUBLIC_ENABLED` a `false` (les deux routes repondent le meme `404 lien_indisponible`, sans lecture de table), et le parent doit activer `sharing` pour chaque eleve.

- **Limitation globale par route, pas par IP ni par jeton**: `POST /shares/open` 3 requetes/s, rafale 6; `POST /shares/report` 1 requete/s, rafale 3. Un tiers peut epuiser une route et empecher un destinataire de lire (meme risque que `/activation`, **accepte en v1**, usage familial). Chaque route a sa propre limite: une route publique saturee ne gene aucune autre route. Defense plus fine: WAF devant CloudFront (hors perimetre, point S1-P16).
- **Jeton dans le corps**, jamais dans le chemin ni l'URL (le lien est `/p#t=<jeton>`, le fragment n'est jamais envoye au serveur). Le journal d'acces de l'API n'a pas les corps. Jeton de 128 bits, jamais stocke (seul le SHA-256 l'est), valide avant tout hachage et tout acces a la table (22 caracteres base64url, sinon le meme 404).
- **Reponse unique `404 lien_indisponible`** pour un jeton mal forme, inconnu, expire, revoque, suspendu ou au plafond du jour. Un jeton inconnu n'ecrit jamais rien.
- **Jeton mal forme: 404, pas 400** (tranche en S1-A, relecture #106 m1). Le handler ne valide PAS le jeton avec le motif `ShareToken` du contrat (le Zod genere renverrait 400): il controle la forme lui-meme (`SHARE_TOKEN_RE`) et repond le meme `404 lien_indisponible`, sans hachage ni acces a la table. `400` reste pour un corps illisible, un jeton absent ou non textuel, ou un motif de signalement hors liste. Le `400` declare au contrat couvre ces cas; le motif `^[A-Za-z0-9_-]{22}$` de `ShareToken` decrit la forme d'un jeton emis, il n'est pas la regle de rejet. Un validateur de requetes place devant l'API (le mock Prism) rendrait en revanche un 400 pour un jeton mal forme.
- **Interrupteur `SHARE_PUBLIC_ENABLED`** (variable des huit fonctions du partage, `false` par defaut en dev et en prod; `true` seulement par `-c sharePublicEnabled=true` au deploiement): ferme, les deux routes publiques repondent le meme 404 sans lire la table, `GET /docs/{docId}/shareable` et `POST /me/shares` repondent 403. La liste et la revocation (eleve et parent) restent ouvertes pour pouvoir toujours supprimer un lien. Le parent doit en plus activer `sharing` pour chaque eleve.
- **Reponses `Cache-Control: no-store`**; aucune donnee d'identite dans la copie; ne jamais journaliser le jeton, le titre ni une question.
- **Droits**: le role public ne lit et n'ecrit que la partition `SHARE#*` (aucun `Query`). Roles et test « droits declares = droits reels »: lot S1-D.

## Fonctions fournies par les lots

Une ligne de `ROUTES` passee a `owner: 'pipeline' | 'game'` fait pointer la route vers `qcm-<env>-<handler>`, **sans permission d'invocation** dans cette stack. Le lot doit ajouter la permission avec `sourceArn` limite a l'API (`/qcm/<env>/api/id`), dependre de la stack Api, et poser `QCM_ENV` dans la configuration de la fonction (requis par `shared/bedrock.ts`).
