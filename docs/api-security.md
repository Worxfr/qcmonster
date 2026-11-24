# Notes de securite de l'API (L1c)

## Route publique `POST /activation`

Seule route sans JWT (`HttpNoneAuthorizer` dans `infra/lib/api-stack.ts`, `security: []` dans le contrat; un test verifie qu'elle est la seule). Risques connus et regles pour le handler (L3, `activation-post`):

- **Limitation globale, pas par IP ni par jeton**: 1 requete/s, rafale 3, pour toute la route. Un tiers peut l'epuiser et empecher un enfant d'activer son compte. Risque **accepte en v1** (usage familial prive). Pour une ouverture au-dela: WAF avec regle par IP devant l'API.
- **Essais de jetons**: le seul frein est cette limite. Le handler rend **le meme 404** pour un jeton inconnu, expire ou deja utilise; compare en temps constant; ne stocke que le hache (SHA-256, `ACTIVATION#<hache>`, TTL 24 h; design 4.8).
- **Mot de passe**: le contrat impose 12 caracteres minimum; la politique du pool Cognito (majuscule, minuscule, chiffre) s'applique en plus a `AdminSetUserPassword`. Une erreur de politique renvoie 400 `requete_invalide` sans citer la valeur.
- **Journaux**: ne jamais journaliser le corps de la requete (jeton, mot de passe). Le journal d'acces de l'API n'en contient pas; `shared/log` n'accepte que des champs techniques.
- **A verifier en dev apres deploiement**: un appel sans jeton repond 501 (squelette) et non 401.

## Fonctions fournies par les lots

Une ligne de `ROUTES` passee a `owner: 'pipeline' | 'game'` fait pointer la route vers `qcm-<env>-<handler>`, **sans permission d'invocation** dans cette stack. Le lot doit ajouter la permission avec `sourceArn` limite a l'API (`/qcm/<env>/api/id`), dependre de la stack Api, et poser `QCM_ENV` dans la configuration de la fonction (requis par `shared/bedrock.ts`).
