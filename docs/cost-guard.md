# Garde de cout des essais Bedrock (dev)

Decision du proprietaire (2026-11-24): **12 EUR au plus d'essais Bedrock en `dev`**. Le garde est dans le code, pas dans la bonne volonte.

## Ce qui est applique par le code

| Regle | Ou | Effet |
|---|---|---|
| Plafond d'essais dev `DEV_TRIAL_CAP_EUR = 12` | `shared/names.ts`, `shared/cost.ts` (`costGateFor`), `shared/bedrock.ts` | En `dev`, des que le compteur du mois `COST#dev` atteint 12 EUR, **tout appel Bedrock est refuse avant d'etre emis** (`CostBlockedError`). Le test `shared/bedrock.test.ts` verifie que le modele n'est pas appele |
| Seuils `prod` (alerte 10, blocage des nouveaux envois 15, arret 18 EUR) | `shared/cost.ts` (`costGate`) | inchanges |
| Plafond par traitement `JOB_COST_CAP_EUR = 0,25` | `shared/bedrock.ts` | refus avant l'appel si le job a deja depense 0,25 EUR (`JobBudgetExceededError`); les affirmations restantes sont `non_verifiable` |
| Compte immediat | `shared/bedrock.ts` | le cout est ajoute au compteur des la reponse, avant tout traitement (un `Retry` ne perd rien) |
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

- Le compteur est mensuel et commun a tous les lots qui travaillent en dev: trois lots en parallele se partagent les 12 EUR.
- Le compteur ignore ce qui ne passe pas par `shared/bedrock.ts` (appel direct, console AWS): le garde `scripts/guards.test.ts` couvre le depot, pas le compte.
- `eval/` a son propre garde (5 EUR d'apres le design 9); il n'est pas modifie ici (`eval/` n'appartient pas a L1c). A aligner sur `COST#dev` par son proprietaire.
- Le prix `shared/pricing.ts` est celui de l'offre lue le 2026-11-23; un ecart de facturation reelle se verifie au controle J+2 (design 4.6).
