# R1 : relecture en paragraphes, transcription et fiche structurées, schémas (issues #75, #76, #71)

Statut : conception, aucune ligne de code applicatif. Contrat additif `1.5.0` dans la même PR (`shared/contract/openapi.yaml`, fichiers générés, tests de contrat). Les textes de confidentialité sont dans un commit séparé à valider par le propriétaire ; `POLICY_VERSION` n'est pas relevé.

## 0. Résumé des décisions

| # | Sujet | Décision |
|---|---|---|
| D1 | Modèle de données | Les **phrases restent l'unité** (corrections, coupes, retraits, affirmations). Une couche de **blocs** (titre, paragraphe, liste, formule, figure) les regroupe dans l'ordre du document. |
| D2 | Figures | **Recadrage de l'image source** (JPEG 1200 px au plus) **et** description textuelle (`alt`) toujours présente. L'image est canonique, la description sert d'alternative et de repli. |
| D3 | Stockage des figures | Nouveau bucket S3 privé `figures`, clé `figures/<sid>/<coursId>/<figureId>.jpg`. Le recadrage temporaire vit dans le préfixe de la photo et part avec elle. |
| D4 | Conservation | Une figure suit **exactement la vie du cours** : conservée jusqu'à suppression du cours, de l'élève ou de la famille. Rien n'est gardé sans choix explicite de l'élève. Le parent ne reçoit jamais d'image. |
| D5 | Photo | Inchangé : supprimée à la confirmation. Seuls les recadrages que l'élève a gardés sont copiés avant la suppression. |
| D6 | Couleurs | **Deux couleurs pour deux moments.** Avant confirmation : confiance de **lecture** (sûr, douteux, corrigé, retiré). Après vérification, dans le cours et la fiche : résultat de **vérification** (vérifié, erreur, non vérifiable). Jamais le mot « vérifié » à l'écran de relecture. |
| D7 | Édition en place | Toucher une phrase la remplace par un champ de texte au même endroit. Les identifiants de phrase ne changent jamais, donc rien à recoller pour la vérification. Pas de fusion ni de découpe de phrases en v1. |
| D8 | Fiche | `Doc.body` (jusqu'à 8 paragraphes avec intertitre facultatif) et `Doc.recall` (rappel final de dates, formules, définitions, nombres). `summary` est conservé pour les clients 1.4. |
| D9 | Rappel final | Généré avec la fiche, mais **chaque nombre, date et formule est contrôlé par le code** contre le texte de l'affirmation citée. Une affirmation en erreur n'est jamais reprise. Une affirmation non vérifiable est reprise avec la mention « non vérifié ». |
| D10 | Coût | Environ +0,0002 € par page lue, +0,0003 € par fiche. Négligeable devant le plafond de 0,15 € par page, qui ne change pas. |
| D11 | Rognage | Fait par le serveur avec `sharp` (Lambda arm64) à partir d'un cadre normalisé donné par le modèle. |

## 1. Ce qui existe (main `3563d56`, contrat 1.4.0)

- `api/src/pipeline/steps.ts` : `readWindow` envoie 1 à 4 images à Haiku et reçoit `{"pages":[{"page","lines":[...],"suite"}]}`. `assemblePages` (`text.ts`) découpe en phrases, recolle les phrases coupées par un saut de page et donne `p<page>-s<n>`.
- Un appel de classement unique donne type, matière, sujet et sections suggérées. Les phrases sont écrites en `JOB#<id>/TEXT#<page>` (TTL 7 jours).
- `web/src/screens/confirm/ConfirmView.tsx` : une carte par phrase, correction par `textarea` (`AutoGrow`), coupes en sections (`sections.ts`), sauvegarde de la saisie dans `sessionStorage` (`storage.ts`), zoom photo (`PhotoViewer`).
- À la confirmation, le cours corrigé est écrit (`COURS#<id>`, `COURS#<id>#T<nn>`), la photo est supprimée, puis `extract` tire des affirmations par phrase (`phraseId`, `extrait`) et `verify-run` les vérifie. La fiche a un `resume` d'un seul bloc (3 à 6 phrases) et des QCM.
- `Claim` n'expose pas la phrase d'origine alors que `CLAIM#` la porte (`origine.phrase_id`).
- `ConfirmRequest.removed` (retrait de phrases) a été demandé à la relecture de la PR #40 mais n'existe ni dans le contrat ni dans le code de main. Il est défini ici (§7) parce que la vue en paragraphes ne peut pas se concevoir sans lui.

## 2. Modèle de données : des blocs au-dessus des phrases

### 2.1 Pourquoi pas un modèle « document riche »

Tout le pipeline après la relecture (extraction, ancrage des affirmations par `phraseId`, sections par `fromSentenceId`, F11 par tranches de phrases, fusion des doublons par empreinte) repose sur des phrases numérotées. Remplacer cette unité par un arbre de blocs ou du Markdown libre obligerait à réécrire l'ancrage et les coupes, pour un bénéfice purement visuel. On ajoute donc une couche, on ne remplace rien.

### 2.2 Bloc

```
Block { id: "b<n>", kind: titre|paragraphe|liste|formule|figure,
        level?: 1..3 (titre), ordered?: bool (liste),
        sentenceIds?: ["p1-s1", ...], figureId?: "f<n>" }
```

- `titre` : une phrase. `liste` : une phrase par élément. `formule` : une phrase en texte brut (pas de LaTeX en v1 : `E = mc²`). `paragraphe` : une ou plusieurs phrases. `figure` : aucune phrase.
- Chaque phrase appartient à **exactement un** bloc. Un bloc peut s'étendre sur deux pages : si `assemblePages` recolle une phrase, le premier bloc de la page suivante est ajouté au paragraphe précédent.
- La liste ordonnée des blocs est portée au niveau du document (`Transcription.blocks`, `Cours.blocks`), pas par page : le scan est lu comme un seul document depuis la PR #40.

### 2.3 Sortie du modèle : un Markdown restreint, pas du JSON imbriqué

Un JSON d'objets typés coûte des jetons par bloc et casse facilement à la troncature (le dépôt a déjà `salvageTruncatedList`). Le prompt de lecture demande par page :

```
{"pages":[{"page":1,"suite":false,
  "md":"# Titre\n\nPremière phrase. ~Phrase douteuse.\n\n- élément\n- élément\n\n= E = mc²\n\n[[f1]]",
  "figures":[{"id":"f1","box":[0.1,0.4,0.8,0.35],"kind":"schema","alt":"...","legende":"Fig. 1 ..."}]}]}
```

Marqueurs : `#`, `##`, `###` (titre), `- ` (puce), `1. ` (liste numérotée), `= ` (formule), ligne vide (nouveau paragraphe), `~` en début de ligne (lecture douteuse), `[[f<n>]]` (position d'une figure). Le code reste maître : une fonction pure `parseBlocks(md, figures)` produit lignes, blocs et figures, puis réutilise `assemblePages` pour le recollage. Si le Markdown est vide ou illisible, repli sur l'ancien format `lines` (une ligne = un paragraphe d'une phrase) : l'élève voit l'ancienne liste, rien n'échoue.

Contrôles du code (jamais fiés au modèle) : `box` dans [0,1] et surface entre 3 % et 90 % de la page, 8 figures au plus par scan, `[[f<n>]]` sans figure déclarée ignoré, figure déclarée sans marqueur ajoutée en fin de page, `alt` nettoyé comme `title` (chevrons, caractères invisibles), noms de personnes déjà remplacés par `[nom]` par la consigne existante.

### 2.4 Stockage DynamoDB

| Élément | Clé | Contenu | Durée |
|---|---|---|---|
| Blocs d'un job | `JOB#<jobId>` / `BLOCKS` | `blocks[]`, métadonnées des figures (sans URL) | TTL 7 jours, comme `TEXT#` |
| Blocs du cours | `STUDENT#<sid>` / `COURS#<coursId>#B` | `blocks[]`, `figures[]` (`figureId`, `page`, `kind`, `alt`, `caption`) | Vie du cours |

Taille : 400 blocs au plus à environ 100 octets, soit moins de 40 Ko (limite de 400 Ko). Un seul écrivain par type (lot API). `deleteCoursTree` supprime déjà `COURS#<id>#T` ; il doit supprimer aussi `COURS#<id>#B` (le test existant compte les éléments avant et après). Le drapeau `doubt` n'est **pas** conservé dans le cours : il n'a de sens qu'avant la confirmation.

Un cours ancien n'a pas de `COURS#<id>#B` : l'API ne renvoie ni `blocks` ni `figures`, l'écran affiche les phrases comme aujourd'hui.

## 3. Figures (#71)

### 3.1 Recadrage ou description : les deux, avec un rôle chacun

| | Recadrage de l'image source | Description générée seule |
|---|---|---|
| Fidélité | Exacte (le schéma de l'enseignant) | Perd les légendes, les flèches, les proportions |
| Utilité pour réviser | Haute : l'élève revoit son schéma | Faible |
| Risque d'erreur du modèle | Cadre faux (mesurable, visible, corrigeable) | Description fausse, **invisible** et présentée comme un fait |
| Donnée de mineur | Oui, image | Non |
| Accessibilité | Nécessite un texte alternatif | Native |

Décision : l'image recadrée est la figure ; la description courte (`alt`, 300 caractères) est toujours produite dans le même appel, sert de texte alternatif et **remplace l'image si le recadrage échoue** (cadre invalide, image illisible, élève ayant refusé l'image mais gardé la place). Une description n'est jamais présentée comme un fait vérifié : elle n'entre ni dans les affirmations, ni dans la vérification, ni dans les questions. L'élève peut la corriger (`ConfirmFigure.alt`).

Les questions « légender un schéma » (#43) sont hors périmètre ; la structure (`figureId` stable, `alt`, `caption`) les rend possibles plus tard sans changer le contrat.

### 3.2 Cycle de vie

1. **Lecture** (`transcribe`) : le modèle donne un cadre normalisé. Le code lit l'image de la page, ajoute 4 % de marge, rogne avec `sharp`, ré-encode en JPEG qualité 80 sur 1200 px au plus (cela retire les métadonnées EXIF, dont la position GPS), et écrit `scans/<sid>/<jobId>/fig/<figureId>.jpg` dans le **bucket des scans**. Ce préfixe est supprimé avec la photo (`s3.deleteAll(scansPrefix)` existant) et par la règle de cycle de vie de 1 jour.
2. **Relecture** : `GET /jobs/{id}/transcription` renvoie les figures avec une URL pré-signée de 5 minutes. L'élève garde ou retire chacune et peut corriger le texte alternatif.
3. **Confirmation** : dans l'étape qui écrit le cours, les figures gardées sont copiées (`CopyObject`) vers `figures/<sid>/<coursId>/<figureId>.jpg` du bucket `figures`, **avant** la suppression de la photo, puis `COURS#<id>#B` est écrit. L'opération est idempotente (même clé de destination). Une figure absente de `ConfirmRequest.figures` n'est pas conservée : le défaut protège la donnée.
4. **Lecture du cours et de la fiche** : URL pré-signée de 5 minutes, élève seulement.
5. **Suppression** : `DELETE /cours/{id}` supprime le préfixe `figures/<sid>/<coursId>/` ; suppression d'un élève : préfixe `figures/<sid>/` ; suppression de famille : préfixe de chaque élève (même mécanisme que pour Cognito et les photos : le handler, pas `TreeDb`, parle à S3). `failJob` supprime aussi le préfixe du cours en cas d'échec.

Si l'élève supprime le cours en gardant les fiches (`fiches=garder`), les figures partent avec le cours : la fiche perd ses images (elle garde son texte). Raison : une seule durée de vie pour une image, pas de copie orpheline.

### 3.3 Confidentialité d'un mineur

- Une figure est un extrait d'une page de cours, donc une donnée d'élève, au même titre que le texte du cours (T3). Elle peut contenir par accident une écriture manuscrite, un nom, un visage (portrait d'une personne publique dans une leçon d'histoire).
- Mesures : (1) choix explicite et par figure, rien de gardé par défaut ; (2) aucune figure suggérée si la zone est surtout de l'écriture manuscrite ou un portrait de personne non publique (consigne de prompt, mesurée sur le jeu d'essai) ; (3) suppression des métadonnées, taille réduite ; (4) bucket privé, chiffré, TLS exigé, accès public bloqué, accès uniquement par URL pré-signée de 5 minutes après contrôle d'appartenance ; (5) jamais dans les journaux, l'export parent, ni l'état Step Functions ; (6) 8 figures et environ 300 Ko chacune au plus par scan.
- Le parent ne lit pas le texte du cours : il ne lit pas non plus ses figures (`CoursMeta` n'a que `figureCount`). Même règle, sans exception.
- Conséquences juridiques : durée, finalité et destinataires sont ajoutés au registre (T3) et à la politique, et un risque est ajouté à l'AIPD. Les textes sont dans le commit séparé (§11).

### 3.4 Rognage : `sharp` côté serveur

Le dépôt n'a aucune bibliothèque d'image. Choix : `sharp` (binaire natif arm64, Lambda `transcribe` à 1024 Mo). Alternative écartée : recadrer dans le navigateur et téléverser l'image. Elle évite le binaire natif, mais ouvre à un compte d'élève une écriture de fichier arbitraire dans un bucket conservé (validation du type, de la taille et du contenu à refaire côté serveur) et dépend d'un appareil qui n'est pas fiable. Point à confirmer : P7.

### 3.5 Risque non mesuré

La précision des cadres de Haiku n'est pas mesurée. Le lot API commence par une mesure sur 10 pages avec schémas (cadre jugé correct si le recouvrement est d'au moins 0,6 avec un cadre tracé à la main). En dessous de 70 % de cadres corrects, les figures passent en « description seule » pour l'élève, avec un second appel de recadrage par un modèle plus grand seulement si le propriétaire l'accepte (P8).

## 4. Sens des couleurs (#75)

La vérification des sources a lieu **après** la confirmation du texte (`confirm` → `extract` → `verify-run`). À l'écran de relecture, aucun verdict n'existe encore. Une couleur « vérifié / non vérifié » à cet endroit ne pourrait donc être que la confiance de lecture. L'afficher sous ce nom induirait en erreur l'élève, qui croirait qu'un passage vert est exact.

Décision : les deux, à deux moments, avec deux vocabulaires et deux palettes qui ne se ressemblent pas.

### 4.1 Avant confirmation : confiance de lecture (option A)

| État | Marque | Signal non coloré |
|---|---|---|
| Sûr | Texte normal | Aucun |
| Douteux (`Sentence.doubt`) | Fond ambre | Icône « ? » et texte « Lecture douteuse » (lecteur d'écran et légende) |
| Corrigé par l'élève | Soulignement bleu | Icône crayon, « Corrigé » |
| Retiré | Barré, fond gris | Icône croix, « Retiré » |

- Le modèle marque une ligne douteuse avec `~`. Le code transmet `doubt: true` sur les phrases concernées.
- Garde-fou : si plus de 40 % des phrases sont marquées, le code supprime tous les marquages (un signal qui s'allume partout n'informe pas) et l'écran affiche un message « La photo est difficile à lire, relis tout ». Le seuil est à confirmer sur le jeu d'essai.
- L'élève peut valider un passage douteux (« C'est bon »), ce qui l'éteint pour la session (état local, `sessionStorage`).
- Aucun mot « vérifié » sur cet écran. Le résumé du haut dit : « 3 passages douteux à relire ».

### 4.2 Après vérification : résultat des sources (option B), dans le cours et la fiche

- `Cours.marks` : un état par phrase, calculé à la lecture depuis les fiches liées (12 requêtes DynamoDB au plus pour 6 sections, écran peu fréquenté ; pas de nouvel écrivain). Statut le plus sévère par phrase : `erreur` > `non_verifiable` > `verifiee`. Une phrase sans affirmation factuelle n'a pas de marque.
- Sens : vert avec ✓ « Vérifié », rouge avec ✗ « Erreur trouvée », gris avec « ? » « Non vérifiable ». Pas de marque pour les consignes et les méthodes.
- `Claim.sentenceId` relie une affirmation de la fiche à sa phrase : un appui sur une marque ouvre l'affirmation (sources déjà affichées par la fiche).
- Interrupteur « Montrer la vérification » dans le cours, activé par défaut.
- Contraste : tous les couples texte/fond sont à au moins 4,5:1 ; la couleur n'est jamais le seul signal (icône, libellé, infobulle tactile).
- Palette claire, vive, enfantine, conforme à la préférence du projet (pas de thème sombre).

## 5. Édition en place (#75)

- La vue est un document : titres, paragraphes, listes, formules, figures. Chaque phrase est un élément cliquable à l'intérieur de son bloc. Toucher une phrase la remplace, **au même endroit**, par un champ de texte (`AutoGrow`, un composant existant) ; Entrée ou la perte du focus valide, Échap annule.
- Choix du champ de texte plutôt que `contenteditable` : le curseur, la composition de texte (clavier mobile, IME) et le collage sont fiables sur téléphone ; `contenteditable` ne l'est pas, et sa valeur « plaintext-only » n'existe pas partout.
- Les identifiants de phrase sont **stables** : une correction remplace le texte d'une phrase, jamais sa place. Rien ne change pour `ConfirmRequest.corrections`, et pour la vérification qui part ensuite du texte corrigé.
- Pas de fusion ni de découpe de phrases en v1. Taper plusieurs phrases dans un champ est permis (2000 caractères au plus) : elles forment une phrase pour la suite. Un ajout de phrase manquante : hors périmètre (P5).
- Sauvegarde au rechargement : `sessionStorage` comme aujourd'hui, avec deux clés de plus (phrases retirées, choix de figures). Le texte du cours n'est toujours ni dans `localStorage` ni dans le service worker.
- Zoom de la photo, panneau repliable sur mobile et sections : conservés. La photo est affichée à côté du document, avec la figure proposée mise en évidence.

## 6. Impact de l'édition sur la vérification

Aucun changement de procédure. La vérification porte sur le texte **après** correction, par phrase. Conséquence voulue : si un élève « corrige » une phrase correcte en phrase fausse, la vérification peut la marquer en erreur, ce qui est son rôle. Une phrase corrigée perd son drapeau « douteux » (l'élève l'a regardée). Le cours n'est **pas** éditable après confirmation en v1 : le modifier obligerait à refaire l'extraction et la vérification d'une fiche déjà créée, ce qui coûte un second plafond de job et crée des affirmations orphelines (P6).

## 7. Compatibilité avec les sections par sujet et le retrait de phrases

- **Sections** : une section commence à une phrase (`fromSentenceId`) ; les blocs n'y changent rien. L'écran propose les coupes **entre deux blocs** (« Couper avant ce titre / ce paragraphe ») et les permet à l'intérieur d'un paragraphe (une ligne de coupe visible entre deux phrases). Un paragraphe coupé en deux appartient aux deux fiches pour la partie de chacune. Les règles existantes (6 sections au plus, 2 par page, 40 mots au total, première section au début) sont inchangées.
- **Retrait de phrases** (`ConfirmRequest.removed`, nouveau) : liste d'identifiants de phrases retirées. Elles ne sont pas conservées dans le cours, pas extraites, pas vérifiées. Effets sur les blocs : un bloc sans phrase restante disparaît ; une phrase retirée ne peut pas être un `fromSentenceId` ; le seuil de 40 mots s'applique après retrait ; une phrase inconnue donne 400. Les identifiants ne sont pas renumérotés (les trous sont permis), ce qui garde les corrections et les coupes de la même requête cohérentes.
- **Figures et sections** : une figure appartient au bloc `figure` et au cours, pas à une section. Elle est rattachée à la section qui contient le bloc précédent. La fiche peut référencer les figures de sa section.
- **Phrases à cheval sur deux pages** (`Sentence.pages`) : inchangé ; le bloc prend la page de la première phrase.

## 8. Transcription et fiche

### 8.1 Transcription (#76)

La sortie de lecture devient `Transcription.pages` (phrases, inchangé) + `blocks` + `figures` + `doubt`. Le cours conservé garde `texts` (phrases) + `blocks` + `figures`. Le type de document, la matière, le sujet et les sections suggérées viennent du même appel de classement ; ses lignes d'entrée portent un préfixe de bloc (`[p1-s1] # `) pour qu'il voie les titres, sans changer sa sortie.

### 8.2 Fiche en plusieurs paragraphes avec rappel (#76)

Le prompt `generatePrompt` demande, en plus de ce qu'il produit aujourd'hui :

```
"fiche": {"paragraphes":[{"titre":"...","texte":"...","claimIds":["01","02"]}],
          "rappel":[{"type":"date|formule|definition|nombre","texte":"...","claimId":"03"}]}
```

Règles de code, vérifiées après l'appel (`validFiche`, fonction pure testée comme `validQcm`) :

1. 6 paragraphes au plus, 150 mots au plus chacun, 350 au total ; chaque `claimId` cité existe parmi les affirmations de la fiche.
2. Un élément de rappel doit citer une affirmation existante qui n'est ni en `erreur` ni `non_factuelle`.
3. **Chaque nombre, date et expression de formule du texte du rappel doit figurer dans le texte de l'affirmation citée** (comparaison après `normalize`, chiffres comparés tels quels). Un élément qui ne passe pas est supprimé, jamais corrigé. Un rappel de type `formule` doit contenir `=`.
4. `verified` vaut vrai si l'affirmation est `verifiee`, faux si elle est `non_verifiable` (l'élément est repris du cours et affiché avec la mention « non vérifié »). Cela suit la règle actuelle : une affirmation non vérifiée sert au résumé, jamais aux questions.
5. Si la sortie est illisible ou ne passe pas, repli sur le `resume` actuel (un paragraphe, pas de rappel). Aucune fiche n'échoue pour cela.

`Doc.summary` reste rempli (paragraphes joints par une ligne vide, sans le rappel) pour les clients 1.4. Les QCM, les trous et leur contrôle de résolution sont inchangés et ne lisent jamais le rappel ni les descriptions de figures.

Pourquoi un contrôle de code plutôt que de faire confiance au modèle : une date ou une formule fausse dans un rappel est l'erreur la plus nuisible d'une fiche, parce que le rappel est la partie qu'un élève retient. Le contrôle est peu coûteux et vérifie ce qui compte.

## 9. Coût Claude par page

Tarifs du dépôt (`shared/pricing.ts`) : Haiku 0,11 USD par million de jetons d'entrée, 0,55 en sortie, 1 USD = 0,912 € (`USD_PER_EUR` 1,0963). Les volumes ci-dessous sont des **estimations** (non mesurées) pour une page de cours dense : image environ 1 600 jetons, 450 mots, soit 700 jetons de texte.

| Étape | Aujourd'hui | Avec R1 | Écart |
|---|---|---|---|
| Lecture d'une page : entrée | 1 600 + 250 de consigne | 1 600 + 550 de consigne | +300 jetons |
| Lecture d'une page : sortie | 700 | 700 + 150 (marqueurs Markdown) + 100 (2 figures) | +250 jetons |
| Lecture : coût | environ 0,00054 € | environ 0,00074 € | +0,0002 € |
| Classement (1 par scan) | 1 500 max | entrée +50 jetons | négligeable |
| Génération de la fiche (1 par fiche) | environ 1 500 sortie | +600 sortie (paragraphes, rappel) | +0,0003 € |
| Rognage `sharp` | n/a | CPU Lambda, 100 ms par figure | pas de jetons |

Total pour un scan de 3 pages en 2 fiches : environ +0,0012 €. Le plafond de job `max(0,25 ; 0,15 × pages)` et la part de génération réservée (`GEN_RESERVE_CENTS`, 6 centimes) ne changent pas. Le risque est ailleurs : la **troncature de sortie**. Une page très dense à 4 pages par appel approche `maxTokens: 8000`. Mesures proposées : garder le repli page par page existant, et réduire `SINGLE_CALL_PAGES` de 4 à 3 si la mesure sur 30 pages vraies montre plus de 10 % de replis (P9). Le bucket `figures` coûte moins de 0,001 €/mois pour une famille (8 figures × 300 Ko × quelques dizaines de cours).

## 10. Contrat 1.5.0 (additif, dans cette PR)

Rien de requis n'est ajouté à une requête ; un client 1.4 reste valide.

| Schéma | Ajout |
|---|---|
| `Sentence` | `doubt` (réponse seulement) |
| `Transcription` | `blocks`, `figures` |
| `ConfirmRequest` | `figures` (`ConfirmFigure`: `figureId`, `keep`, `alt`), `removed` |
| `Cours` | `blocks`, `figures`, `marks` (`SentenceMark`) |
| `CoursMeta` (export) | `figureCount` |
| `Claim` | `sentenceId` |
| `Doc` | `body` (`FicheParagraph`), `recall` (`RecallItem`), `figures` |
| Nouveaux | `Block`, `Figure`, `FigureBox`, `ConfirmFigure`, `SentenceMark`, `FicheParagraph`, `RecallItem` |

Aucune route nouvelle : les URL des figures sont pré-signées dans les réponses existantes (même mécanisme que `photoUrls`). Erreurs : `figureId` inconnu ou `removed` invalide donne 400 `requete_invalide` ; état inchangé.

## 11. Confidentialité (commit séparé)

Le commit « docs(legal): R1 » modifie `docs/legal/registre.md` (T3), `politique-confidentialite.md`, `aipd-brouillon.md` et `sous-traitants.md` (aucune nouveauté : AWS déjà sous-traitant). Il ne touche pas `shared/policy.ts` : `POLICY_VERSION` reste `2026-11-26`. **Les textes sont à valider par le propriétaire** ; une modification de la durée ou de la nature d'une donnée conservée est une information nouvelle pour les familles, donc le relèvement de `POLICY_VERSION` (et le nouveau consentement qui en découle) sera décidé par le propriétaire à la mise en production du lot, pas avant (P10).

## 12. Découpage en lots et fichiers propres

Un seul propriétaire par fichier. Les lots A et C peuvent avancer en parallèle dès que le contrat 1.5.0 est fusionné (le lot C travaille contre `npm run mock`, dont les exemples couvrent les nouveaux champs).

### Lot R1-A : API et pipeline

- `api/src/pipeline/blocks.ts` (nouveau : `parseBlocks`, `validFiche`, validations de cadres) et son test
- `api/src/pipeline/prompts.ts`, `steps.ts` (`readWindow`, `transcribe`), `steps-doc.ts` (`generate`, étape qui écrit le cours), `text.ts` (recollage de blocs), `ports.ts` (port d'image `crop`)
- `api/src/pipeline/figures.ts` (nouveau : rognage, copie vers `figures`)
- `api/src/handlers/` : `jobs-transcription`, `jobs-confirm` (figures, removed), `cours-api` (blocks, figures, marks), `docs-read` (body, recall, figures, `Claim.sentenceId`), suppression d'élève et de famille (préfixe `figures/`)
- `api/src/cours/*`
- `shared/ddb/keys.ts`, `shared/items.ts`, `shared/delete-tree.ts` (+ test de comptage), `docs/data-model.md` (propriétaire : L1c)
- `golden/` et `eval/` : jeu d'essai de 10 pages avec schémas, mesure de cadres et de marquages douteux
- Test de contrat : exemples valides, 400 sur `figureId` inconnu, `removed` retiré en début de section

### Lot R1-B : infra

- `infra/lib/data-stack.ts` : bucket `figures` (chiffré, TLS, accès public bloqué, CORS non nécessaire, pas de cycle de vie par âge), paramètre SSM
- `infra/lib/pipeline-stack.ts` : `sharp` (bundling arm64, `externalModules`), mémoire de `transcribe` (1024 Mo), droits S3 sur `figures`
- `infra/lib/api-stack.ts` : droits de lecture/suppression de `figures` pour `cours-api`, `docs-read`, suppression d'élève et de famille ; droits de signature
- `infra/test/*` : tests de synthèse (bucket privé, chiffrement, aucun droit hors préfixe, aucun droit pour le rôle d'export parent)
- Estimation de coût avant déploiement, à valider par le propriétaire ; toutes les ressources taguées `Project`, `Environment`, `ManagedBy`, `Owner`

### Lot R1-C : site

- `web/src/screens/confirm/` : `ConfirmView.tsx` (vue document), nouveau `DocView.tsx` (blocs et phrases), `FigureCard.tsx`, `sections.ts` (coupes entre blocs), `storage.ts` (retraits, figures), `confirm.css`, tests
- `web/src/screens/Cours.tsx` (blocs, figures, marques de vérification, interrupteur), `web/src/screens/Doc.tsx` (paragraphes, rappel, figures)
- `web/src/api.ts`, `web/src/types.ts`, `web/src/labels.ts`
- `e2e/` : parcours relecture (douteux, correction en place, retrait, figure gardée et refusée), captures PC et mobile

### Lot R1-D : textes légaux (après validation)

- `docs/legal/*` ; `shared/policy.ts` seulement sur décision du propriétaire (P10)

### Ordre

1. PR de conception (celle-ci), puis fusion du contrat 1.5.0.
2. R1-A et R1-C en parallèle ; R1-B avant le premier déploiement dev de R1-A.
3. Mesure sur le jeu d'essai (cadres, marquages douteux, taux de troncature) **avant** d'ouvrir le lot en production.

## 13. Points à trancher (défaut proposé)

| # | Question | Défaut |
|---|---|---|
| P1 | Valider les textes de confidentialité du commit séparé | À relire par le propriétaire (aucune mise en ligne avant) |
| P2 | Durée des figures | Vie du cours (jusqu'à suppression du cours, de l'élève ou de la famille), pas de durée automatique |
| P3 | Figures gardées par défaut ? | **Non** : choix explicite par figure |
| P4 | Fiche gardée après suppression du cours : garde-t-elle ses images ? | Non, les figures partent avec le cours |
| P5 | Ajout d'une phrase oubliée à la relecture | Hors v1 (corriger une phrase, pas en ajouter) |
| P6 | Édition du cours après confirmation | Hors v1 (supprimer et rescanner) |
| P7 | Rognage serveur (`sharp`) ou dans le navigateur | Serveur, avec `sharp` |
| P8 | Si moins de 70 % des cadres sont corrects à la mesure | Description seule (sans image) ; second appel avec un modèle plus grand seulement sur accord du propriétaire |
| P9 | `SINGLE_CALL_PAGES` 4 ou 3 | Rester à 4, passer à 3 si plus de 10 % de replis à la mesure |
| P10 | Relever `POLICY_VERSION` pour R1 | Oui à la mise en production du lot (nouvelle donnée conservée), pas dans cette PR |
| P11 | Seuil de 40 % de phrases douteuses | 40 %, à ajuster à la mesure |
| P12 | `ConfirmRequest.removed` défini ici | Oui, dans le contrat 1.5.0 (absent de main) |
| P13 | Formules : texte brut ou LaTeX | Texte brut (`E = mc²`) en v1 |
| P14 | Export de la famille : figures de l'élève dans l'archive | Non en v1 (`figureCount` seulement) ; l'élève peut les voir dans son cours |

## 14. Ce qui n'a pas été mesuré

- Précision des cadres de figures de Haiku, taux de lecture douteuse bien calibré, taille réelle des sorties Markdown : tout est estimé. Aucun appel de modèle n'a été fait pour cette conception.
- Le coût du rognage et la taille du paquet `sharp` dans le bundle des Lambda ne sont pas mesurés.
- Les textes légaux sont des brouillons non relus par un juriste.
