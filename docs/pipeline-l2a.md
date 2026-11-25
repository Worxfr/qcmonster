# Pipeline de lecture des cours (L2a)

Code: `api/src/pipeline/**`, `api/src/docs/**`, `infra/lib/pipeline-stack.ts`. Aucun appel Bedrock reel dans les tests (faux modele); en deploiement les Lambda restent en mode simule tant que `-c bedrock=real` n'est pas passe.

## Machine d'etats `qcm-<env>-process` (Standard)

Etat: `jobId`, `sid` et des booleens/compteurs seulement. Journal niveau ERROR sans donnees d'execution.

| Etat | Fonction | Effet |
|---|---|---|
| AttenteEnvoi | `upload-await` (jeton de tache, 20 min) | demarre a `POST /scans`; l'evenement S3 (`scan-start`) leve l'attente quand tous les fichiers sont la. Delai: job `expire`, quota rendu |
| ControleFichier | `scan-check` | type controle sur les octets (JPEG ou PNG, identique au type annonce); sinon `rejete` |
| Transcription | `transcribe` | 1 appel Haiku (vision) par page; type `autre` ou moins de 40 mots: `rejete`, quota rendu; plafond de 10 transcriptions par eleve et par jour (`TRANSCR#`) |
| AttenteConfirmation | `confirm-await` (jeton de tache, 30 min) | job `a_confirmer`; `POST /jobs/{id}/confirm` applique les corrections, supprime la photo et reprend; delai: `expire` |
| Extraction | `extract` | affirmations + controle d'ancrage par code, ecrit `CLAIM#<nn>` (jamais `VERDICT#`) |
| Verification | `verify-run` (L2b) | entree `{jobId, docId, budgetRestantCentimes}`, sortie `{coutCentimes, ...}` |
| ConsommationQuota | `quota-consume` | consomme les pages (une seule fois), ajoute le cout de L2b au job |
| Generation | `generate` | fiche, QCM controles (resolution a l'aveugle), trous, empreinte, doublon, etat `termine` |
| MarquerEchec | `pipeline-fail` | toute erreur: `echec`, pages rendues, qu elles soient encore reservees ou deja consommees (rendu unique, `QUOTAOP#<job>#refund`), photos et affirmations orphelines supprimees |

## Delais et reprises

Delai global de la machine: 2 h. Chaque tache a son `TimeoutSeconds` (controle 60 s, transcription 360 s, extraction 180 s, verification 960 s, quota 60 s, generation 240 s, filet 60 s); attentes de 20 et 30 min. Un test verifie que le delai global depasse la somme de tous les delais. Pas de Retry automatique sur les appels de modele, les attentes ni `verify-run`; seuls `scan-check`, `quota-consume`, `expire` et `pipeline-fail` en ont un (reprenables). `scan-check`, `transcribe`, `extract`, `await-confirm` et `generate` sont reprenables a la main: une relance continue au lieu de renvoyer un echec.

Quota: `QUOTAOP#<job>#<release|consume>` ecrit dans la meme transaction que les compteurs (une relance ne double rien et n'oublie rien).

## Ecritures (un type, un ecrivain)

`Job`, `TEXT#`, `Fiche` (+ GSI1), `CLAIM#`, `QCM#`, `GAP#`, `TRANSCR#`, `REPORT#` (creation). Champs ajoutes a la fiche, hors schema partage: `resume`, `familyId`, `studentId`, `jobId`. Champs du job hors schema partage: `coutMicros` (micro-euros, source de `Job.costCents` = arrondi au centime superieur), `quotaState` (`reserved`, `released`, `consumed`), `expectedFiles`, `uploadedKeys`, jetons de tache, `docType`, `draftTitle`, `draftSubject`.

## Cout

Chaque appel passe par `shared/bedrock.ts` (garde 50 EUR en dev, plafond 0,25 EUR par job). `Job.coutMicros` est incremente par ADD atomique des la reponse. `verify-run` recoit `budgetRestantCentimes` = plafond - depense - 6 centimes gardes pour la generation. Plafond atteint pendant la generation: la fiche est publiee sans questions.
