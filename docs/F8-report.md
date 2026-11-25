# F8 - « Le traitement a échoué, rescanne ton cours »

## Cause
Le dernier scan en échec (job `01M8AG7X7CHBH41Q60MW9C3K4B`, 25/11/2026, 23:21 à 23:26 UTC, 4 pages, plan de 4 sections) s'est arrêté à l'étape **extraction** de la 2e section (index 1).
La sortie JSON du modèle (Haiku) a été **coupée par la limite de 8000 jetons** (`maxTokens: 8000` dans `extract`, `api/src/pipeline/steps-doc.ts`). Le JSON n'est donc jamais refermé, `parseModelJson` lève `sortie du modele: JSON invalide`, l'exécution passe par `MarquerEchec` puis `pipeline-fail`, et l'élève voit le message générique.
Ce n'est pas un défaut de droits ni d'infra, ni une photo trop lourde, ni un délai : c'est une donnée (section très dense) combinée à un prompt qui autorise 60 affirmations (environ 130 jetons chacune, soit à peu près la limite).

## Preuve (lecture seule, profil account-audit)
- Step Functions `qcm-dev-process`, historique de l'exécution : `LambdaFunctionFailed` sur `Sections-extraction` index 1, cause `Error: sortie du modele: JSON invalide` (pile `parseModelJson` <- `extract`). Les états `check`, `tr`, `plan` étaient `ok:true`.
- Journal CloudWatch de la Lambda `qcm-dev-pipeline-extract` : l'appel de la section 1 (réussie) a `tokensOut: 1804` ; l'appel de la section en échec a `tokensOut: 8000` (= plafond), durée 25 s, puis `status: error`.
- Les 7 exécutions précédentes du jour ont toutes réussi : un seul échec, non lié au code d'accès.
- Aucun texte de cours, e-mail ni ID de compte n'a été lu ni écrit dans le repo.

## Correctif (PR sans fusion, branche `fix/f8-scan-failure`)
1. `text.ts` : `salvageTruncatedList` récupère les objets entiers d'un tableau JSON coupé.
2. `steps-doc.ts` : `parseExtract` l'utilise quand le JSON de l'extraction est invalide. Les affirmations entières déjà reçues sont gardées (elles sont de toute façon ancrées sur les phrases du cours par `anchorClaims`) ; aucune affirmation entière : l'erreur reste levée.
3. `text.ts` / `steps.ts` : `ModelOutputError` porte son nom dans l'erreur Step Functions ; `failJob` affiche alors « Le cours est trop dense pour être lu en une fois : rescanne-le en deux parties (moins de pages à la fois) » au lieu de « rescanne ton cours ».
Tests (`api/src/pipeline/pipeline.test.ts`) : extraction coupée gardée (échoue sans le correctif), extraction sans aucune affirmation entière toujours en erreur, message précis. 548 tests verts, `tsc` propre.

## Limites
- Une section coupée donne moins d'affirmations (donc moins de questions) que prévu, sans avertir l'élève ; le champ `claimCount` reflète le réel.
- Un stop reason Bedrock n'est pas exposé par `callModel` : la détection se fait par l'échec de parse, pas par `max_tokens`.
- Ne couvre pas les autres appels JSON (transcription, génération), qui ont un repli ou des plafonds différents.
- Non rejoué sur AWS (aucun scan réel lancé) ; le correctif n'est pas déployé.
- L'e-mail du compte n'a pas été vérifié : le job a été identifié comme le plus récent en échec de la machine, pas par propriétaire.
