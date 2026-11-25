# Outil d'évaluation (lot 2c)

`npm run eval` écrit `eval/report.json` (non versionné). Chaque taux est donné avec `k`, `n` et l'intervalle de Wilson à 95 % (`lo`, `hi`). `checks` compare les valeurs aux seuils fixes de design-v2 10.3 (`ok: null` = non mesuré).

| Commande | Effet |
|---|---|
| `npm run eval` | contre l'API simulée (`EVAL_API_URL`, défaut `http://localhost:4010`, après `npm run mock`). **Mesures sans valeur** (`valid: false`). |
| `npm run eval -- --oracle` | pipeline imaginaire sans réseau, pour essayer l'outil |
| `EVAL_MODE=real EVAL_API_URL=... EVAL_API_TOKEN=... npm run eval` | contre l'API déployée par Cognito (chemin jamais exécuté, remplacé par la voie `lambda` ci-dessous) |
| `EVAL_MODE=lambda npm run eval -- --limit=3` | **vrai pipeline en dev** par la Lambda `eval-run` (voir ci-dessous) |
| `GOLDEN_PRIVATE_DIR=... npm run eval -- --hidden` | ajoute les pages cachées et les vraies photos; 3 lancements au plus, tracés dans `hidden-runs.json` du dossier privé |

Pages refusées: elles restent au dénominateur du rappel et des faux positifs (erreurs comptées manquées) et déclenchent `noPageRefusedWrongly`.

Injection: `sameVerdictAsWithoutInjection` compare le verdict de chaque affirmation avec la page témoin (`golden/pages/<id>.clean.jpg`, sans la phrase d'injection du cours). Pour les passages (A7), la comparaison exige un runner capable de rejouer avec des passages propres (`passageTwin`); l'API publique ne le permet pas, la mesure reste `null` jusqu'à L2b.

Fidélité: chaque lancement tire 50 affirmations produites avec une graine fixe (`fidelity-sample.json`, dans le dossier privé si `GOLDEN_PRIVATE_DIR` est défini); le propriétaire y note `faithful`.

Avec `GOLDEN_PRIVATE_DIR`, l'outil refuse de tourner si les compteurs du manifeste diffèrent des annotations privées; `npm test` fait la même vérification quand la variable est définie.

Mesures: ancrage, rappel des erreurs et faux positifs (mise au point et cachées, écart de rappel), QCM valides et fidélité (lues dans `EVAL_REVIEW_FILE`, `{"qcm":{"reviewed":50,"valid":49},"fidelity":{"reviewed":50,"faithful":50}}`), OCR (mots de la référence retrouvés, sur les pages dégradées), coût par page, durée, injection (canari `INJECTION-OK` dans la sortie, rappel sur les pages d'injection), pages sans contenu refusées.

Non mesuré pour l'instant: le coût (le contrat d'API ne l'expose pas), le jeton « aucun contenu » dans les journaux (`noContent.tokenLeak` reste `null`, à brancher quand l'infrastructure existe).

## Voie `lambda` (dev seulement, lot E1)

Pas de compte Cognito ni de secret: le workflow `eval` (`mode: lambda`) prend le rôle `QCMonster-Eval-dev` par OIDC (sub exact `environment:dev`, qui ne peut qu'invoquer `qcm-dev-eval-run`) et appelle la Lambda avec la CLI AWS, une page par appel.

- **Stack** `qcm-dev-eval` (`infra/lib/eval-stack.ts`): créée seulement avec `-c env=dev -c evalPath=true -c evalSubPrefix=...` (erreur en prod). Workflow `eval`, modes `deploy-eval` puis `destroy-eval`. Depuis `main` seulement, avec `DEPLOY_ENABLED=true`.
- **Lambda** `eval-run` (`eval/lambda/`): exécute les vraies étapes (transcription, extraction, vérification, génération, contrôle des QCM) sur une page **synthétique du dépôt**, avec une base en mémoire. Elle n'écrit dans DynamoDB que le compteur `COST#dev` (via `invokeModel`: plafond de dev 50 EUR et plafond par traitement 0,25 EUR s'appliquent). Identifiants de pages acceptés: `synth-<matière>-NN` et `neg-*`; jamais `synth-h-*` (cachées) ni `real-*` (privées).
- **Mesures**: coût réel par étape (mêmes prix que le compteur), durée, jetons, compteurs avant/après (action `cost`), appels non comptés. `eval/report.json` (artefact) ne contient aucun texte de cours: comptes, coûts, délais, classes d'erreur.
- **Arrêts**: `max_eur` (dépense du lancement, défaut 1 EUR, 25 au plus), `EVAL_STOP_AT_TOTAL_EUR` (cumul dev, défaut 40 EUR), plafond de dev 50 EUR dans le code. La CLI n'a aucun nouvel essai (`AWS_MAX_ATTEMPTS=1`): un essai de plus serait une facture de plus.
- **Limites** (`shortcut`): le cache de verdicts n'est pas partagé entre pages (coût mesuré = pire cas); l'étape de quota n'est pas jouée; pages cachées non prises en charge par cette voie; la recherche de sources va réellement sur Wikipédia/Wikimedia.

## Causes du rappel (V3)

`report.json` contient `causes` (aucun texte de cours): `insertedErrors` (pour chaque erreur insérée: `detectee`, `affirmation_absente` = l'extraction n'a pas repris la phrase, `jugee_verifiee`, ou la cause tracée par le pipeline), `nonVerifiable` (causes des affirmations non vérifiables), `correctClaims` (idem pour les phrases justes) et le détail par page.
Causes: `aucun_passage`, `passage_sans_le_fait` (le juge dit non_verifiable et moins de 60 % des mots-clés hors nombres figurent dans le meilleur passage; proxy), `juge_prudent` (non_verifiable alors que le passage couvre les mots-clés), `citation_rejetee` (verdict erreur/verifiee sans citation valide: moins de 15 caractères ou absente du passage), `regle_niveau`, `seconde_lecture_desaccord`, `seconde_citation_rejetee`, `sortie_illisible`, `verdict_absent`, `appel_ignore` (budget), `cache`.
