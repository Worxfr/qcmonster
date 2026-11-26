# F11 - Extraction robuste d'une section dense, sans jamais demander à l'élève de redécouper

## Défaut
`extract` (`api/src/pipeline/steps-doc.ts`) envoyait toute la section en un seul appel avec `maxTokens: 8000`. Le prompt autorisait 60 affirmations (environ 130 jetons chacune, soit à peu près la limite). Une section dense coupait la sortie, donc un JSON invalide. F8 (PR #66) gardait les affirmations entières déjà reçues (la fin de la section était perdue sans avertir) et, sinon, disait à l'élève de « rescanner en deux parties ».

## Solution retenue (combinaison des pistes)
1. **Tranches automatiques** (`sliceRanges`, `text.ts`): au plus 30 phrases et 6 000 caractères par tranche. Une section de 30 phrases ou moins reste en un seul appel, comme avant.
2. **Chevauchement sans double comptage**: chaque tranche reçoit 2 phrases de contexte avant elle (le prompt dit de n'en tirer aucune affirmation). Le code ignore de toute façon toute affirmation ancrée sur une phrase que la tranche ne possède pas. Une phrase n'a donc qu'une tranche propriétaire. Le dédoublonnage par texte normalisé (`anchorClaims`) reste en plus.
3. **Plafond par tranche**: le prompt demande `min(40, ceil(60 x phrases de la tranche / phrases de la section))` affirmations (au moins 3). 40 x 130 = 5 200 jetons < `maxTokens` 6 000: une tranche normale ne peut plus être coupée.
4. **Reprise si coupée**: affirmations entières gardées pour les phrases déjà passées, puis nouvelle tranche à partir de la dernière phrase atteinte (ses affirmations sont refaites, jamais gardées en double).
5. **Rejeu plus petit**: sans progrès ou sans rien de lisible, la tranche est coupée en deux et rejouée (jusqu'à 4 phrases). Garde-fou: 3 appels par tranche + 6 au plus.
6. **Plafond de la section inchangé (60)**, mais choisi **réparti sur toute la section** (`thinEvenly`) au lieu de garder les 60 premières: la fin du cours n'est plus perdue. Ordre du cours conservé (tri stable par position de la phrase). Les titre et matière viennent de la première tranche lisible; les choix de l'élève priment toujours.
7. **Arrêt en euros (relecture C1)**: avant chaque appel, si des affirmations sont déjà lues et que la dépense du job atteint plafond - `GEN_RESERVE_CENTS` (6 c; 0,19 € pour un scan d'une page), la boucle s'arrête et garde ce qui est lu: la vérification et la génération gardent leur budget. Si aucune affirmation n'est lue, l'extraction continue jusqu'au plafond complet (erreur comme avant).
8. **Bornes de taille (C2)**: au plus 12 tranches (360 phrases) par section, donc au plus 3 x 12 + 6 = 42 appels. Au-delà de 360 phrases dans UNE section, la fin n'est pas lue (le plan de sections découpe d'ordinaire bien avant). Dans ce cas, comme pour l'arrêt en euros, le garde-fou d'appels ou une tranche de 4 phrases illisible sautée, on garde ce qui est lu.
9. **Journal (C3)**: une ligne JSON sans texte de cours (`step: extraction`, `sentencesUncovered`, `stopReason` = `size`, `calls`, `budget` ou `skipped`) quand des phrases ne sont pas couvertes. Champs ajoutés à la liste blanche de `shared/log`. Aucun signal n'est transmis à l'élève ni à la fiche (pas de champ de contrat).

## Chiffres
Tarif Haiku du dépôt (`shared/pricing.ts`): 0,11 / 0,55 par million de jetons (entrée / sortie).
- Avant, section dense: 1 appel, jusqu'à 8 000 jetons en sortie (0,0044) + environ 1 700 en entrée = **environ 0,005 € par section**, mais résultat tronqué.
- Après, 200 phrases denses (7 tranches): entrée 7 x 1 730 = 12 000 jetons (0,0013) + sortie environ 60 x 130 = 7 800 jetons (0,0043) = **environ 0,006 €**. Le chevauchement ajoute 2 phrases sur 30 en entrée (+7 %).
- Pire cas (garde-fou de 27 appels pour 200 phrases, 42 au plus, tous pleins): 27 x (1 730 entrée + 5 200 sortie) = environ 0,10 €. Il faut des sorties systématiquement coupées pour l'atteindre; le plafond du scan max(0,25 €; 0,15 € x pages) est inchangé et vérifié à chaque appel par `invokeModel`.
- Moyenne: très en dessous de 0,12 € par page. Le coût de chaque appel est ajouté une seule fois par `callModel`; la reprise d'une étape (`clearDoc`, `addVerifyCostOnce`) n'est pas modifiée, et le test de rejeu confirme qu'aucune affirmation ne double.
- Non mesuré en réel: aucun appel à Claude (fausses réponses seulement).

## Vérification: règle des deux lectures et ancrage
Aucun changement dans `verify/` ni dans `anchorClaims` (extrait de 2 mots au moins présent dans la phrase). Les affirmations viennent du même prompt et sont ancrées par le même code; seul le plafond devient un paramètre (`max`, défaut `MAX_CLAIMS`).

## Message d'échec
`MSG.unreadable` n'indique plus de redécoupage: « Ce cours n'a pas pu être lu cette fois. Tes pages ne sont pas décomptées, tu peux réessayer ». `failJob` rend la réservation (ou les pages déjà consommées, comme la PR #62), une seule fois.

## Autres appels JSON
- Transcription: avant, plafond de 4 096 jetons pour une page seule et de 8 000 pour plusieurs, avec repli page par page. Après, 8 000 dans les deux cas (plafond seulement, seuls les jetons produits sont facturés). Pas de tranches: une page rend au plus 400 lignes.
- Génération (4 000) et contrôle des QCM (1 000): sorties bornées par 5 questions et 5 trous (environ 1 500 jetons au plus), et une sortie illisible publie déjà la fiche sans questions. Même défaut impossible, inchangés.
- Classement (1 500): section list bornée à 50 entrées, entrée limitée à 12 000 caractères. Inchangé.
- Vérification (`verify/run.ts`): hors périmètre (F11 ne touche pas verify).

## Tests (`api/src/pipeline/f11-extract.test.ts`, 9 tests; 7 échouent sans le correctif)
Section de 200 phrases avec sortie coupée en plein objet (couverture jusqu'à la fin, ordre, 45 à 60 affirmations, une par phrase, nombre d'appels borné), tranches chevauchantes (contexte envoyé, aucune affirmation en double), dédoublonnage, sortie illisible puis rejeu en deux moitiés (3 appels), échec persistant (message neutre, réservation rendue), coût sous le plafond et rejeu sans doublon, `sliceRanges`, `thinEvenly`, plafond d'`anchorClaims`. Test F8 du message mis à jour. `vitest` api + shared: 557 verts, `tsc` et `eslint` propres.

## Fichiers
`api/src/pipeline/steps-doc.ts`, `text.ts`, tests; deux retouches minimes hors liste: `prompts.ts` (`extractPrompt(numbered, max, context)`, défauts inchangés) et `steps.ts` (texte du message, plafond de transcription).

## Limites
- **Section d'une seule tranche (30 phrases ou moins): au plus 40 affirmations au lieu de 60 avant** (`SLICE_MAX_CLAIMS`, pour tenir sous `maxTokens`). Une section de 20 à 30 phrases très dense donne donc moins de fiches qu'avant.
- Une tranche de 4 phrases illisible deux fois est sautée si le reste a donné des affirmations (le contenu de ces phrases n'a alors pas d'affirmation).
- Moins d'affirmations par phrase dans une très grande section (60 au total, réparties): les plus importantes de chaque tranche.
- Pas de scan réel; non déployé. Budget de 0,50 € non utilisé.

## Relecture indépendante (PR #68)
C1 à C4 corrigés (voir 7 à 9 ci-dessus). Mutations M1 (filtre de propriété), M2 (garde-fou x 100), M4 (tri) et M5 (reprise gardant la phrase atteinte): détectées par les nouveaux tests (7 tests ajoutés ou renforcés dans `f11-extract.test.ts`), M3 et M6 l'étaient déjà. Le texte exact de `MSG.unreadable` est testé.
