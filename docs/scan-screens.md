# Ecrans des scans (contrat 1.3): specification pour le front

Public: eleves de 11 a 17 ans, mobile d'abord (390 px), interface claire et joyeuse (pas de theme sombre), textes courts et accentues. Tout passe par `web/src/api.ts`; aucun nouvel appel en dehors du contrat 1.3. Le parent voit les memes listes en lecture seule (pas de selection, pas de modification).

Libelles des matieres: `maths` Maths, `physique` Physique-chimie, `svt` SVT, `histoire_geo` Histoire-geo, `francais` Francais, `autre` Autre.

## 1. Ajouter des photos (ecran `/scan`)

- Un bouton « Prendre ou choisir des photos » (`<input type="file" multiple accept="image/jpeg,image/png">`, 10 fichiers au plus; sur mobile l'appareil photo reste propose). Un second bouton « Ajouter une page » apres la premiere selection.
- Apres choix: vignettes numerotees dans l'ordre (fichier en memoire seulement, jamais stocke), boutons « Monter », « Descendre », « Retirer » par page, compteur « 3 pages, il te reste 17 pages ce mois-ci ». L'ordre des vignettes = ordre des pages.
- Controles avant envoi: type jpeg ou png (sinon message par fichier), 5 Mo au plus par fichier (la limite serveur; l'ancien 10 Mo est faux), 10 pages au plus, pages demandees <= pages restantes (sinon bouton desactive et message).
- Liste deroulante facultative « Ranger dans un dossier » (dossiers de l'eleve, plus « Nouveau dossier… »).
- Envoi: `POST /scans { pages: N, contentType: <type de la 1re>, contentTypes: [...], folderId? }`, puis N envois directs vers S3 avec `uploads[i]` (3 en parallele au plus, une barre « 2 sur 5 envoyees »). Si `uploads` est absent, utiliser `[{ page: 1, ...upload }]` (serveur 1.2: une page seulement, refuser N > 1 avec un message).
- Si un envoi echoue (apres un essai de plus): `POST /jobs/{jobId}/cancel` (rend les pages), message « L'envoi a echoue, tes pages sont rendues. Reessaie. » et on garde les vignettes.
- Reponses `429`: `quota_epuise` (date de retour des pages) et `budget_epuise`: textes actuels.
- Succes: aller a l'ecran de statut du scan (`/job/<jobId>`).

## 2. Statut d'un scan (ecran `/job/<jobId>`)

- Interroge `GET /jobs/{jobId}` toutes les 2,5 s (5 s apres une erreur) tant que `status.stage` n'est ni `termine` ni `echec`. On arrete quand l'onglet est cache et on reprend a son retour.
- Frise des etapes, dans l'ordre: Envoi, Lecture, A confirmer, Fiche, Verification, QCM, Termine. Etape courante en evidence (`aria-current="step"`), etapes passees cochees.
- Sous la frise, pour `envoi` et `lecture`: « Pages lues 2 sur 5 » (`pagesDone`, `pagesTotal`) et une barre. Heure de debut « Commence a 10:00 » (`startedAt`), duree ecoulee mise a jour chaque seconde cote client.
- `a_confirmer`: affiche « Il reste 9 h pour relire » (`expiresAt`) et l'ecran de confirmation actuel, avec en plus une zone « Matiere » (liste fermee, preselectionnee sur `suggestedSubject`) et « Sujet » (texte, 80 caracteres, prerempli par `suggestedTopic`), puis « Dossier ». Envoyes dans `POST /jobs/{jobId}/confirm` (`subject`, `topic`, `folderId`; champs omis si non modifies). Les photos s'affichent page par page (`photoUrls` dans l'ordre), avec « Page 2 sur 5 ».
- `echec`: `status.message` tel quel dans un cadre calme (pas de rouge agressif), bouton « Recommencer » vers `/scan`, rappel « Tes pages ont ete rendues ». Selon `Job.state`: `rejete` = document refuse, `expire` = delai depasse.
- `termine`: « Ta fiche est prete » et bouton vers `/doc/<docId>`.
- « Annuler et recuperer mes pages » reste visible a `envoi` et `a_confirmer` seulement (le serveur refuse ailleurs: 409).
- Texte permanent: « Tu peux quitter cette page, on garde ta place ». Le suivi est aussi dans la liste (ecran 3).

## 2 bis. Scans a relire: reprise, echeance, accueil

Un scan `a_confirmer` n'est plus perdu quand l'eleve quitte la page: il vit cote serveur (`jobId` = `scanId`) et reste ouvert jusqu'a `status.expiresAt` (12 h apres la fin de la lecture, au lieu de 30 min). Le front ne retient rien (ni `localStorage` ni URL): tout vient de `GET /scans`.

- **Accueil**: une carte « A relire » en haut, visible si `toReview > 0` (appel `GET /scans?status=a_confirmer&sort=date&order=asc&limit=5` au chargement, puis toutes les 60 s tant que l'onglet est visible). Une ligne par scan: matiere et sujet (s'il y en a), « 3 pages », temps restant (« Il reste 9 h »), bouton « Relire » vers `/job/<scanId>`. Si `expiresSoon`: ligne mise en avant (fond jaune doux, icone sablier, « Plus que 1 h 20, relis-le vite ») et texte lu par `role="status"`. Pas de rouge ni de culpabilisation. Carte placee avant les cours et avant « Scanner »; si `toReview = 0` elle disparait.
- **Relecture depuis la liste**: l'ecran `/job/<scanId>` fait deja `GET /jobs/{jobId}` puis, si `a_confirmer`, `GET /jobs/{jobId}/transcription` (URL de photos re-signees a chaque appel). Il fonctionne apres rechargement, sur un autre appareil, ou apres plusieurs heures. Ce qui est tape mais non envoye est perdu au rechargement: afficher « Tes corrections ne sont gardees qu'une fois envoyees » (pas de brouillon serveur dans ce lot).
- **Liste « Mes cours » et bandeau « En cours »**: une ligne `a_confirmer` affiche « A relire » et le temps restant a partir de `status.expiresAt` (calcule cote client avec l'heure du serveur: ecart d'horloge possible, donc se fier a `expiresSoon` pour la mise en avant et recharger la liste a chaque retour sur l'onglet). Tri du bandeau: `a_confirmer` d'abord, plus proche echeance en premier.
- **Scan expire**: la ligne passe a « Pas reussi » avec le message « Pas de confirmation apres 12 heures, la photo est supprimee » et « Tes pages ont ete rendues »; visible 7 jours. L'ecran `/job/<scanId>` d'un scan expire montre ce message et « Recommencer » (le `GET .../transcription` repond 409).
- **Aucune notification poussee ni e-mail** (pas de nouvelle ressource AWS): la mise en avant sur l'accueil est le seul rappel. Limite connue.
- **Parent**: voit dans la liste de l'eleve les scans « a relire » et l'echeance (lecture seule), sans le texte.
- Tests front: accueil sans scan a relire (carte absente), avec 2 (ordre par ancienneté, mise en avant de `expiresSoon`), reprise apres rechargement (aucun etat local requis), scan expire, scan `a_confirmer` sans `expiresAt` (ancien job: ligne sans temps restant).

## 3. Liste « Mes cours » (ecran `/docs`, ou l'accueil)

- Source: `GET /scans` (ne plus utiliser `GET /docs` pour cet ecran). Page de 50, bouton « Voir plus » avec `nextCursor`.
- Bandeau « En cours » en haut tant que `inProgress > 0`: une ligne par scan non final avec etape et « 2 sur 5 pages ». Interrogation toutes les 3 s tant que `inProgress > 0` et l'onglet visible, sinon arret. Une ligne `a_confirmer` a un bouton « Verifier » (vers `/job/<scanId>`).
- Carte de scan: titre, pastille matiere (couleur par matiere), sujet, nombre de pages, date. Scan sans matiere (en lecture): pastille grise « En cours ». Scan `echec`: pastille « Pas reussi » et message (ouvre l'ecran de statut).
- Filtres (barre repliable sur mobile): matiere (menu: `facets.subjects` avec effectifs), sujet (menu: `facets.topics`), dossier (menu des dossiers + « Sans dossier »), statut (« Tout », « En cours », « Termines », « Pas reussis »). Les filtres vont dans l'URL (`?subject=...`) pour qu'un retour arriere garde l'etat.
- Tri: « Plus recents » (defaut), « Plus anciens », « Par matiere », « Par sujet ». Pour « Par matiere » et « Par sujet », afficher des en-tetes de groupe (matiere puis sujet) construits cote client en parcourant la liste triee: le serveur renvoie l'ordre, pas de groupes.
- Etats vides: aucun cours (« Scanne ton premier cours »), aucun resultat pour ces filtres (« Aucun cours ne correspond », bouton « Effacer les filtres »), dossier vide (« Ce dossier est vide »).

## 4. Selection multiple et dossiers

- Appui long sur une carte, ou bouton « Choisir »: mode selection (cases a cocher, barre basse « 3 choisis »). Cartes `en cours` non selectionnables (pas de `docId`).
- Barre d'actions: « Ranger dans un dossier » (menu des dossiers + « Nouveau dossier ») = `POST /folders/{folderId}/scans { docIds }` (50 au plus par appel; decouper au-dela). « Sortir du dossier » = `DELETE /folders/{folderId}/scans/{docId}` pour chaque fiche. « Supprimer » = existant (`DELETE /docs/{docId}`, confirmation).
- Une fiche deja rangee ailleurs est deplacee: le dire dans la confirmation (« 2 cours seront deplaces »).
- Ecran « Mes dossiers » (`/folders`): liste (`GET /folders`) avec nombre de cours, creer (nom, 60 caracteres, 50 dossiers au plus), renommer, supprimer. Suppression: « Les cours restent, ils sortent du dossier » (nom deja pris: `409`, « Tu as deja un dossier avec ce nom »; plus de 50 dossiers: `400`). Toucher un dossier ouvre `/docs?folderId=<id>`.
- Modifier matiere et sujet d'une fiche (ecran fiche et carte): `PATCH /docs/{docId} { subject?, topic? }`; effacer le sujet: `topic: null`.

## 5. Parent (lecture seule)

- Tableau de bord: lien « Les cours de <pseudo> » qui appelle `GET /scans?studentId=<sid>` et `GET /folders?studentId=<sid>`; memes filtres et memes cartes, sans selection ni modification (un `403` serait un bug d'ecran).
- Le parent voit les scans en cours et leur etape (pas le texte des cours).

## Accessibilite et tests

- Cibles tactiles 44 px au moins, contraste AA, etat annonce par `role="status"` pour les changements d'etape, ordre de tab logique, selection au clavier.
- Tests front attendus: envoi de 3 photos (3 `POST` S3, ordre des pages), echec d'un envoi (annulation), 11e photo refusee, polling qui s'arrete a `termine`, filtre + tri dans l'URL, selection multiple et deplacement, etats vides, vue parent sans boutons de modification.
