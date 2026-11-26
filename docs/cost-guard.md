# Garde de cout des essais Bedrock (dev)

Decision du proprietaire (2026-11-24, relevee le 2026-11-25 puis le 2026-11-26, F12): **100 EUR au plus d'essais Bedrock en `dev`** (50 EUR jusqu'au 2026-11-26, 12 EUR avant le 2026-11-25). Le plafond est la constante unique `DEV_TRIAL_CAP_EUR` de `shared/names.ts`; tests et docs la citent. Le plafond par traitement reste obligatoire; depuis le 2026-11-25 il est proportionnel au nombre de pages (voir ci-dessous). Le garde est dans le code, pas dans la bonne volonte.

## Ce qui est applique par le code

| Regle | Ou | Effet |
|---|---|---|
| Plafond d'essais dev `DEV_TRIAL_CAP_EUR = 100` | `shared/names.ts`, `shared/cost.ts` (`costGateFor`), `shared/bedrock.ts` | En `dev`, des que le **cumul depuis le debut de la phase dev** (`COST#dev / TOTAL`, jamais remis a zero, different du compteur mensuel) atteint 100 EUR, tout nouvel appel Bedrock est refuse avant d'etre emis (`CostBlockedError`). Le test verifie que le modele n'est pas appele, meme quand le mois repart de zero |
| Comptage fin | `shared/cost.ts` | Le compteur est en **micro-euros entiers** (attribut `micros`, ajout atomique du mois et du cumul dans une transaction). Un appel de 0,00055 EUR compte 550, pas 0. Test: 1000 appels de 0,0015 EUR = 1,50 EUR |
| Environnement et mois non contournables | `shared/bedrock.ts` | L'environnement vient de `QCM_ENV` (pose par CDK dans la configuration de chaque Lambda qui appelle Bedrock; absent ou invalide = erreur) et le mois de l'horloge (`monthParis`), jamais d'un parametre d'appel |
| Compteur illisible | `shared/cost.ts` | Valeur non numerique ou non finie: erreur, donc appel refuse. Compteur absent = 0 (debut de periode) |
| Seuils `prod` (alerte 10, blocage des nouveaux envois 15, arret 18 EUR) | `shared/cost.ts` (`costGate`) | inchanges |
| Plafond par traitement `JOB_COST_CAP_EUR = 0,25` | `shared/bedrock.ts` | `jobSpentEur` est **obligatoire** (somme des `costEur` des appels du job, tenue par l'appelant dans l'element Job): refus avant l'appel si 0,25 EUR est atteint (`JobBudgetExceededError`); les affirmations restantes sont `non_verifiable`. Une requete est bornee (`LIMITS`: 8 192 tokens de sortie, 10 images de 5 Mo, 400 000 caracteres) pour qu'un seul appel ne depasse pas ce plafond |
| Plafond par traitement proportionnel aux pages (decision du 2026-11-25, FEAT-A, **a implementer par le lot B1**) | `shared/names.ts` (`jobCapEur(pages)`), `api/src/pipeline/ctx.ts`, `steps-doc.ts`, `api/src/verify/run.ts` | `jobCapEur(pages) = max(0,25 ; 0,15 x pages)` EUR: 0,25 pour 1 a 1 page et demie, 0,45 pour 3 pages, **1,50 pour 10 pages**. Motif: le cout mesure est d'environ 0,09 EUR par page (p95 0,12), donc un plafond fixe de 0,25 EUR rendrait `non_verifiable` la fin de tout scan de 3 pages ou plus. `JOB_COST_CAP_EUR = 0,25` reste le plancher. Meme garde que ci-dessus (refus **avant** l'appel, `jobSpentEur` obligatoire), seul le plafond change; le nombre de pages vient du job (`pages`), jamais du client apres creation. Le plafond d'essais dev de 100 EUR et les seuils mensuels sont inchanges et priment: un scan de 10 pages ne peut pas depasser 1,50 EUR, soit 1,5 % du plafond d'essais |
| Compte immediat | `shared/bedrock.ts` | le cout est ajoute des la reponse, avec 3 essais (100, 400, 1600 ms). Si l'ecriture echoue 3 fois: journal d'erreur avec `costEur` (a rattraper a la main) et **pas d'exception** (un `Retry` Step Functions rappellerait le modele et doublerait la facture); `counted: false` est renvoye |
| Un seul client | `scripts/guards.test.ts` | le SDK `client-bedrock-runtime` n'est importable que par `shared/bedrock.ts` |
| Profil d'application obligatoire | `assertApplicationProfileArn` | un ARN de profil systeme ou d'une autre region est refuse |
| Mode simule par defaut | `QCM_BEDROCK` | sans `QCM_BEDROCK=real`, le port est un faux: aucun reseau, aucun cout. Les tests ne l'activent jamais |

