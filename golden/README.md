# Jeu doré (lot 2c)

50 pages: 38 de mise au point et 12 cachées. `MANIFEST.json` liste les pages et leurs compteurs (erreurs insérées, affirmations justes, injections, noms de personnes, dégradée ou non). Le test `golden/golden.test.ts` échoue si un effectif minimal de design-v2 10.3 n'est plus atteint.

| Origine | Pages | Où se trouvent images et annotations |
|---|---|---|
| Synthétiques de mise au point | 22 | ici: `pages/`, `annotations/`, `passages/` |
| Synthétiques cachées | 4 | privé (`GOLDEN_PRIVATE_DIR`, plus tard le coffre S3) |
| Photos de cours réelles | 24 (16 de mise au point, 8 cachées) | privé. Le dépôt ne porte que les compteurs; ids opaques `real-<matière>-NN`. |

Les photos réelles, leurs transcriptions, les pages cachées et leurs annotations ne vont jamais dans git. `eval/` les lit dans `GOLDEN_PRIVATE_DIR/annotations/<id>.json` et `images.json`.

## Annotations
- Page synthétique: `sentences[]` avec `kind` = `correct` (affirmation juste attendue), `error` (erreur insérée, avec `correction`), `non_factual`, `injection` (consigne d'injection dans le cours).
- `passages/<id>.json`: passage simulé par affirmation factuelle; `injected: true` quand le passage contient une phrase d'injection (cas A7). Les passages disent toujours la vérité sur le fait.
- Photo réelle: `claims[]` (affirmations justes) et `excluded[]` (doutes de lecture ou erreurs possibles de l'élève, hors mesure). Aucune erreur n'est insérée dans une vraie photo.

## Régénérer
`GOLDEN_PRIVATE_DIR=<dossier privé> npm run golden:build` (Python avec Pillow et numpy dans un venv à part). La sortie est déterministe, sauf si le texte source change.
Les sources des pages publiques sont dans `source/*.txt` (`+` juste, `!` erreur `=> correction`, `~` non factuelle).

## Limites connues
- Les pages synthétiques sont en police imprimée: elles testent la dégradation photo, pas l'écriture manuscrite (couverte par les photos réelles).
- Les passages simulés sont parfaits: ils mesurent le jugement, pas la recherche.
- Les transcriptions des photos réelles sont de ma lecture, non relues par le propriétaire; les formules sont recopiées en texte brut.
