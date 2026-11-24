# Garde de cout des essais Bedrock (dev)

Decision du proprietaire (2026-11-24): **12 EUR au plus d'essais Bedrock en `dev`**. Le garde est dans le code, pas dans la bonne volonte.

## Ce qui est applique par le code

| Regle | Ou | Effet |
|---|---|---|
| Plafond d'essais dev `DEV_TRIAL_CAP_EUR = 12` | `shared/names.ts`, `shared/cost.ts` (`costGateFor`), `shared/bedrock.ts` | En `dev`, des que le **cumul depuis le debut de la phase dev** (`COST#dev / TOTAL`, jamais remis a zero, different du compteur mensuel) atteint 12 EUR, tout nouvel appel Bedrock est refuse avant d'etre emis (`CostBlockedError`). Le test verifie que le modele n'est pas appele, meme quand le mois repart de zero |
| Comptage fin | `shared/cost.ts` | Le compteur est en **micro-euros entiers** (attribut `micros`, ajout atomique du mois et du cumul dans une transaction). Un appel de 0,00055 EUR compte 550, pas 0. Test: 1000 appels de 0,0015 EUR = 1,50 EUR |
| Environnement et mois non contournables | `shared/bedrock.ts` | L'environnement vient de `QCM_ENV` (pose par CDK dans la configuration de chaque Lambda qui appelle Bedrock; absent ou invalide = erreur) et le mois de l'horloge (`monthParis`), jamais d'un parametre d'appel |
| Compteur illisible | `shared/cost.ts` | Valeur non numerique ou non finie: erreur, donc appel refuse. Compteur absent = 0 (debut de periode) |
| Seuils `prod` (alerte 10, blocage des nouveaux envois 15, arret 18 EUR) | `shared/cost.ts` (`costGate`) | inchanges |
| Plafond par traitement `JOB_COST_CAP_EUR = 0,25` | `shared/bedrock.ts` | `jobSpentEur` est **obligatoire** (somme des `costEur` des appels du job, tenue par l'appelant dans l'element Job): refus avant l'appel si 0,25 EUR est atteint (`JobBudgetExceededError`); les affirmations restantes sont `non_verifiable`. Une requete est bornee (`LIMITS`: 8 192 tokens de sortie, 10 images de 5 Mo, 400 000 caracteres) pour qu'un seul appel ne depasse pas ce plafond |
| Compte immediat | `shared/bedrock.ts` | le cout est ajoute des la reponse, avec 3 essais (100, 400, 1600 ms). Si l'ecriture echoue 3 fois: journal d'erreur avec `costEur` (a rattraper a la main) et **pas d'exception** (un `Retry` Step Functions rappellerait le modele et doublerait la facture); `counted: false` est renvoye |
| Un seul client | `scripts/guards.test.ts` | le SDK `client-bedrock-runtime` n'est importable que par `shared/bedrock.ts` |
| Profil d'application obligatoire | `assertApplicationProfileArn` | un ARN de profil systeme ou d'une autre region est refuse |
| Mode simule par defaut | `QCM_BEDROCK` | sans `QCM_BEDROCK=real`, le port est un faux: aucun reseau, aucun cout. Les tests ne l'activent jamais |

## Budget par lot (a respecter, a mesurer par le compteur)

- Mise au point des prompts: **echantillon de 10 pages** (`TRIAL_TUNING_PAGES`), environ 1,2 EUR par passage.
- **2 passages complets au plus par lot** (`TRIAL_MAX_FULL_RUNS_PER_LOT`): 38 pages x 0,12 EUR = 4,6 EUR le passage, soit 9,2 EUR pour deux. Les 12 pages cachees (environ 1,4 EUR par lancement, 3 lancements au plus) se comptent a part.
- Aucun envoi de photo sur `dev` hors des runs prevus: un envoi lance la machine et appelle Bedrock.
- Tout travail de prompt qui peut se faire sur le jeu dore avec le faux modele se fait ainsi. Les appels reels sont des commandes explicites (`eval.yml`, mode `real`), jamais un test ordinaire.
- Si le compteur de dev depasse 12 EUR, les essais s'arretent: la suite se discute avec le proprietaire, on ne releve pas le plafond de soi-meme.

## Limites connues

- **La garde n'est pas atomique avec l'appel**: lecture du compteur, appel, puis ajout. Des appels en parallele (Map Step Functions, 38 pages) passent tous la garde avec le meme total: le depassement est borne par (concurrence x cout maximal d'un appel). Avec les bornes de `LIMITS` et les prix de `pricing.ts`, cela reste de l'ordre du centime a quelques dizaines de centimes. Une reservation d'estimation (`ADD` conditionnel avant l'appel, puis regularisation) serait plus stricte; non faite, a reprendre si la concurrence monte.
- **Un appel qui echoue apres facturation partielle** (delai depasse cote client alors que Bedrock a traite) n'est pas compte: aucun `usage` n'est renvoye. Risque accepte, borne par le plafond de 12 EUR et par le controle J+2 de la facture reelle.
- Le cumul de 12 EUR est commun a tous les lots qui travaillent en dev. Le relever demande une decision du proprietaire.
- Le compteur ignore ce qui ne passe pas par `shared/bedrock.ts` (appel direct, console AWS): le garde `scripts/guards.test.ts` couvre le depot, pas le compte. **A faire avant le premier appel reel (test M2)**: un test CDK qui echoue si un role autre que ceux de `processingRoleNames` recoit `bedrock:Invoke*`, et la verification du compte lui-meme. C'est le seul moyen de rendre la garde vraie au niveau du compte.
- Le changement de nom de l'attribut (`cents` -> `micros`) ne demande aucune migration: le compteur dev etait vide.
- `eval/` a son propre garde (5 EUR d'apres le design 9); il n'est pas modifie ici. A aligner sur le cumul `COST#dev / TOTAL` par son proprietaire.
- Le prix `shared/pricing.ts` est celui de l'offre lue le 2026-11-23; un ecart de facturation reelle se verifie au controle J+2 (design 4.6). Le taux `USD_PER_EUR` est une constante.
- L'ARN du profil est valide par son format (region, 12 chiffres, `application-inference-profile/`); il n'est pas compare a l'identifiant de compte attendu (il ne doit pas etre ecrit dans le depot). Un lot peut ajouter cette comparaison avec `CDK_DEFAULT_ACCOUNT`.