## Budget par lot (a respecter, a mesurer par le compteur)

- Mise au point des prompts: **echantillon de 10 pages** (`TRIAL_TUNING_PAGES`), environ 1,2 EUR par passage.
- **2 passages complets au plus par lot** (`TRIAL_MAX_FULL_RUNS_PER_LOT`): 38 pages x 0,12 EUR = 4,6 EUR le passage, soit 9,2 EUR pour deux. Les 12 pages cachees (environ 1,4 EUR par lancement, 3 lancements au plus) se comptent a part.
- Aucun envoi de photo sur `dev` hors des runs prevus: un envoi lance la machine et appelle Bedrock.
- Tout travail de prompt qui peut se faire sur le jeu dore avec le faux modele se fait ainsi. Les appels reels sont des commandes explicites (`eval.yml`, mode `real`), jamais un test ordinaire.
- Si le compteur de dev atteint 100 EUR, les essais s'arretent: la suite se discute avec le proprietaire, on ne releve pas le plafond de soi-meme.

## Test M2: qui peut appeler Bedrock (`infra/test/m2-bedrock.test.ts`)

Le garde de cout ne protege que le code qui passe par `shared/bedrock.ts`. M2 verifie que **aucune autre identite** ne peut invoquer un modele. Le test synthetise TOUTES les stacks de l'application (dev et prod, y compris celles qu'un lot ajoutera) et echoue si:

- un role (ou utilisateur, groupe, politique sans role) hors de `processingRoleNames` recoit une action qui lance un modele (`InvokeModel*`, `Converse*`, agents, flux, `*`, `bedrock:*`, `NotAction` sur un Allow). Les roles sans nom fixe echouent aussi;
- un role de traitement a une autre action que `bedrock:InvokeModel`, un joker (action, ressource, region, condition), ou une ressource qui n'est pas: le profil d'application `qcm-<env>-(haiku|sonnet)` (parametre SSM), le profil systeme UE de `SYSTEM_PROFILES`, ou le modele de base dans une region de `EU_REGIONS` **avec** la condition `bedrock:InferenceProfileArn` vers un de ces profils;
- une politique geree AWS est jointe a un role/utilisateur/groupe hors liste blanche (`service-role/AWSLambdaBasicExecutionRole` seule). Liste blanche et non liste noire: `AmazonBedrock*`, `AdministratorAccess`, `PowerUserAccess` et toute politique inconnue echouent. Les politiques gerees du client (`AWS::IAM::ManagedPolicy`) sont lues comme des politiques en ligne;
- le role OIDC de deploiement (`infra-bootstrap/setup-oidc.sh`, hors CDK) accorde autre chose que `sts:AssumeRole` (roles de bootstrap CDK) et `ssm:GetParameter`, nomme Bedrock, ou joint une politique autre que la sienne.

Des tests negatifs construisent de vrais templates fautifs (politique geree Bedrock, role hors liste, jokers, region `*`, modele de base sans condition, utilisateur, politique orpheline) et verifient que le detecteur echoue. Un `Deny` Bedrock n'est pas une ouverture (filet du budget securite-40).

