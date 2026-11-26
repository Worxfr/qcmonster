# R1 : relecture en paragraphes, transcription et fiche structurées, schémas (issues #75, #76, #71)

Statut : conception, aucune ligne de code applicatif. Contrat additif `1.5.0` dans la même PR (`shared/contract/openapi.yaml`, fichiers générés, tests de contrat). Les textes de confidentialité sont dans un commit séparé à valider par le propriétaire ; `POLICY_VERSION` n'est pas relevé.

## 0. Résumé des décisions

| # | Sujet | Décision |
|---|---|---|
| D1 | Modèle de données | Les **phrases restent l'unité** (corrections, coupes, retraits, affirmations). Une couche de **blocs** (titre, paragraphe, liste, formule, figure) les regroupe dans l'ordre du document. |
| D2 | Figures | **Recadrage de l'image source** (JPEG 1200 px au plus) **et** description textuelle (`alt`) toujours présente. **La figure reste une image** (décision du propriétaire, P7) : la description est un texte alternatif pour l'accessibilité, jamais un substitut. |
| D3 | Stockage des figures | Nouveau bucket S3 privé `figures`, clé `figures/<sid>/<coursId>/<figureId>.jpg`. Le recadrage temporaire vit dans le préfixe de la photo et part avec elle. |
| D4 | Conservation | Une figure suit **exactement la vie du cours** : conservée jusqu'à suppression du cours, de l'élève ou de la famille. Rien n'est gardé sans choix explicite de l'élève. Le parent ne reçoit jamais d'image. |
| D5 | Photo | Inchangé : supprimée à la confirmation. Seuls les recadrages que l'élève a gardés sont copiés avant la suppression. |
| D6 | Couleurs | **Deux couleurs pour deux moments.** Avant confirmation : confiance de **lecture** (sûr, douteux, corrigé, retiré). Après vérification, dans le cours et la fiche : résultat de **vérification** (vérifié, erreur, non vérifiable). Jamais le mot « vérifié » à l'écran de relecture. |
| D7 | Édition en place | Toucher une phrase la remplace par un champ de texte au même endroit. Les identifiants de phrase ne changent jamais, donc rien à recoller pour la vérification. Pas de fusion ni de découpe de phrases en v1. |
| D8 | Fiche | `Doc.body` (jusqu'à 8 paragraphes avec intertitre facultatif) et `Doc.recall` (rappel final de dates, formules, définitions, nombres). `summary` est conservé pour les clients 1.4. |
| D9 | Rappel final | Le modèle ne choisit que `claimId` et `kind` ; **le code copie le texte de l'affirmation citée** dans le rappel. Une affirmation en erreur n'est jamais reprise. Une affirmation non vérifiable est reprise avec la mention « non vérifié ». |
| D10 | Coût | Environ +0,0002 € par page lue, +0,0003 € par fiche. Négligeable devant le plafond de 0,15 € par page, qui ne change pas. |
| D11 | Rognage | Fait par le serveur avec `sharp`, en **couche Lambda arm64 réservée à `transcribe`** (jamais dans le paquet commun), à partir d'un cadre normalisé donné par le modèle. Si le cadre est faux : second essai par un modèle plus gros, puis page entière. Si `sharp` est indisponible : le scan est réessayé puis échoue (quota rendu), jamais de figure « texte seul ». |
| D12 | Identifiants | Blocs et figures sont renumérotés avec un décalage à l'écriture dans le cours : uniques à l'échelle du cours, compatibles avec l'ajout de pages (F10). |
| D13 | Formules | **LaTeX** (`$…$` dans le texte, source sans délimiteur dans un bloc `formule`), validé par le serveur et affiché en MathML par KaTeX avec `trust: false` ; jamais de HTML injecté sans passer par KaTeX (§2.7). |
| D14 | Export | L'export de l'**élève** (nouvelle route `POST /me/export/archive`) contient tout, figures comprises. L'export du **parent** garde la règle validée : aucun contenu de cours (point ouvert P16). |

## 1. Ce qui existe (main `781e9c2`, contrat 1.4.1)

- `api/src/pipeline/steps.ts` : `readWindow` envoie 1 à 4 images à Haiku et reçoit `{"pages":[{"page","lines":[...],"suite"}]}`. `assemblePages` (`text.ts`) découpe en phrases, recolle les phrases coupées par un saut de page et donne `p<page>-s<n>`.
- Un appel de classement unique donne type, matière, sujet et sections suggérées. Les phrases sont écrites en `JOB#<id>/TEXT#<page>` (TTL 7 jours).
- `web/src/screens/confirm/ConfirmView.tsx` : une carte par phrase, correction par `textarea` (`AutoGrow`), coupes en sections (`sections.ts`), sauvegarde de la saisie dans `sessionStorage` (`storage.ts`), zoom photo (`PhotoViewer`).
- À la confirmation, le cours corrigé est écrit (`COURS#<id>`, `COURS#<id>#T<nn>`), la photo est supprimée, puis `extract` tire des affirmations par phrase (`phraseId`, `extrait`) et `verify-run` les vérifie. La fiche a un `resume` d'un seul bloc (3 à 6 phrases) et des QCM.
- `Claim` n'expose pas la phrase d'origine alors que `CLAIM#` la porte (`origine.phraseId`, `shared/items.ts`).
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

- `titre` : une phrase. `liste` : une phrase par élément. `formule` : une phrase dont le texte est du **LaTeX sans délimiteurs** (`E = mc^{2}`, §2.7). `paragraphe` : une ou plusieurs phrases. `figure` : aucune phrase.
- Chaque phrase appartient à **exactement un** bloc. Un bloc peut s'étendre sur deux pages : si `assemblePages` recolle une phrase, le premier bloc de la page suivante est ajouté au paragraphe précédent.
- La liste ordonnée des blocs est portée au niveau du document (`Transcription.blocks`, `Cours.blocks`), pas par page : le scan est lu comme un seul document depuis la PR #40.

### 2.3 Sortie du modèle : un Markdown restreint, pas du JSON imbriqué

Un JSON d'objets typés coûte des jetons par bloc et casse facilement à la troncature (le dépôt a déjà `salvageTruncatedList`). Le prompt de lecture demande par page :

```
{"pages":[{"page":1,"suite":false,
  "md":"# Titre\n\nPremière phrase. ~Phrase douteuse.\n\n- élément\n- élément\n\n= E = mc²\n\n[[f1]]",
  "figures":[{"id":"f1","box":[0.1,0.4,0.8,0.35],"kind":"schema","alt":"...","caption":"Fig. 1 ..."}]}]}
```

Marqueurs : `#`, `##`, `###` (titre), `- ` (puce), `1. ` (liste numérotée), `= ` (formule en LaTeX), ligne vide (nouveau paragraphe), `~` en début de ligne (lecture douteuse), `[[f<n>]]` (position d'une figure). Le code reste maître : une fonction pure `parseBlocks(md, figures)` produit lignes, blocs et figures, puis réutilise `assemblePages` pour le recollage. Si le Markdown est vide ou illisible, repli sur l'ancien format `lines` (une ligne = un paragraphe d'une phrase) : l'élève voit l'ancienne liste, rien n'échoue.

Les noms du prompt sont ceux du contrat (`kind`, `alt`, `caption`, `box`) ; le code fait la correspondance avec les champs du contrat sans traduction (`Figure.figureId` = `id` du modèle, préfixé §2.5).

Contrôles du code (jamais fiés au modèle) : `box` dans [0,1] et surface entre 3 % et 90 % de la page, 8 figures au plus par scan, `[[f<n>]]` sans figure déclarée ignoré, figure déclarée sans marqueur ajoutée en fin de page, `alt` nettoyé comme `title` (chevrons, caractères invisibles), noms de personnes déjà remplacés par `[nom]` par la consigne existante.

### 2.4 Stockage DynamoDB

| Élément | Clé | Contenu | Durée |
|---|---|---|---|
| Blocs d'un job | `JOB#<jobId>` / `BLOCKS` | `blocks[]`, métadonnées des figures (sans URL) | TTL 7 jours, comme `TEXT#` |
| Blocs du cours | `STUDENT#<sid>` / `COURS#<coursId>#B` | `blocks[]`, `figures[]` (`figureId`, `page`, `kind`, `alt`, `caption`) | Vie du cours |

Aucun nettoyage par TTL seul : `JOB#<id>/BLOCKS` est supprimé **explicitement** partout où `JOB#<id>/TEXT#` l'est aujourd'hui (`api/src/scans/delete.ts`, `api/src/cours/cours.ts` fonction `del`, et `failJob`/`purgeScan` de `job.ts`), avec un test qui compte les éléments avant et après.

Taille : 400 blocs au plus à environ 100 octets, soit moins de 40 Ko (limite de 400 Ko). Un seul écrivain par type (lot API). `deleteCoursTree` supprime déjà `COURS#<id>#T` ; il doit supprimer aussi `COURS#<id>#B` (le test existant compte les éléments avant et après). Le drapeau `doubt` n'est **pas** conservé dans le cours : il n'a de sens qu'avant la confirmation.

### 2.5 Bornes du contrat et repli

Le contrat plafonne `blocks` à 400, `Block.sentenceIds` à 200, `figures` à 8, `removed` et `marks` à 500. Or `ReadOut` accepte 400 lignes par page sur 10 pages. Le code applique ces règles **avant** d'écrire, sans jamais faire échouer le scan :

1. Plus de 8 figures : on garde les 8 premières dans l'ordre du document, les autres sont ignorées (leur place reste un paragraphe vide, supprimé).
2. Plus de 200 phrases dans un paragraphe : le paragraphe est coupé en blocs consécutifs de 200 phrases au plus.
3. Plus de 400 blocs : **pas de couche de blocs** pour ce scan (`blocks` absent, l'écran affiche la liste de phrases comme aujourd'hui). Les phrases, elles, ne sont jamais tronquées.
4. `Cours.marks` : 500 marques au plus, les affirmations `erreur` d'abord, puis `non_verifiable`, puis `verifiee`. Le plafond de 60 affirmations par fiche et de 6 fiches (360) le rend inatteignable en pratique, la règle ne sert que de garde.
5. `ConfirmRequest.removed` au-delà de 500 : 400 `requete_invalide` (l'écran propose « tout retirer jusqu'à la fin » en plusieurs envois seulement si ce cas arrive en pratique ; non prévu en v1).

### 2.6 Identifiants uniques à l'échelle du cours (extension par F10)

La lecture d'un job numérote `b1…`, `f1…` à partir de 1. Un ajout de pages (F10) rejoue la lecture dans un nouveau job. **Règle : les identifiants du job restent locaux au job (le contrat de lecture ne change pas) ; au moment d'écrire dans le cours, le serveur renumérote les blocs et figures avec un décalage** (`b<n + nombre de blocs du cours>`, `f<n + plus grand numéro de figure du cours>`). La clé S3 finale utilise l'identifiant renuméroté, donc une figure ajoutée n'écrase jamais une figure existante. `COURS#<id>#B` est réécrit par une écriture conditionnelle sur la version de l'élément (compteur `v`), sous le même verrou que l'ajout de pages de F10 : en cas de conflit, la seconde confirmation relit, renumérote et réessaie. Les identifiants de phrase suivent la règle de F10 (numéros de page décalés). Les numéros de figure du cours peuvent donc ne pas être contigus. Le renvoi de F10 à « P14 » doit pointer vers **P15** ci-dessous.

### 2.7 Formules en LaTeX (décision P13)

**Format.** Une formule seule sur sa ligne est un bloc `formule` dont l'unique phrase contient le LaTeX **sans délimiteurs** (`\frac{a}{b}`). Une formule dans une phrase (paragraphe, liste, titre) est entourée de `$…$` ; un `$` littéral s'écrit `\$`. Le prompt de lecture demande : « écris les formules en LaTeX, `$…$` dans le texte, une ligne `= …` pour une formule seule » et n'autorise que les commandes courantes (fractions, puissances, indices, racines, lettres grecques, sommes et intégrales, vecteurs, `\text`, `aligned`, `cases`, matrices). Le surcoût en jetons est de l'ordre de 50 par page dense (non mesuré).

**Contrôle par le serveur** (`sanitizeLatex`, fonction pure, lot A, appliquée à la lecture ET aux corrections de l'élève à la confirmation) :
1. 500 caractères au plus par formule, 2 000 par phrase (limite existante), aucun caractère de contrôle ;
2. `$` en nombre pair dans une phrase (hors `\$`) ;
3. accolades équilibrées, profondeur d'imbrication de 8 au plus ;
4. **liste d'interdits** : `\href`, `\url`, `\includegraphics`, `\html*`, `\input`, `\include`, `\write`, `\def`, `\edef`, `\gdef`, `\xdef`, `\let`, `\newcommand`, `\renewcommand`, `\csname`, `\read`, `\catcode`, `\style`, `\class`, `\data`, `\id`, `\cssId`.
Une formule qui ne passe pas n'est pas rejetée : ses délimiteurs sont retirés et elle reste du **texte simple** (affiché tel quel, échappé). Une correction de l'élève qui ne passe pas est refusée côté écran avec un message ; côté API, 400 `requete_invalide` (rien n'est modifié).

**Affichage (sécurité).** Le site sépare le texte en segments (`splitMath`) : les segments de texte sont rendus par React (échappés), seuls les segments de formule passent par KaTeX (`renderToString`) avec `trust: false`, `throwOnError: false`, `maxSize: 10`, `maxExpand: 1000`, `strict: 'ignore'`, et **`output: 'mathml'`**. Raison du MathML : la politique de sécurité du site (`style-src 'self'`, `infra/lib/web-stack.ts`) interdit les styles en ligne, que la sortie HTML de KaTeX emploie ; le MathML n'en a pas besoin, ne demande ni feuille de style ni polices embarquées, et lit bien avec un lecteur d'écran. Le résultat de KaTeX est la seule chaîne injectée dans le DOM (`dangerouslySetInnerHTML` confiné à un composant `Math`), jamais un texte de l'élève ou du modèle. Tests du lot C : `\href{javascript:…}{x}` et `\url` ne produisent aucun lien, `<script>` dans une formule est échappé, une formule invalide s'affiche en texte simple. Navigateurs : MathML Core est pris en charge par Chrome, Edge, Firefox et Safari récents ; à vérifier sur les appareils de la famille (P17).

**Autres effets.**
- *Vérification* : la recherche de sources (8 mots au plus) retire les segments `$…$` de l'affirmation. Une affirmation qui contient une formule a toujours `aRisque` (règle existante). Une formule seule a peu de chances d'être vérifiable dans des textes Wikimedia : elle sera souvent `non_verifiable`, donc reprise avec « non vérifié » (D9).
- *Comptage de mots* : une formule compte pour un mot dans le seuil de 40 mots.
- *Rappel* : le texte copié contient le LaTeX ; le rappel de type `formule` s'affiche en mode bloc.
- *QCM et trous* : le mot masqué d'un trou ne peut pas être à l'intérieur d'une formule (`validGap`) ; les énoncés et les choix peuvent contenir `$…$`, rendus par le même composant. Les mêmes contrôles `sanitizeLatex` s'appliquent à la sortie du modèle avant écriture.
- *Édition* : le champ de correction montre le LaTeX brut, avec un aperçu rendu dessous.

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

Décision : l'image recadrée est la figure ; la description courte (`alt`, 300 caractères) est toujours produite dans le même appel, sert de texte alternatif et n'est **jamais** un substitut de l'image : si le cadre est faux, on obtient quand même une image (§3.4). Une description n'est jamais présentée comme un fait vérifié : elle n'entre ni dans les affirmations, ni dans la vérification, ni dans les questions. L'élève peut la corriger (`ConfirmFigure.alt`).

Les questions « légender un schéma » (#43) sont hors périmètre ; la structure (`figureId` stable, `alt`, `caption`) les rend possibles plus tard sans changer le contrat.

### 3.2 Cycle de vie

1. **Lecture** (`transcribe`, rôle `procRole`) : le modèle donne un cadre normalisé. Le code lit l'image de la page, ajoute 4 % de marge, rogne avec `sharp`, ré-encode en JPEG qualité 80 sur 1200 px au plus (cela retire les métadonnées EXIF, dont la position GPS), et écrit `scans/<sid>/<jobId>/fig/<figureId>.jpg` dans le **bucket des scans**. Ce préfixe est supprimé avec la photo (`s3.deleteAll(scansPrefix)` existant) et par la règle de cycle de vie de 1 jour, y compris si l'élève n'ouvre jamais la relecture (12 heures avant expiration, puis suppression). Cette écriture déclenche la règle EventBridge `ScanUploaded` (préfixe `scans/`) : `scanStart` reçoit jusqu'à 8 événements par scan dont la clé ne correspond pas à `scans/<sid>/<job>/<n>` et sort sans effet. Aucun danger, quelques invocations de plus ; accepté plutôt que de sortir les recadrages du préfixe `scans/` (qui obligerait à ajouter un second préfixe à tous les nettoyages).
2. **Relecture** : `GET /jobs/{id}/transcription` (`readRole`) renvoie les figures avec une URL pré-signée de 5 minutes sur le recadrage temporaire. L'élève garde ou retire chacune et peut corriger le texte alternatif.
3. **Confirmation** (`jobsConfirm`, `api/src/pipeline/api.ts`, rôle `confirmRole`). Ordre, pour qu'aucune étape ne laisse d'état à moitié fait :
   1. validation de la requête (`figureId` inconnu : 400, rien n'est modifié) ;
   2. **copie** (`CopyObject`) des figures gardées de `scans/<sid>/<jobId>/fig/<id>.jpg` vers `figures/<sid>/<coursId>/<id final>.jpg`, **avant** la transition `a_confirmer → verification`, pendant que la photo existe encore ; l'écriture est idempotente (même clé de destination) ;
   3. une erreur S3 pendant la copie renvoie une erreur réessayable (503 `indisponible`) **sans changer l'état du job** : l'élève renvoie la confirmation, rien n'est perdu ;
   4. écriture de `COURS#<id>#B`, puis transition ;
   5. **course perdue** (la transition échoue parce que le job a été annulé ou a expiré entre-temps) : le chemin existant qui supprime le cours orphelin supprime aussi `figures/<sid>/<coursId>/` ;
   6. la photo et le préfixe `fig/` temporaire sont supprimés après la transition, comme aujourd'hui.
   Une figure absente de `ConfirmRequest.figures` n'est pas copiée : le défaut protège la donnée.
4. **Lecture du cours et de la fiche** : URL pré-signée de 5 minutes pour l'élève seul (`coursReadRole`, `readRole`).
5. **Suppression, dans cet ordre** pour qu'une suppression interrompue se reprenne : le préfixe `figures/` S3 est supprimé **avant** l'en-tête et l'arbre DynamoDB, de sorte que tant qu'une image existe, l'élément qui permet de la retrouver existe aussi.
   - `DELETE /cours/{id}` (`cours-delete`, `coursRole`) : `figures/<sid>/<coursId>/` d'abord, puis `deleteCoursTree` (qui supprime aussi `COURS#<id>#B`), puis `JOB#<jobId>/TEXT#` et `JOB#<jobId>/BLOCKS`.
   - Suppression d'un élève : `figures/<sid>/` d'abord, puis `deleteStudentTree`. Suppression de famille : `figures/<sid>/` de chaque élève (liste lue avant), puis `deleteFamilyTree`. C'est le handler, pas `TreeDb`, qui parle à S3 (comme pour Cognito et les photos).
   - `failJob` supprime aussi le préfixe `figures/` du cours.

Si l'élève supprime le cours en gardant les fiches (`fiches=garder`), les figures partent avec le cours : la fiche perd ses images (elle garde son texte). Raison : une seule durée de vie pour une image, pas de copie orpheline.

### 3.3 Confidentialité d'un mineur

- Une figure est un extrait d'une page de cours, donc une donnée d'élève, au même titre que le texte du cours (T3). Elle peut contenir par accident une écriture manuscrite, un nom, un visage (portrait d'une personne publique dans une leçon d'histoire).
- Mesures : (1) choix explicite et par figure, rien de gardé par défaut ; (2) aucune figure suggérée si la zone est surtout de l'écriture manuscrite ou un portrait de personne non publique (consigne de prompt, mesurée sur le jeu d'essai) ; (3) suppression des métadonnées, taille réduite ; (4) bucket privé, chiffré, TLS exigé, accès public bloqué, accès uniquement par URL pré-signée de 5 minutes après contrôle d'appartenance ; (5) jamais dans les journaux, l'export parent, ni l'état Step Functions (l'archive de l'élève, elle, les contient : §3.6) ; (6) 8 figures et environ 300 Ko chacune au plus par scan.
- Le parent ne lit pas le texte du cours : il ne lit pas non plus ses figures (`CoursMeta` n'a que `figureCount`). Même règle pour la lecture et pour l'**export parent** (point ouvert P16). L'**export de l'élève** contient tout, figures comprises (§3.6).
- Conséquences juridiques : durée, finalité et destinataires sont ajoutés au registre (T3) et à la politique, et un risque est ajouté à l'AIPD. Les textes sont dans le commit séparé (§11).

### 3.4 Rognage : `sharp` en couche Lambda réservée à `transcribe`

Le dépôt n'a aucune bibliothèque d'image. `pipeline-stack.ts` construit un seul paquet `esbuild` (`lambda.Code.fromAsset(bundle())`) partagé par toutes les fonctions, qui diffèrent par leur export (`index.<handler>`). `sharp` est un binaire natif (`@img/sharp-linux-arm64`), qui ne doit **jamais** entrer dans ce paquet commun (taille et démarrage à froid de 20 fonctions pour une seule qui en a besoin).

**Décision : une couche Lambda (`lambda.LayerVersion`, architecture arm64, runtime Node) contenant `sharp`, attachée à la seule fonction `transcribe`.** Le paquet commun déclare `sharp` en `external` et `figures.ts` l'importe dynamiquement (`await import('sharp')`) ; seules les fonctions où la couche est présente le trouvent. La couche est fabriquée par un script de lot B (`npm install --os=linux --cpu=arm64 --include=optional sharp` dans un dossier `nodejs/`, non versionné, exécuté avant `cdk synth` en CI). Pourquoi une couche plutôt qu'un second asset : le code de `transcribe` reste dans le paquet commun (un seul chemin de build), la couche se reconstruit rarement et se teste seule. Alternative écartée : un second `Code.fromAsset` pour `transcribe` seul, qui oblige à dupliquer le build du code applicatif. Autre alternative écartée : recadrer dans le navigateur et téléverser l'image, qui ouvre à un compte d'élève une écriture de fichier arbitraire dans un bucket conservé.

**Une figure reste une image** (P7). Cas d'échec et conduite :
- *Cadre hors bornes ou rognage vide* (le modèle s'est trompé) : une seule reprise par un modèle plus gros (§3.5) pour la page ; si le cadre reste invalide, la figure devient la **page entière**, réduite à 1200 px, sans métadonnées (`Figure.box` absent). L'élève la voit comme « Page entière » et peut la retirer.
- *`sharp` indisponible ou en erreur* (couche absente, mémoire, délai) : c'est une panne d'infrastructure, pas un cas normal. L'étape `transcribe` renvoie une erreur réessayable (reprise automatique de Step Functions, 2 essais). Si l'erreur persiste, le scan échoue comme un échec de lecture (`failJob`, quota rendu, message « le découpage des schémas a échoué, reprends ta photo »). On ne propose jamais une figure « en texte seul » à la place de l'image. Un scan sans aucune figure ne charge pas `sharp` et n'est donc pas concerné.
- Un journal sans contenu (`step: figure-crop`, `status`, `fallback: page|retry`) permet de compter les cas.

Risque non mesuré : taille de la couche (de l'ordre de 15 à 25 Mo décompressée, limite Lambda 250 Mo au total) et durée de rognage (estimée 100 ms par figure).

### 3.5 Précision des cadres et modèle plus gros (P8)

La précision des cadres de Haiku n'est pas mesurée. Le lot API commence par une mesure sur 10 pages avec schémas (cadre jugé correct si le recouvrement est d'au moins 0,6 avec un cadre tracé à la main) : c'est un contrôle de fumée, pas une mesure statistique (viser 30 pages si possible). Décision du propriétaire : **si moins de 70 % des cadres sont corrects, un modèle plus gros est autorisé.** Deux mécanismes, tous deux dans le lot A :

1. **Reprise automatique** (toujours active) : quand le cadre d'une figure est invalide (hors bornes, surface hors 3 % à 90 %), un second appel par Sonnet (`sonnet-5.5` de `shared/pricing.ts`) repère la figure sur cette page seule.
2. **Mode « Sonnet d'abord »** (interrupteur de configuration `FIGURE_BOX_MODEL=sonnet`, défaut `haiku`) : activé si la mesure donne moins de 70 %. Haiku lit toujours le texte ; pour chaque page qui contient au moins une figure, Sonnet fournit les cadres.

Coût estimé (non mesuré) d'un appel Sonnet par page avec figure : image environ 1 600 jetons + consigne 400, soit 2 000 en entrée (2,2 USD/M), et environ 150 jetons en sortie (11 USD/M) : 0,0044 + 0,0017 = 0,0061 USD, soit **environ 0,0055 € par page**. Pour un scan de 3 pages dont 2 ont des figures : environ 0,011 € en mode « Sonnet d'abord », 0,0055 € par figure reprise en mode automatique (si 30 % des cadres Haiku sont faux : environ 0,002 € par page à figures). Le plafond de job `max(0,25 ; 0,15 × pages)` couvre largement ce surcoût. Lire toute la page avec Sonnet (texte et cadres) coûterait environ 0,014 € par page (25 fois la lecture Haiku) : non retenu.

Infra (lot B) : `procRole` n'a aujourd'hui que le droit d'invoquer Haiku (`haikuArn`, profil système Haiku) ; il faut ajouter `bedrock:InvokeModel` sur l'ARN du profil Sonnet (paramètre SSM `models/sonnet`, déjà utilisé par `eval-stack.ts`) avec la même condition de profil d'inférence, et `QCM_MODEL_SONNET` dans l'environnement de `transcribe`.

### 3.6 Export de l'élève (P14)

Décision du propriétaire : **l'export de l'élève contient tout, figures comprises.** Il n'existe pas aujourd'hui de route d'export côté élève (seul le parent exporte, sans texte de cours). Ajout, additif : `POST /me/export/archive` (élève seulement, 403 pour le parent). **Cette route n'est pas dans le contrat de cette PR** : le test d'infrastructure (`infra/test/stacks.test.ts`) exige que la table `ROUTES` de `api-stack.ts` couvre exactement les routes du contrat, donc le lot A l'ajoute au contrat, à `ROUTES` et à la liste des fonctions dans une seule PR. Seuls les champs facultatifs `courses` et `figures` de `ExportArchive` sont déjà dans le contrat 1.5.0. La route renvoie un `ExportArchive` (lien signé de 10 minutes, zip supprimé au plus tard 2 jours après, 3 archives par heure et par élève). Contenu : `export.json` (profil, dossiers, cours avec texte, blocs et sections, fiches avec affirmations, sources, résumé, paragraphes et rappel, historique des tests **avec les réponses données**), `figures/<coursId>/<figureId>.jpg` pour chaque figure gardée, et `tests/<studentId>.jsonl`. Borne : 200 Mo ; au-delà, les cours les plus anciens sont omis et `truncated` vaut vrai. Le fichier est écrit dans le bucket d'export existant (`exports/`, règle d'expiration existante) par un handler dont le rôle reçoit `GetObject` sur `figures/<sid>/*` et rien d'autre sur `figures/`. Le lien ne porte aucune donnée.

**Point ouvert P16.** L'export du **parent** (`GET /family/export`, `POST /family/export/archive`) garde la règle déjà validée : aucun texte de cours, aucune figure, ni réponses données. Or le parent est celui qui exerce les droits d'accès d'un enfant de moins de 15 ans. À trancher par le propriétaire avec la personne compétente de l'AIPD : le parent doit-il pouvoir obtenir le cours et les figures de son enfant (droit d'accès) ? Défaut : non, la règle validée est conservée et la politique renvoie l'élève à son propre export.

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
"fiche": {"paragraphes":[{"heading":"...","text":"...","claimIds":["01","02"]}],
          "rappel":[{"kind":"date|formule|definition|nombre","claimId":"03"}]}
```

Règles de code, vérifiées après l'appel (`validFiche`, fonction pure testée comme `validQcm`) :

1. 6 paragraphes au plus, 150 mots au plus chacun, 350 au total ; chaque `claimId` cité existe parmi les affirmations de la fiche.
2. Un élément de rappel doit citer une affirmation existante qui n'est ni en `erreur` ni `non_factuelle`.
3. **Le modèle ne choisit que `claimId` et `kind`. Le texte du rappel est copié par le code depuis l'affirmation citée** (`RecallItem.text` = texte de l'affirmation, jusqu'à 1 000 caractères, comme `Claim.text`). Le modèle n'écrit donc aucun mot du rappel : une date, une formule ou une définition inventée est impossible par construction, y compris une définition sans chiffre, que le contrôle de nombres n'aurait pas vue. Un élément dont `claimId` est inconnu est supprimé ; un `kind` `formule` sur une affirmation sans `=` est rétrogradé en `definition`. Les paragraphes de fiche ne sont contrôlés que sur l'existence de leurs `claimIds` (leur texte est écrit par le modèle à partir des affirmations, comme le `resume` actuel).
4. `verified` vaut vrai si l'affirmation est `verifiee`, faux si elle est `non_verifiable` (l'élément est repris du cours et affiché avec la mention « non vérifié »). Cela suit la règle actuelle : une affirmation non vérifiée sert au résumé, jamais aux questions.
5. Si la sortie est illisible ou ne passe pas, repli sur le `resume` actuel (un paragraphe, pas de rappel). Aucune fiche n'échoue pour cela.

`Doc.figures` : **toutes les figures des blocs de la section de la fiche** (de `fromSentenceId` jusqu'à la phrase qui précède la section suivante). `docs-read` retrouve la section par `DocSummary.sectionIndex` et `coursId`, lit l'en-tête du cours et `COURS#<id>#B`, et ne renvoie rien si le cours n'existe plus. Élève seulement : le lot A ajoute un test qui vérifie qu'un compte parent ne reçoit jamais `figures` ni `body`/`recall` liés au cours (la lecture parent d'une fiche, si elle existe, n'a pas ces champs).

`Doc.summary` reste rempli (paragraphes joints par une ligne vide, sans le rappel) pour les clients 1.4. Les QCM, les trous et leur contrôle de résolution sont inchangés et ne lisent jamais le rappel ni les descriptions de figures.

Pourquoi la copie par le code : une date ou une formule fausse dans un rappel est l'erreur la plus nuisible d'une fiche, parce que le rappel est la partie qu'un élève retient. La copie supprime la classe d'erreur au lieu de la détecter, et réduit la sortie du modèle (pas de texte de rappel à produire).

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
| `Sentence` | `doubt` (réponse seulement) ; `text` peut contenir du LaTeX (§2.7) |
| `Transcription` | `blocks`, `figures` |
| `ConfirmRequest` | `figures` (`ConfirmFigure`: `figureId`, `keep`, `alt`), `removed` |
| `Cours` | `blocks`, `figures`, `marks` (`SentenceMark`) |
| `CoursMeta` (export) | `figureCount` |
| `ExportArchive` | `courses`, `figures` (facultatifs) |
| Route à venir (lot A, avec `ROUTES`) | `POST /me/export/archive` (élève seul) |
| `Claim` | `sentenceId` |
| `Doc` | `body` (`FicheParagraph`), `recall` (`RecallItem`), `figures` |
| Nouveaux | `Block`, `Figure`, `FigureBox`, `ConfirmFigure`, `SentenceMark`, `FicheParagraph`, `RecallItem` |

Aucune route dans cette PR (la route d'export de l'élève, §3.6, arrive avec le lot A) ; les URL des figures sont pré-signées dans les réponses existantes (même mécanisme que `photoUrls`). `Figure.url` est **requis** (une figure est toujours une image). Erreurs : `figureId` inconnu ou `removed` invalide donne 400 `requete_invalide` ; état inchangé.

## 11. Confidentialité (commit séparé)

Le commit « docs(legal): R1 » modifie `docs/legal/registre.md` (T3), `politique-confidentialite.md` et `aipd-brouillon.md`. `sous-traitants.md` n'est **pas** modifié : aucun nouveau sous-traitant (AWS, déjà listé, héberge aussi le bucket des figures). La politique dit aussi ce que deviennent les découpages si l'élève n'ouvre jamais la relecture : supprimés avec la photo, au plus tard dans les 2 jours. Un second commit légal (« R1 : export de l'élève, P14 ») ajoute l'export de l'élève et le point ouvert P16. Ils ne touchent pas `shared/policy.ts` : `POLICY_VERSION` reste `2026-11-26`. **Les textes sont à valider par le propriétaire** ; une modification de la durée ou de la nature d'une donnée conservée est une information nouvelle pour les familles, donc le relèvement de `POLICY_VERSION` (et le nouveau consentement qui en découle) sera décidé par le propriétaire à la mise en production du lot, pas avant (P10).

## 12. Découpage en lots et fichiers propres

Un seul propriétaire par fichier. Les lots A et C peuvent avancer en parallèle dès que le contrat 1.5.0 est fusionné (le lot C travaille contre `npm run mock`). **Le contrat 1.6.0 (F10, ajout de pages, PR #84) attend la fusion de R1-A** : F10-A et R1-A partagent `api.ts`, `steps-doc.ts`, `text.ts`, `items.ts` et `COURS#<id>#B` (§2.6).

### Lot R1-A : API et pipeline

- `api/src/pipeline/blocks.ts` (nouveau : `parseBlocks`, bornes §2.5, `validFiche`, copie du rappel), `api/src/pipeline/latex.ts` (nouveau : `sanitizeLatex`, retrait des formules pour la recherche de sources) et leurs tests
- `api/src/pipeline/figures.ts` (nouveau : rognage `sharp` par import dynamique, reprise Sonnet puis page entière, copie vers `figures/`, renumérotation §2.6)
- `api/src/pipeline/prompts.ts`, `steps.ts` (`readWindow`, `transcribe`), `steps-doc.ts` (`generate`), `text.ts` (recollage de blocs), `ports.ts` (ports `crop` et `figures`)
- `api/src/pipeline/api.ts` (**`jobsConfirm`** : validation, copie des figures avant la transition, course perdue, `removed`, `jobsTranscription`, `docsRead`), `api/src/pipeline/job.ts` (`failJob`, `endWithoutDoc`, `purgeScan` : suppression de `figures/` et de `JOB#/BLOCKS`), `api/src/pipeline/entry.ts` (câblage des ports)
- `api/src/scans/delete.ts` et `api/src/cours/*` (`cours.ts` `del`, marques, lecture des blocs) : suppression de `JOB#/BLOCKS`, ordre S3 puis DynamoDB (§3.2 point 5)
- suppression d'élève et de famille : `api/src/family/archive.ts` (archive de l'élève), `api/src/family/students.ts`, `api/src/family/family.ts` (S3 `figures/<sid>/` avant `deleteStudentTree` / `deleteFamilyTree`)
- `shared/ddb/keys.ts`, `shared/items.ts`, `shared/delete-tree.ts` (+ test de comptage), `shared/names.ts` (paramètre SSM `data/figuresBucket`, avec le lot B), `docs/data-model.md` : **édités par le lot A seul, relus par le propriétaire de L1c** (règle du contrat et du modèle de données)
- `mock/**` et `e2e/mock-api/**` : exemples et simulateur d'API des nouveaux champs (propriétaire : lot A ; le lot C les lit)
- `golden/` et `eval/` : jeu d'essai de 10 pages avec schémas, mesure des cadres et des marquages douteux
- Tests : contrat (400 sur `figureId` inconnu, `removed` de début de section), bornes §2.5, rappel copié, `sanitizeLatex` (interdits, `$` impair), cadre invalide puis page entière, `sharp` en panne puis échec et quota rendu, archive de l'élève, ordre de suppression, parent sans `figures`

### Lot R1-B : infra

Les droits des fonctions HTTP sont dans `infra/lib/pipeline-stack.ts` (pas dans `api-stack.ts`, qui ne porte que la table des routes), ceux de la suppression d'élève et de famille dans `infra/lib/game-stack.ts`.

- `infra/lib/data-stack.ts` : bucket `figures` (chiffré, TLS exigé, accès public bloqué, CORS non nécessaire, **aucun cycle de vie par âge**, `RemovalPolicy.DESTROY` en dev comme `Scans`), paramètre SSM `data/figuresBucket`
- `shared/names.ts` : nom du paramètre SSM (avec le lot A, un seul éditeur : lot B pour cette ligne)
- `infra/lib/pipeline-stack.ts` : couche `sharp` attachée à `transcribe` seul, `sharp` en `external` du paquet commun, mémoire de `transcribe` 512 → 1024 Mo, et les droits ci-dessous
- `infra/lib/game-stack.ts` : rôle `admin` de `students-delete` et `family-admin`
- `infra/test/*` : tests de synthèse (bucket privé et chiffré, aucun droit hors préfixe, aucun droit `figures` sur les rôles parent ou d'export, couche absente des autres fonctions)
- script de fabrication de la couche et étape de CI associée
- `procRole` : `bedrock:InvokeModel` sur le profil Sonnet (§3.5) ; rôle du handler d'export de l'élève : `GetObject` sur `figures/<sid>/*` ; nouvelle route `POST /me/export/archive` dans `infra/lib/api-stack.ts` (table des routes) et le rôle de `family-export-archive` ou d'un handler `me-export-archive` (propriétaire : lot A pour le code, lot B pour les droits)
- Estimation de coût avant déploiement, à valider par le propriétaire ; toutes les ressources taguées `Project`, `Environment`, `ManagedBy`, `Owner`

Droits exacts à ajouter (S3 = ressource de l'objet ; `scans` = bucket des photos, `figures` = nouveau bucket) :

| Rôle (fonctions) | Droit ajouté | Pourquoi |
|---|---|---|
| `procRole` (`transcribe`, `fail`, `expire`…) | S3 `PutObject` sur `scans/*/fig/*` ; `Get`/`Delete`/`List` existants conservés | écrire les recadrages temporaires ; `fail` supprime aussi `figures/*` : voir ligne suivante |
| `procRole` (`fail`, `expire`) | S3 `ListBucket` (préfixe `figures/`) et `DeleteObject` sur `figures/*` | nettoyage après échec |
| `confirmRole` (`jobs-confirm`) | S3 `GetObject` sur `scans/*` (source de la copie) ; `PutObject` et `DeleteObject` sur `figures/*` ; DynamoDB inchangé (`STUDENT#*`, `JOB#*`, `BatchWriteItem`) | copie avant la transition, suppression en cas de course perdue |
| `readRole` (`jobs-get`, `jobs-transcription`, `docs-read`) | S3 `GetObject` sur `figures/*` (signature) ; DynamoDB inchangé | URL de figures de la fiche ; les recadrages temporaires sont déjà couverts par `scans/*` |
| `coursReadRole` (`cours-api`) | S3 `GetObject` sur `figures/*` ; DynamoDB `GetItem`/`Query` sur `DOC#*` **en plus** de `STUDENT#*` | signer les figures ; `Cours.marks` lit `CLAIM#` et `VERDICT#` sous `DOC#<id>` |
| `coursRole` (`cours-delete`) | S3 `ListBucket` (préfixe `figures/`) et `DeleteObject` sur `figures/*` | suppression du cours (§3.2 point 5) |
| `scansDeleteRole` (`scans-delete`) | aucun : le recadrage est sous `scans/*` (déjà `DeleteObject`) | |
| `admin` de `game-stack.ts` (`students-delete`, `family-admin`) | S3 `ListBucket` et `DeleteObject` sur `figures/*` (en plus de `scans/*`, `exports/*`) | suppression d'un élève ou d'une famille |

Justification de la lecture `DOC#*` pour `cours-api` : la partition `DOC#<id>` n'est pas clé par élève, donc la condition de clé IAM ne peut pas l'isoler ; l'isolation est faite par le handler, qui ne lit que les `docId` listés dans les sections de l'en-tête `COURS#<id>` de l'élève (déjà lu dans `STUDENT#<sid>`). Le lot A le teste (un `docId` étranger placé dans l'en-tête n'est pas lu). Alternative écartée : écrire les marques à la fin de la vérification (`finalize`), qui ajoute un écrivain et oblige `docs-delete` à les nettoyer.

### Lot R1-C : site

- `web/src/screens/confirm/` : `ConfirmView.tsx` (vue document), nouveau `DocView.tsx` (blocs et phrases), `FigureCard.tsx`, `sections.ts` (coupes entre blocs), `storage.ts` (retraits, figures), `confirm.css`, tests
- `web/src/screens/Cours.tsx` (blocs, figures, marques, interrupteur), `web/src/screens/Doc.tsx` (paragraphes, rappel, figures)
- `web/src/api.ts`, `web/src/types.ts`, `web/src/labels.ts`, `web/package.json` (dépendance `katex`), nouveau `web/src/components/Math.tsx` (`splitMath`, KaTeX en MathML), bouton « Télécharger mes données » de l'élève
- `e2e/**` (hors `e2e/mock-api/**`, propriété du lot A) : parcours relecture (douteux, correction en place, retrait, figure gardée et refusée, page entière), formules (rendu, aperçu, `\href` sans lien), captures PC et mobile

### Lot R1-D : textes légaux (après validation)

- `docs/legal/*` ; `shared/policy.ts` seulement sur décision du propriétaire (P10)

### Ordre

1. PR de conception (celle-ci), puis fusion du contrat 1.5.0. Le contrat 1.6.0 de F10 vient après R1-A.
2. R1-A et R1-C en parallèle ; R1-B avant le premier déploiement dev de R1-A.
3. Mesure sur le jeu d'essai (cadres, marquages douteux, troncature, taux de reprise Sonnet et de page entière) **avant** d'ouvrir le lot en production.

## 12.1 Hors v1, prévu plus tard

Décisions du propriétaire (P5, P6) : ces deux évolutions sont voulues mais ne font pas partie de R1.

- **Ajout d'une phrase oubliée à la relecture** (P5). En v1 l'élève corrige ou retire une phrase, il n'en ajoute pas. Prévu plus tard : l'ajout suppose un identifiant de phrase nouveau (`p<page>-s<n>` sans trou), une position dans un bloc et la prise en compte par les sections ; le contrat de R1 ne l'empêche pas (les identifiants ne sont jamais renumérotés).
- **Édition du cours après confirmation** (P6). En v1, supprimer et rescanner. Prévu plus tard : modifier le cours oblige à refaire l'extraction et la vérification des fiches liées (second plafond de coût, affirmations orphelines) ; à concevoir avec l'ajout de pages de F10.
- Questions « légender un schéma » (#43).

## 13. Points à trancher (défaut proposé)

| # | Question | Défaut |
|---|---|---|
| P1 | Valider les textes de confidentialité du commit séparé | À relire par le propriétaire (aucune mise en ligne avant) |
| P2 | Durée des figures | Vie du cours (jusqu'à suppression du cours, de l'élève ou de la famille), pas de durée automatique |
| P3 | Figures gardées par défaut ? | **Non** : choix explicite par figure |
| P4 | Fiche gardée après suppression du cours : garde-t-elle ses images ? | Non, les figures partent avec le cours |
| P5 | Ajout d'une phrase oubliée à la relecture | **Tranché : hors v1, prévu plus tard** (§12.1) |
| P6 | Édition du cours après confirmation | **Tranché : hors v1, prévu plus tard** (§12.1) |
| P7 | Rognage serveur ou dans le navigateur ; empaquetage de `sharp` ; figure en texte | **Tranché : la figure reste une image.** Serveur ; `sharp` en couche Lambda arm64 réservée à `transcribe`, jamais dans le paquet commun ; cadre faux : reprise Sonnet puis page entière ; `sharp` en panne : scan réessayé puis en échec, quota rendu (§3.4) |
| P8 | Si moins de 70 % des cadres sont corrects à la mesure | **Tranché : un modèle plus gros est autorisé** (Sonnet, environ 0,0055 € par page à figures, §3.5) ; reprise automatique toujours active, « Sonnet d'abord » si la mesure est sous 70 % |
| P9 | `SINGLE_CALL_PAGES` 4 ou 3 | Rester à 4, passer à 3 si plus de 10 % de replis à la mesure |
| P10 | Relever `POLICY_VERSION` pour R1 | Oui, **avant le premier déploiement (dev compris) qui conserve une figure**, pas seulement à la mise en production ; pas dans cette PR |
| P11 | Seuil de 40 % de phrases douteuses | 40 %, à ajuster à la mesure |
| P12 | `ConfirmRequest.removed` défini ici | Oui, dans le contrat 1.5.0 (absent de main) |
| P13 | Formules : texte brut ou LaTeX | **Tranché : LaTeX** (§2.7) : contrôle serveur, rendu KaTeX en MathML, aucun HTML injecté hors KaTeX |
| P14 | Export : figures de l'élève | **Tranché : l'export de l'élève contient tout, figures comprises** (`POST /me/export/archive`, §3.6) ; l'export parent garde la règle (pas de contenu de cours), voir P16 |
| P15 | Identifiants de blocs et de figures dans un cours qui s'étend (ajout de pages, F10) | Locaux au job à la lecture, **renumérotés avec un décalage à l'écriture dans le cours** : uniques à l'échelle du cours (§2.6) ; `COURS#<id>#B` réécrit sous le verrou de F10. F10 renvoie à P15 (et non P14). **Tranché : OK** |
| P16 | **Point ouvert** : l'export du parent contient-il le cours et les figures de l'enfant (droit d'accès d'un parent) ? | Non : règle validée conservée (§3.6) ; à trancher avec la personne compétente |
| P17 | Rendu des formules : MathML (défaut) ou HTML de KaTeX avec `style-src` assoupli | MathML : aucun changement de la politique de sécurité ; à vérifier sur les appareils de la famille |

## 14. Ce qui n'a pas été mesuré

- Précision des cadres de figures de Haiku, taux de lecture douteuse bien calibré, taille réelle des sorties Markdown : tout est estimé. Aucun appel de modèle n'a été fait pour cette conception.
- Le coût du rognage, la taille de la couche `sharp`, le taux de reprise Sonnet, le surcoût de jetons du LaTeX et le rendu MathML sur les appareils de la famille ne sont pas mesurés.
- Les droits IAM du §12 sont lus dans `pipeline-stack.ts` et `game-stack.ts` de main, rien n'a été synthétisé (`cdk synth` non lancé).
- `npm run mock:check` (serveur Prism) n'a pas été lancé sur les nouveaux exemples.
- Les textes légaux sont des brouillons non relus par un juriste.
