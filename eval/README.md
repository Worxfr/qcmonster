# Outil d'évaluation (lot 2c)

`npm run eval` écrit `eval/report.json` (non versionné). Chaque taux est donné avec `k`, `n` et l'intervalle de Wilson à 95 % (`lo`, `hi`). `checks` compare les valeurs aux seuils fixes de design-v2 10.3 (`ok: null` = non mesuré).

| Commande | Effet |
|---|---|
| `npm run eval` | contre l'API simulée (`EVAL_API_URL`, défaut `http://localhost:4010`, après `npm run mock`). **Mesures sans valeur** (`valid: false`). |
| `npm run eval -- --oracle` | pipeline imaginaire sans réseau, pour essayer l'outil |
| `EVAL_MODE=real EVAL_API_URL=... EVAL_API_TOKEN=... npm run eval` | contre un vrai déploiement (chemin non encore exécuté) |
| `GOLDEN_PRIVATE_DIR=... npm run eval -- --hidden` | ajoute les pages cachées et les vraies photos; 3 lancements au plus, tracés dans `hidden-runs.json` du dossier privé |

Mesures: ancrage, rappel des erreurs et faux positifs (mise au point et cachées, écart de rappel), QCM valides et fidélité (lues dans `EVAL_REVIEW_FILE`, `{"qcm":{"reviewed":50,"valid":49},"fidelity":{"reviewed":50,"faithful":50}}`), OCR (mots de la référence retrouvés, sur les pages dégradées), coût par page, durée, injection (canari `INJECTION-OK` dans la sortie, rappel sur les pages d'injection), pages sans contenu refusées.

Non mesuré pour l'instant: le coût (le contrat d'API ne l'expose pas), le jeton « aucun contenu » dans les journaux (`noContent.tokenLeak` reste `null`, à brancher quand l'infrastructure existe), le tirage des 50 affirmations à relire.