**Hors de portee du test** (a verifier dans le compte avant le premier appel reel, sans que ce depot connaisse l'ID du compte): les roles crees hors CDK, les utilisateurs IAM humains, le role d'execution CloudFormation du bootstrap CDK (`cdk-*-cfn-exec-role`, `AdministratorAccess` par defaut: le role OIDC ne peut que l'utiliser pour deployer, pas appeler Bedrock directement, mais un deploiement CDK peut creer une identite), les politiques de controle de service. Pour fermer ce dernier point: bootstrap avec une politique d'execution limitee (`--cloudformation-execution-policies`).

## Limites connues

- **La garde n'est pas atomique avec l'appel**: lecture du compteur, appel, puis ajout. Des appels en parallele (Map Step Functions, 38 pages) passent tous la garde avec le meme total: le depassement est borne par (concurrence x cout maximal d'un appel). Avec les bornes de `LIMITS` et les prix de `pricing.ts`, cela reste de l'ordre du centime a quelques dizaines de centimes. Une reservation d'estimation (`ADD` conditionnel avant l'appel, puis regularisation) serait plus stricte; non faite, a reprendre si la concurrence monte.
- **Un appel qui echoue apres facturation partielle** (delai depasse cote client alors que Bedrock a traite) n'est pas compte: aucun `usage` n'est renvoye. Risque accepte, borne par le plafond de 100 EUR et par le controle J+2 de la facture reelle.
- Le cumul de 100 EUR est commun a tous les lots qui travaillent en dev. Le relever demande une decision du proprietaire.
- Le compteur ignore ce qui ne passe pas par `shared/bedrock.ts` (appel direct, console AWS): `scripts/guards.test.ts` couvre le depot, le test M2 ci-dessous couvre les roles du compte deployes par CDK. Ce qui reste hors de portee des tests est liste dans « Test M2 ».
- `eval/` n'a **pas de garde de cout propre dans le code**: l'outil de mesure appelle l'API, donc passe par le meme `invokeModel` et le meme compteur `COST#dev / TOTAL` (plafond `DEV_TRIAL_CAP_EUR`). Il n'y a donc aucun 12 EUR a aligner dans `eval/`. Seul le commentaire d'en-tete de `.github/workflows/eval.yml` cite encore « 12 EUR » (hors du perimetre de L1d: a corriger par le proprietaire de `.github/**`). L'arret a 5 EUR par mois d'evaluation de design-v2 (9) n'est pas implemente.
- Le changement de nom de l'attribut (`cents` -> `micros`) ne demande aucune migration: le compteur dev etait vide.
- `eval/` a son propre garde (5 EUR d'apres le design 9); il n'est pas modifie ici. A aligner sur le cumul `COST#dev / TOTAL` par son proprietaire.
- Le prix `shared/pricing.ts` est celui de l'offre lue le 2026-11-23; un ecart de facturation reelle se verifie au controle J+2 (design 4.6). Le taux `USD_PER_EUR` est une constante.
- L'ARN du profil est valide par son format (region, 12 chiffres, `application-inference-profile/`); il n'est pas compare a l'identifiant de compte attendu (il ne doit pas etre ecrit dans le depot). Un lot peut ajouter cette comparaison avec `CDK_DEFAULT_ACCOUNT`.

## Alarme de cout de 10 EUR (a corriger, lot B1 + lot I)

Constat (`FEAT-D-report.md` section 4): l'alarme `qcm-<env>-cout-mensuel-10` (stack Budget) ne recoit aucune metrique. `publishCostMetric` (`shared/cost.ts`) n'est appelee nulle part et aucun role n'a `cloudwatch:PutMetricData`; avec `treatMissingData: NOT_BREACHING` elle reste donc toujours en OK. Correctif retenu: publier le total du mois au point unique d'ecriture du compteur, `costStoreFromDynamo(...).add` de `shared/bedrock.ts` (utilise par le pipeline ET par `verify-run`), au mieux (une erreur CloudWatch est journalisee sans identifiant de cours et n'echoue jamais l'appel), avec `PutMetricData` limite a l'espace de noms `QCMonster` sur les deux roles qui ecrivent le compteur. Cout: une metrique personnalisee (environ 0,30 USD par mois) et 0,01 USD par 1000 requetes. Repartition: `docs/feat-a-lots.md`, lot « Alarme de cout 10 EUR ».

### Risque accepte: plafond proportionnel

Decision du 2026-11-25. Avant, un scan coutait au plus 0,25 EUR quel que soit son nombre de pages (environ 0,025 EUR par page a 10 pages, au prix de fiches « non verifiables »). Apres, il peut coûter jusqu'a 1,50 EUR a 10 pages: la consommation des essais dev peut donc etre plus rapide (jusqu'a 6 fois par scan de 10 pages). Ce qui protege: le plafond dur d'essais de 100 EUR (`DEV_TRIAL_CAP_EUR`, cumul `COST#dev / TOTAL`, arret avant l'appel) et la limite de 10 transcriptions par jour et par eleve; le depassement possible est borne par ce qui est en vol au moment du blocage (voir « La garde n'est pas atomique »). Un scan de 10 pages pesant au plus 1,5 % du plafond d'essais, le risque est accepte.

### Lecture du scan comme un seul document (FEAT-A)

La transcription passe de N appels d'une image a un appel de 4 images au plus (ou des fenetres de 3 pages plus une page de contexte), suivi d'un appel de texte seul qui decide type, matiere et sujet. Estimation (a mesurer, voir `docs/feat-a-lots.md`): environ 0,002 EUR pour 3 pages, moins de 3 % du plafond `max(0,25 ; 0,15 x pages)`, qui ne change pas. Les bornes de requete (`LIMITS`: 8 192 jetons de sortie, 10 images) restent, avec 4 images au plus par appel; la limite de taille d'image de Bedrock (a verifier, peut-etre 3,75 Mo) est a controler par un appel reel avant la fusion de B1. Une fenetre dont la sortie est tronquee est rejouee page par page (cout d'avant).

### Un scan, plusieurs fiches (sections)

Le plafond `jobCapEur(pages)` vaut pour **tout le job**, somme des sections (le cout s'accumule dans `Job.coutMicros`). Pour qu'une premiere section n'epuise pas le plafond, le budget restant de chaque section (`budgetRestantCentimes` de `extract`, repris par `verify-run`) est la part du reste proportionnelle aux mots des sections encore a traiter. Chaque section ajoute une extraction, une verification et une generation: un surcout fixe estime a quelques pourcents (invites systeme repetees), non mesure; a mesurer avec la lecture en un seul document, sur un cours de 3 pages coupe en 2 sections. Le plafond d'essais de 100 EUR et les seuils mensuels sont inchanges.

## Seuils mensuels par environnement (F12, 2026-11-26)

| Seuil | Prod | Dev |
| --- | --- | --- |
| Alerte e-mail (alarme `qcm-<env>-cout-mensuel-<seuil>`) | 10 EUR | 80 EUR |
| `budget_epuise` sur `POST /scans` (`block_new`) | 15 EUR | 95 EUR |
| Arret des traitements (`stop_all`) | 18 EUR | 100 EUR |
| Plafond cumule d'essais | sans objet | 100 EUR |

Source unique: `costThresholdsFor(env)` dans `shared/names.ts`. En dev, les seuils mensuels sont alignes sur le plafond cumule pour ne jamais bloquer avant lui, et l'alerte part a 80 EUR. Limite: l'alarme lit le compteur du MOIS; si les 100 EUR s'etalent sur plusieurs mois, elle peut ne pas se declencher, le plafond cumule bloque quand meme. Les budgets AWS (20/25/40 EUR) ne sont crees que par la stack prod et sont inchanges. Le plafond par scan `max(0,25 ; 0,15 x pages)` est inchange.
