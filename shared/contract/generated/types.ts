// GENERE par scripts/gen-contract.ts depuis shared/contract/openapi.yaml. NE PAS EDITER.
export interface paths {
    "/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Liste des scans de l'eleve (en cours, termines, en echec), filtrable et triable (handler scans-list)
         * @description Un scan = un job (`scanId` = `jobId`). La liste reunit les jobs encore presents (7 jours) et les fiches (sans limite de duree): un scan termine dont le job a expire reste liste, avec `status.stage: termine`.
         *     **Eleve**: voit uniquement ses scans. **Parent**: voit ceux de ses eleves (tous, ou un seul avec `studentId`; un eleve d'une autre famille repond 404). Lecture seule pour le parent.
         *     Les filtres se combinent (ET). `facets` et `inProgress` portent sur tous les scans visibles, sans les filtres, pour construire les menus.
         *     **Scans a relire**: un scan `a_confirmer` reste ouvert jusqu'a `status.expiresAt` (12 h apres la fin de la lecture). L'eleve le reprend par `scanId` (= `jobId`) avec `GET /jobs/{jobId}/transcription` puis `POST /jobs/{jobId}/confirm`, depuis n'importe quel appareil connecte au meme compte, apres rechargement ou changement d'ecran: le front n'a rien a retenir. `toReview` compte ces scans, `status=a_confirmer` les liste, `sort=date&order=asc` donne en premier le plus ancien (le plus proche de l'expiration). Passe l'echeance, le scan devient `echec` (`Job.state: expire`) avec un message lisible, visible 7 jours.
         *     Le front interroge cette route toutes les 3 s tant qu'un scan est `en_cours` (voir docs/scan-screens.md), sans nouvelle ressource AWS.
         *     Aucun texte de cours dans la reponse, sauf le titre et le sujet (courts, `title` et `topic`). Le parent voit donc l'etape, les pages, le titre et le sujet des scans de ses eleves, y compris en cours, jamais le texte lu.
         */
        get: operations["listScans"];
        put?: never;
        /** Reserve le quota, cree le job, renvoie une URL POST pre-signee (handler scans-create, L2a) */
        post: operations["createScan"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/scans/{scanId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /**
         * L'eleve supprime un scan non confirme, a tout moment (handler scans-delete)
         * @description `scanId` = `jobId`. Eleve proprietaire seulement: le parent repond 403, un scan d'un autre eleve (ou d'une autre famille) 404.
         *     Autorise tant que le scan n'est pas confirme: envoi, lecture, `a_confirmer`, et scans en echec ou expires encore listes. Efface la photo et le texte de travail, rend les pages du quota UNE seule fois (une suppression rejouee ne rend rien de plus), libere la machine de traitement (jeton d'envoi ou de confirmation): une confirmation tardive repond 409 et ne cree aucune fiche.
         *     Un scan deja supprime ou annule repond 404 (idempotent: rien n'est rendu une seconde fois). Un scan confirme (verification, generation) repond 409 `etat_invalide`; un scan termine se supprime par ses fiches (`DELETE /docs/{docId}`).
         */
        delete: operations["deleteScan"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Etat du traitement; `status` donne l'etape, les pages traitees et le message d'echec (handler jobs-get, L2a) */
        get: operations["getJob"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/transcription": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Texte numerote et URL pre-signee de lecture de la photo, 5 min (handler jobs-transcription, L2a)
         * @description Appelable autant de fois que voulu, depuis n'importe quel appareil de l'eleve, tant que le job est `a_confirmer` (jusqu'a `status.expiresAt`). Les URL de photo sont re-signees a chaque appel. Apres l'echeance: 409 `etat_invalide`.
         */
        get: operations["getTranscription"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/confirm": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Texte corrige, decoupage en sections, reprend le workflow (handler jobs-confirm, L2a)
         * @description `corrections` remplace le texte de phrases existantes. **`sections` (v1.3)** decoupe le texte en sections par sujet: chaque section non ignoree devient UNE fiche (matiere, sujet, titre, dossier propres; extraction, verification et QCM sur son seul texte). Le cours complet corrige est conserve (voir `Cours`); la photo est supprimee a la confirmation comme avant.
         *     Une section commence a la phrase `fromSentenceId` et va jusqu'a la phrase qui precede la section suivante (ou la fin). Les coupes tombent entre deux phrases, sur une page ou a cheval sur deux (une phrase recollee sur deux pages ne se coupe pas). `ignore: true` garde le texte dans le cours mais ne cree pas de fiche (par exemple la fin d'un autre chapitre).
         *     Sans `sections` (client 1.2: `{ corrections: [...] }`, ou avec `subject`, `topic`, `folderId`): une seule section couvre tout, avec `subject`, `topic` et `folderId` de la requete (ou les propositions de `Transcription`). **Replis (client 1.2 sans matiere)**: matiere = `suggestedSubject`, sinon `draftSubject` du job, sinon `autre`, jamais un 400. Un `folderId` absent prend celui donne a la creation du scan (`POST /scans`). `sections` et `subject`/`topic`/`folderId` ensemble: 400. **Avec `sections`, une section sans `folderId` herite du `folderId` du job** (creation ou confirmation precedente); `title` et `topic` sont nettoyes (espaces, chevrons, caracteres invisibles) par le serveur.
         *     Regles (400 `requete_invalide`, rien n'est modifie): au plus 6 sections **et au plus 2 par page du scan** (`min(6, 2 x pages)`: 2 pour 1 page, 4 pour 2, 6 des 3 pages); la premiere commence a la toute premiere phrase; `fromSentenceId` inconnu, en double ou pas dans l'ordre croissant du texte; au moins une section non ignoree; chaque section contient au moins une phrase; le texte des sections non ignorees compte moins de 40 mots **au total** (seuil `MIN_WORDS` de la transcription; il s'applique a l'ensemble des sections retenues, jamais a chaque section: une petite section isolee reste acceptee); un `topic` ou `title` vide apres nettoyage; un `folderId` inconnu (404). Le quota de pages est consomme UNE fois pour le scan, quel que soit le nombre de sections; le plafond de cout `max(0,25 ; 0,15 x pages)` vaut pour l'ensemble du job (somme des sections).
         */
        post: operations["confirmJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/jobs/{jobId}/cancel": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Annule, supprime la photo, rend le quota (handler jobs-cancel, L2a) */
        post: operations["cancelJob"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/docs": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Liste des fiches (handler docs-read, L2a) */
        get: operations["listDocs"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/docs/{docId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Fiche avec pastilles et sources (handler docs-read, L2a) */
        get: operations["getDoc"];
        put?: never;
        post?: never;
        /** Supprime la fiche et ses elements (handler docs-delete, L2a) */
        delete: operations["deleteDoc"];
        options?: never;
        head?: never;
        /** L'eleve change la matiere et/ou le sujet de sa fiche (handler docs-patch). Le parent n'a pas ce droit (403). */
        patch: operations["updateDoc"];
        trace?: never;
    };
    "/docs/{docId}/report": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Signale une erreur dans la fiche (handler docs-report, L2a) */
        post: operations["reportDoc"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/docs/{docId}/read": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** L'eleve a lu la fiche jusqu'au bout (XP de lecture, une fois par jour par fiche; handler docs-mark-read, L3) */
        post: operations["markDocRead"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/docs/{docId}/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Questions de la session, SANS les reponses (handler session-get, L3) */
        get: operations["getSession"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/folders": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Dossiers de l'eleve avec le nombre de scans (handler folders-api). Parent: lecture des dossiers de ses eleves, `studentId` obligatoire. */
        get: operations["listFolders"];
        put?: never;
        /** L'eleve cree un dossier (50 au plus, nom unique sans tenir compte de la casse ni des accents; handler folders-api) */
        post: operations["createFolder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/folders/{folderId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** L'eleve supprime son dossier. Les scans qu'il contient ne sont PAS supprimes: ils sortent du dossier (handler folders-api) */
        delete: operations["deleteFolder"];
        options?: never;
        head?: never;
        /** L'eleve renomme son dossier (handler folders-api) */
        patch: operations["renameFolder"];
        trace?: never;
    };
    "/folders/{folderId}/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Ajoute des fiches au dossier (selection multiple). Une fiche deja dans un autre dossier y est deplacee (un scan, 0 ou 1 dossier). Tout ou rien: un docId inconnu ou d'un autre eleve annule l'ensemble (404). Handler folders-api */
        post: operations["addScansToFolder"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/folders/{folderId}/scans/{docId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Retire une fiche du dossier (la fiche reste). 404 si la fiche n'est pas dans ce dossier (handler folders-api) */
        delete: operations["removeScanFromFolder"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/cours/{coursId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Le cours complet corrige, par phrases, avec son decoupage et les liens vers les fiches (handler cours-api). Eleve seulement: le parent a 403 (l'export parent n'a pas le texte).
         * @description `coursId` vient de `DocSummary.coursId` ou de `ScanSummary.coursId`. Un lien de section vers une fiche supprimee n'a plus de `docId` (statut `supprimee`).
         */
        get: operations["getCours"];
        put?: never;
        post?: never;
        /** Supprime le texte du cours (eleve seulement: 403 pour le parent, qui supprime par le compte de l'eleve). Option explicite `fiches`: `garder` (les fiches restent, sans lien vers le cours: `coursId`, `sectionIndex` et `sectionCount` retires) ou `supprimer` (les fiches du cours sont supprimees aussi). La copie de travail du texte (7 jours) est supprimee aussi. Supprimer une fiche ne supprime jamais le cours (handler cours-api) */
        delete: operations["deleteCours"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/practice/session": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * S'entrainer sur plusieurs fiches ou un dossier: tire les questions, SANS les reponses (handler practice-post, Q1, v1.7)
         * @description Eleve seulement (403 pour un parent). Exactement un de `docIds` (1 a 10 fiches) ou `folderId`. Un `docId` inconnu ou d'un autre eleve n'est pas une erreur: il est range dans `skipped` (`introuvable`), sans difference visible. Un dossier de plus de 10 fiches: les 10 les moins recemment travaillees. Ouvrir une session remet la serie a zero et ferme le test precedent (un seul test ouvert par eleve).
         */
        post: operations["postPracticeSession"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/answers": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Reponse a une question; renvoie juste/faux, XP, badges (handler answers-post, L3) */
        post: operations["postAnswer"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/activation": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** L'eleve active son compte avec le jeton du lien et choisit son mot de passe. Route PUBLIQUE, sans JWT (handler activation-post, L3) */
        post: operations["activateStudent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Profil de l'utilisateur connecte (handler me-get, L3)
         * @description Un parent qui n'a pas encore cree sa famille (aucun `familyId` dans son jeton) recoit **404 `introuvable`**, pas un profil partiel: le client doit alors proposer `POST /family`.
         *     Un eleve a toujours une famille (activation prealable).
         */
        get: operations["getMe"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** XP, niveau, serie, quota restant (handler me-get, L3) */
        get: operations["getMyProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/tests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Historique des tests de l'eleve connecte, du plus recent au plus ancien, pagine (contract-v1.4, H1; handler tests-read)
         * @description Une entree par passage de test (voir docs/H1-design.md). Reserve a l'eleve: un parent recoit 403. L'eleve ne lit jamais l'historique d'un autre eleve, meme de sa famille (la cle de partition vient du jeton).
         *     Pagination par curseur opaque: renvoyer `nextCursor` tel quel dans `cursor`. Le curseur ne contient qu'une position de tri; la partition est toujours reconstruite depuis le jeton, un curseur ne peut donc pas lire ailleurs. Un curseur invalide donne 400.
         *     Les passages sont conserves jusqu'a la suppression de la fiche, de l'eleve ou de la famille. Ils se regroupent par **annee scolaire** (1er septembre au 31 aout, fuseau Europe/Paris): `schoolYear` dans chaque passage, filtre `schoolYear` en requete, liste `schoolYears` sur la premiere page.
         */
        get: operations["listMyTests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/tests/{testId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Detail d'un passage de test: resultat de chaque question (contract-v1.4, H1; handler tests-read)
         * @description Reserve a l'eleve proprietaire. `prompt` et `choices` sont relus dans la fiche au moment de la lecture (rien du cours n'est copie dans l'historique). `correctAnswer` n'est present que pour une question terminee (juste, ou 2 essais, ou texte a trous repondu): c'est ce que l'eleve a deja eu le droit de voir.
         *     Un passage d'un autre eleve donne 404.
         */
        get: operations["getMyTest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/students/{sid}/progress": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Vue parent, lecture seule: avancement d'un eleve de la famille (contract-v1.4, H1; handler family-progress)
         * @description Reserve au parent. L'eleve doit etre de la famille du jeton, sinon **404** (pas 403: on ne revele pas l'existence d'un eleve d'une autre famille). Un eleve qui appelle recoit 403.
         *     Contenu: progression de jeu, une ligne par fiche (titre, matiere, pages, resultats des tests), tendance par semaine, scores par matiere, derniers tests. Jamais le texte d'un cours ni d'une question, jamais une reponse donnee ni la bonne reponse. Le resultat (juste ou faux) de chaque question se lit par `GET /students/{sid}/tests/{testId}`.
         */
        get: operations["getStudentProgress"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/students/{sid}/tests": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Vue parent, lecture seule: historique pagine des tests d'un eleve, sans detail par question (contract-v1.4, H1; handler family-progress)
         * @description Memes regles d'acces que `GET /students/{sid}/progress` (404 hors famille, 403 pour un eleve). Meme pagination et memes filtres que `GET /me/tests`. Renvoie des resumes `TestSummary` uniquement.
         */
        get: operations["listStudentTests"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/students/{sid}/tests/{testId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Vue parent, lecture seule: resultat de chaque question d'un passage, sans texte (contract-v1.4, H1; handler family-progress)
         * @description Memes regles d'acces que `GET /students/{sid}/progress` (404 hors famille ou passage inconnu, 403 pour un eleve).
         *     Chaque question est identifiee par son `questionId` et son `rank` (position dans la session) avec juste ou faux, essais et XP. **Ni texte de question, ni choix, ni reponse donnee, ni bonne reponse.**
         */
        get: operations["getStudentTest"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/students": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Le parent cree un eleve et recoit le lien d'activation (handler students-create, L3) */
        post: operations["createStudent"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/students/{sid}/activation-link": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Nouveau lien d'activation, mot de passe perdu (handler students-link, L3) */
        post: operations["createActivationLink"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/students/{sid}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        post?: never;
        /** Supprime l'eleve et ses donnees (handler students-delete, L3) */
        delete: operations["deleteStudent"];
        options?: never;
        head?: never;
        /** Suspend ou change le quota (handler students-update, L3) */
        patch: operations["updateStudent"];
        trace?: never;
    };
    "/family/dashboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Suivi parent (handler family-read, L3) */
        get: operations["getFamilyDashboard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/family/leaderboard": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Classement de la semaine (handler family-read, L3) */
        get: operations["getFamilyLeaderboard"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/reports/{id}/validate": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Le parent valide ou rejette un signalement (handler reports-validate, L3) */
        post: operations["validateReport"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/family/export": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /** Export complet des donnees de la famille - e-mail du parent, eleves (profil de jeu, jours actifs, tentatives), fiches (affirmations, sources, questions), signalements (handler family-admin, L3). Les cours conserves sont exportes SANS leur texte (structure et liens vers les fiches), l'eleve lit son texte par GET /cours/{coursId} (droit d'acces), le parent ne recoit jamais le texte des cours. Le texte brut lu sur les photos (7 jours) n'est pas exporte. */
        get: operations["exportFamily"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/export/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * L'eleve demande l'archive de TOUTES ses donnees, figures comprises (contract-v1.5.1, R1; handler me-export)
         * @description Reserve a l'eleve (un parent recoit 403: l'export du parent ne contient aucun contenu de cours). Pas de corps. La construction est **asynchrone**: la reponse est `202` avec un `exportId`, puis `GET /me/export/archive/{exportId}` donne l'etat et, quand l'archive est prete, un lien signe de 10 minutes.
         *     Contenu du zip: `export.json` (profil, dossiers, cours avec texte, blocs et sections, fiches avec affirmations, sources, resume, paragraphes et rappel), `tests/<studentId>.jsonl` (historique des tests AVEC les reponses donnees) et `figures/<coursId>/<figureId>.jpg`. Le zip est ecrit en flux et ne depasse pas 150 Mo de figures: au-dela, les cours les plus anciens perdent leurs images (le texte reste complet), `truncated` vaut vrai et `omittedCourses` donne leur nombre.
         *     Limite: 3 demandes par heure et par eleve (429 `quota_epuise`). La demande et son lien expirent apres 1 jour (`GET` renvoie alors 404); le fichier est supprime par la regle d'expiration du stockage (1 a 2 jours) et avec l'eleve.
         */
        post: operations["createMyExportArchive"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/me/export/archive/{exportId}": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        /**
         * Etat d'une archive de l'eleve; le lien signe est re-signe a chaque lecture (contract-v1.5.1, R1; handler me-export)
         * @description Eleve seulement, et seulement SES demandes (404 sinon, y compris pour l'`exportId` d'un autre eleve). `state`: `en_cours`, `pret` (avec `archive`) ou `echec` (relancer une demande).
         */
        get: operations["getMyExportArchive"];
        put?: never;
        post?: never;
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/family/export/archive": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Archive telechargeable de l'export, avec tout l'historique des tests (contract-v1.4, H1; handler family-export-archive)
         * @description Reserve au parent. Construit une archive **zip** et renvoie un **lien de telechargement court** (10 minutes). Contenu: `export.json` (meme forme que `GET /family/export`, mais `docs[].questions` ne garde que `questionId` et `kind`), et pour chaque eleve `tests/<studentId>.jsonl` (un passage par ligne, schema `TestParentDetail`, toutes les annees scolaires).
         *     Comme l'export JSON: **aucun texte de cours**, et ni texte de question, ni choix, ni bonne reponse. Les reponses donnees par l'eleve (`choice`) ne sont **pas** dans l'archive (l'eleve seul les lit dans l'application).
         *     Le lien ne porte aucune donnee: c'est une URL signee vers un fichier prive, valable 10 minutes. Le fichier est supprime par une regle d'expiration du stockage au plus tard 2 jours apres (et avec la famille).
         *     Limite: 3 archives par heure et par famille (429 `quota_epuise`). Borne: 50 000 passages au plus par archive (environ 9 ans pour 5 eleves a 3 passages par jour); au-dela, les annees scolaires les plus anciennes sont omises et `truncated` vaut vrai.
         */
        post: operations["createExportArchive"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/family/policy": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Le parent accepte la version en vigueur de la politique de confidentialite (contract-v1.4.1, handler family-create)
         * @description Reserve au parent qui a deja une famille. Meme corps que `POST /family`: `consent` vrai et `policyVersion` egale a la version en vigueur, sinon 400 `requete_invalide` « Consentement requis ». Enregistre la date et la version dans la famille. Repondre deux fois est sans effet (204). Un eleve recoit 403.
         */
        post: operations["acceptPolicy"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/family": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /** Premiere connexion d'un parent invite - cree la famille, pose famille_id et le groupe parent. Le jeton deja emis ne les contient pas, le front se reconnecte (handler family-create, L3). Exige le consentement explicite du parent a la politique de confidentialite (date et version enregistrees). */
        post: operations["createFamily"];
        /** Suppression complete de la famille (handler family-admin, L3) */
        delete: operations["deleteFamily"];
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
    "/admin/invitations": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
        put?: never;
        /**
         * Cree un code d'invitation parent a usage unique (handler admin-invitations, A1). Reserve aux comptes du groupe Cognito `admin`.
         * @description Autorisation cote serveur: le jeton doit porter le groupe `admin` (`cognito:groups`), sinon **403 `interdit`** (meme reponse pour un parent, un eleve ou un jeton sans groupe).
         *     Le code (128 bits, 32 caracteres hexadecimaux) n'est renvoye **qu'une fois**, dans cette reponse: seul son hache est stocke et il n'est jamais journalise.
         *     Limite: 20 codes par jour (UTC) et par administrateur, au-dela **429 `quota_epuise`**. Pas de corps de requete.
         */
        post: operations["createInvitation"];
        delete?: never;
        options?: never;
        head?: never;
        patch?: never;
        trace?: never;
    };
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            /**
             * @description `aucune_question` (409, ajoute en 1.7.0): `POST /practice/session` sans aucune question disponible. `cours_plein` (409, ajoute en 1.6.0): le cours depasserait 30 pages ou 20 sections; un client ancien lit le statut HTTP. `indisponible` (503, ajoute en 1.5.1): erreur de stockage reessayable, l'etat n'a pas change (confirmation avec figures). `dossier_nom_pris` (409) et `dossiers_limite` (400) ajoutes en 1.3 pour les dossiers; un client 1.2 qui ne les connait pas lit le statut HTTP.
             * @enum {string}
             */
            code: "requete_invalide" | "interdit" | "introuvable" | "etat_invalide" | "quota_epuise" | "budget_epuise" | "dossier_nom_pris" | "dossiers_limite" | "indisponible" | "cours_plein" | "aucune_question";
            message: string;
            /**
             * Format: date
             * @description Remise a zero du quota (1er du mois a Paris)
             */
            resetDate?: string;
        };
        /** @enum {string} */
        JobState: "en_attente_envoi" | "verification_fichier" | "transcription" | "a_confirmer" | "verification" | "generation" | "termine" | "rejete" | "echec" | "expire";
        Job: {
            jobId: string;
            state: components["schemas"]["JobState"];
            pages: number;
            /** Format: date-time */
            createdAt: string;
            durationSeconds?: number;
            /** @description Cout Bedrock du traitement en centimes d'euro (mesure */
            costCents?: number;
            /** @description Present quand state = termine */
            docId?: string;
            message?: string;
            status?: components["schemas"]["ScanStatus"];
            /** @description Fiches du scan, dans l'ordre des sections (v1.3). `docId` = la premiere. Present quand state = termine. */
            docIds?: string[];
            /** @description Facultatif (v1.6): cours auquel ce scan appartient. Pour un ajout de pages, le cours auquel on ajoute (present des la creation); pour un scan ordinaire, present apres la confirmation. */
            coursId?: string;
        };
        /**
         * @description Matiere (liste fermee). Libelles affiches: Maths, Physique-chimie, SVT, Histoire-geo, Francais, Autre. Les identifiants `physique` et `histoire_geo` sont ceux de la v1 (donnees existantes).
         * @enum {string}
         */
        Subject: "maths" | "physique" | "svt" | "histoire_geo" | "francais" | "autre";
        /** @description Sujet en texte libre court (ex. La Revolution francaise). Propose par la lecture du cours, modifiable par l'eleve. Espaces de debut et de fin retires; pas de balises. */
        Topic: string;
        /**
         * @description Etape du traitement, dans l'ordre. Correspondance avec `Job.state`: en_attente_envoi=envoi; verification_fichier et transcription=lecture; a_confirmer=a_confirmer;
         *     verification=fiche puis verification (le traitement ecrit l'etape fine; a defaut `verification`); generation=qcm; termine=termine; rejete, echec et expire=echec (le detail reste dans `Job.state`).
         * @enum {string}
         */
        ScanStage: "envoi" | "lecture" | "a_confirmer" | "fiche" | "verification" | "qcm" | "termine" | "echec";
        ScanStatus: {
            stage: components["schemas"]["ScanStage"];
            /** @description Pages recues (envoi) ou lues (lecture); egal a pagesTotal aux etapes suivantes */
            pagesDone: number;
            pagesTotal: number;
            /**
             * Format: date-time
             * @description Creation du scan
             */
            startedAt: string;
            /**
             * Format: date-time
             * @description Present aux etapes termine et echec
             */
            finishedAt?: string;
            /**
             * Format: date-time
             * @description A l'etape a_confirmer seulement: heure ou le scan expire (photo supprimee, pages rendues) si l'eleve ne confirme pas. Absent pour un scan cree avant 1.3.
             */
            expiresAt?: string;
            /** @description Vrai quand il reste 2 h ou moins avant `expiresAt` (calcule par le serveur). Present avec `expiresAt`. */
            expiresSoon?: boolean;
            /** @description Message lisible pour l'eleve, present a l'etape echec (ex. Le texte est trop court pour faire une fiche) */
            message?: string;
        };
        ScanSummary: {
            /** @description Etat precis du job (distingue rejete, echec, expire). Un job annule par l eleve n est pas liste. Une fiche dont le job a expire est `termine`. */
            state: components["schemas"]["JobState"];
            /** @description = jobId. Pour une fiche ancienne dont le job a expire: jobId de la fiche, ou docId si elle n'en a pas */
            scanId: string;
            studentId: string;
            /** @description Present quand la fiche existe (etape termine) */
            docId?: string;
            title?: string;
            subject?: components["schemas"]["Subject"];
            topic?: components["schemas"]["Topic"];
            folderId?: string;
            /** @description Pages du SCAN (pas de la fiche): un scan decoupe en 3 fiches repete la meme valeur sur chaque fiche; ne pas les additionner (regrouper par scanId). */
            pages: number;
            /** Format: date-time */
            createdAt: string;
            status: components["schemas"]["ScanStatus"];
            /** @description Cours complet conserve (v1.3), present des la confirmation */
            coursId?: string;
            /** @description Rang de la fiche dans son scan (0 = premiere). Un scan decoupe en plusieurs fiches donne UNE entree par fiche, avec le meme `scanId`, `sectionCount` et `docIds`; le client regroupe par `scanId`. Absent pour un scan en cours ou a une seule fiche ancienne. */
            sectionIndex?: number;
            /** @description Nombre de fiches du scan */
            sectionCount?: number;
            /** @description Toutes les fiches du scan (v1.3), dans l'ordre; `docId` est celle de cette entree */
            docIds?: string[];
        };
        ScanList: {
            items: components["schemas"]["ScanSummary"][];
            nextCursor?: string;
            /** @description Scans non termines ni en echec (tous, sans filtre): sert a savoir s'il faut continuer d'interroger */
            inProgress: number;
            /** @description Scans a l'etape a_confirmer (tous, sans filtre): « a relire », pour l'accueil */
            toReview: number;
            facets: {
                subjects: {
                    subject: components["schemas"]["Subject"];
                    count: number;
                }[];
                /** @description Sujets distincts (un seul libelle par sujet normalise), du plus frequent au moins frequent, 100 au plus */
                topics: {
                    topic: components["schemas"]["Topic"];
                    count: number;
                }[];
            };
        };
        /** @description Cours conserve SANS son texte: structure, sections et liens vers les fiches (c'est ce que contient l'export). */
        CoursMeta: {
            coursId: string;
            /** Format: date-time */
            createdAt: string;
            /** @description Pages du cours (30 au plus depuis la v1.6: un cours peut recevoir des ajouts de pages) */
            pages: number;
            /** @description Facultatif (v1.5): nombre de figures conservees. Les images ne sont jamais dans l'export parent. */
            figureCount?: number;
            /** @description 20 sections au plus depuis la v1.6 (6 par scan, plusieurs scans par cours). Les sections d'un ajout suivent celles du cours d'origine. */
            sections: {
                fromSentenceId: string;
                subject: components["schemas"]["Subject"];
                topic?: components["schemas"]["Topic"];
                title?: string;
                folderId?: string;
                /**
                 * @description fiche = une fiche existe (`docId`); ignoree = `ignore: true`; sans_fiche = aucune affirmation exploitable dans cette section; supprimee = la fiche a ete supprimee
                 * @enum {string}
                 */
                status: "fiche" | "ignoree" | "sans_fiche" | "supprimee";
                /** @description Present si status = fiche */
                docId?: string;
            }[];
        };
        /** @description Cours complet corrige, conserve jusqu'a suppression par l'eleve (le parent supprime par le compte de l'eleve) et avec le compte, comme les fiches. Contient le texte lu et corrige, jamais la photo. Lu par l'eleve seulement (`GET /cours/{coursId}`); l'export parent n'a que `CoursMeta`. */
        Cours: components["schemas"]["CoursMeta"] & {
            /** @description Une entree par page, triee numeriquement; meme forme que `Transcription.pages` */
            texts: {
                page: number;
                sentences: components["schemas"]["Sentence"][];
            }[];
            /** @description Facultatif (v1.5): mise en forme conservee. Absent pour un cours ancien: l'ecran affiche les phrases. */
            blocks?: components["schemas"]["Block"][];
            /** @description Facultatif (v1.5): figures conservees, avec `url` pre-signee de 5 minutes (eleve seulement). Supprimees avec le cours. */
            figures?: components["schemas"]["Figure"][];
            /** @description Facultatif (v1.5): resultat de la verification des sources, phrase par phrase, calcule a la lecture depuis les fiches liees (vide tant que la verification n'est pas finie; les fiches supprimees n'y figurent plus). */
            marks?: components["schemas"]["SentenceMark"][];
        };
        Folder: {
            folderId: string;
            name: string;
            /** Format: date-time */
            createdAt: string;
            scanCount: number;
        };
        FolderList: {
            items: components["schemas"]["Folder"][];
        };
        FolderNameRequest: {
            /** @description Espaces de debut et de fin retires; non vide apres retrait */
            name: string;
        };
        FolderScansRequest: {
            docIds: string[];
        };
        DocUpdateRequest: {
            subject?: components["schemas"]["Subject"];
            /** @description Sujet (voir Topic); null efface le sujet */
            topic?: string | null;
        };
        ConfirmSection: {
            /** @description Premiere phrase de la section (identifiant de `Transcription`, ex. p2-s3). La section va jusqu'a la phrase qui precede la section suivante. */
            fromSentenceId: string;
            subject: components["schemas"]["Subject"];
            topic?: components["schemas"]["Topic"];
            /** @description Titre de la fiche; a defaut, propose par l'extraction */
            title?: string;
            /** @description Dossier de la fiche (404 s'il n'existe pas) */
            folderId?: string;
            /** @description true: le texte est garde dans le cours, aucune fiche n'est creee (`subject` reste obligatoire pour l'uniformite, sans effet). */
            ignore?: boolean;
        };
        /** @description Decoupage propose par la lecture du cours (une proposition par section possible), modifiable par l'eleve. Meme sens que ConfirmSection. */
        SuggestedSection: {
            fromSentenceId: string;
            subject: components["schemas"]["Subject"];
            topic?: components["schemas"]["Topic"];
            title?: string;
        };
        ScanCreateRequest: {
            /** @description Nombre de pages de l'envoi (10 max). v1: une image = 1 page (PDF refuse, voir contentType) */
            pages: number;
            /**
             * @description v1: seules les images (image/jpeg, image/png) sont acceptees. application/pdf est refuse (400 requete_invalide) tant que la prise en charge des PDF n'existe pas. Pour des pages de types differents, voir `contentTypes`.
             * @enum {string}
             */
            contentType: "image/jpeg" | "image/png" | "application/pdf";
            /** @description Facultatif (v1.3): type de chaque page, dans l'ordre. Doit avoir exactement `pages` elements, sinon 400. S'il est absent, toutes les pages ont `contentType`. S'il est present, il prime sur `contentType`. */
            contentTypes?: ("image/jpeg" | "image/png")[];
            /** @description Facultatif (v1.3): dossier de l'eleve ou ranger la fiche une fois creee. Dossier inconnu: 404, avant toute reservation de page. */
            folderId?: string;
            /** @description Facultatif (v1.6): cours existant de l'eleve auquel ajouter ces pages. Les pages sont numerotees a la suite et donnent de nouvelles sections et fiches (un ajout est un scan ordinaire). Inconnu ou d'un autre eleve: 404, avant toute reservation. Un seul ajout ouvert par cours. */
            coursId?: string;
        };
        UploadTarget: {
            /** Format: uri */
            url: string;
            fields: {
                [key: string]: string;
            };
        };
        ScanCreateResponse: {
            jobId: string;
            /**
             * @deprecated
             * @description = uploads[0] (compatibilite v1.2). Un client v1.2 qui envoie plus d'une page n'a qu'une URL: son job expire et rend les pages.
             */
            upload: components["schemas"]["UploadTarget"];
            /** @description Une entree par page, dans l'ordre. Facultatif dans le schema pour que le contrat reste deployable avant le lot back FEAT-A; le client lit `uploads ?? [{ page: 1, ...upload }]`. Present dans toute reponse du lot back. La cle S3 de la page p est scans/<eleve>/<job>/<p-1> (fixee par l'URL: le client ne choisit pas la cle). */
            uploads?: (components["schemas"]["UploadTarget"] & {
                page: number;
            })[];
            /** Format: date-time */
            expiresAt: string;
            pagesRemaining: number;
        };
        Sentence: {
            /** @description Facultatif (v1.6), `Transcription` seulement (ajout de pages): identifiant de la derniere phrase du cours que cette phrase prolonge (la premiere ligne de l'ajout continue la derniere phrase du cours). La phrase du cours n'est jamais recollee ni reecrite. Absent sinon. */
            continuesId?: string;
            /** @description Facultatif (v1.5), reponse seulement (`Transcription`), ignore dans `ConfirmRequest.corrections` et absent de `Cours`. true: la lecture de cette phrase est douteuse (ecriture illisible, mot incertain); l'ecran de relecture la signale. C'est une confiance de LECTURE donnee par le modele: ce n'est PAS un resultat de verification des faits (qui n'existe qu'apres la confirmation, voir `Cours.marks`). Absent = pas de doute signale. */
            doubt?: boolean;
            /** @description `p<page de depart>-s<n>`: l'identifiant porte la PREMIERE page de la phrase, meme si elle se termine plus loin. */
            id: string;
            /** @description Texte de la phrase. Depuis la v1.5 il peut contenir du LaTeX: une formule dans une phrase est entouree de `$...$` (hors formule, `\$` pour un dollar litteral et `\\` pour un antislash litteral); dans un bloc `formule`, le texte est le LaTeX sans delimiteurs. Le serveur controle le LaTeX (longueur, accolades, commandes interdites comme href, url, input, def) et laisse en texte simple ce qui ne passe pas; le site l'affiche en MathML via KaTeX (trust: false). */
            text: string;
            /** @description Facultatif (v1.3). Pages d'origine d'une phrase recollee: une phrase coupee par un saut de page est UNE phrase, `pages: [2, 3]`. Pages consecutives, croissantes, la premiere = celle de l'id. Absent: la phrase tient sur la page de son id. La phrase n'est listee que sous sa premiere page dans `Transcription.pages`; la page suivante ne la repete pas. Dans `ConfirmRequest.corrections`, `pages` est ignore (seuls `id` et `text` comptent). */
            pages?: number[];
        };
        /** @description Bloc de mise en forme du cours (v1.5), au-dessus des phrases: les phrases (`Sentence`) restent l'unite des corrections, des coupes en sections, des retraits et des affirmations verifiees; un bloc ne fait que les REGROUPER dans l'ordre du document. Un bloc peut s'etendre sur deux pages (phrase recollee, ou paragraphe qui continue). */
        Block: {
            /** @description b1, b2... dans l'ordre du document */
            id: string;
            /**
             * @description titre: une phrase; paragraphe: une ou plusieurs phrases; liste: une phrase par element; formule: une phrase dont le texte est du LaTeX SANS delimiteurs (ex. `E = mc^{2}`); figure: aucune phrase, voir `figureId`
             * @enum {string}
             */
            kind: "titre" | "paragraphe" | "liste" | "formule" | "figure";
            /** @description Titre seulement: 1 = titre du cours, 2 = partie, 3 = sous-partie */
            level?: number;
            /** @description Liste seulement: numerotee (true) ou a puces (defaut false) */
            ordered?: boolean;
            /** @description Phrases du bloc, dans l'ordre. Absent pour une figure. */
            sentenceIds?: string[];
            /** @description Figure seulement */
            figureId?: string;
        };
        /** @description Cadre de la figure sur la page, en fractions de la largeur et de la hauteur (0 a 1), origine en haut a gauche */
        FigureBox: {
            x: number;
            y: number;
            w: number;
            h: number;
        };
        /** @description Schema, graphique, tableau, carte ou photo du cours (v1.5). Une figure est TOUJOURS une image (`url`): jamais de figure en texte seul. `alt` (description courte ecrite par le modele) est le texte alternatif pour l'accessibilite, pas un substitut de l'image. Si le cadre propose est faux et ne se corrige pas, l'image est la page entiere (`box` absent). La figure et son `alt` ne sont JAMAIS des affirmations: ils ne sont ni verifies ni utilises pour les questions. */
        Figure: {
            figureId: string;
            page: number;
            /** @enum {string} */
            kind: "schema" | "graphique" | "tableau" | "carte" | "photo" | "autre";
            alt: string;
            /** @description Legende ecrite sous la figure sur la page, recopiee, si elle existe */
            caption?: string;
            /** @description Absent: la figure est la page entiere (cadre introuvable) */
            box?: components["schemas"]["FigureBox"];
            /**
             * Format: uri
             * @description Image recadree (JPEG, 1200 px au plus), URL pre-signee de 5 minutes re-signee a chaque lecture.
             */
            url: string;
            /** Format: date-time */
            urlExpireAt?: string;
        };
        ConfirmFigure: {
            figureId: string;
            /** @description true: le recadrage est conserve avec le cours. false: il est supprime avec la photo. */
            keep: boolean;
            /** @description Texte alternatif corrige par l'eleve */
            alt?: string;
        };
        /** @description Resultat de verification le plus severe parmi les affirmations tirees de cette phrase (erreur > non_verifiable > verifiee). Une phrase sans affirmation factuelle n'a pas de marque. */
        SentenceMark: {
            sentenceId: string;
            /** @enum {string} */
            status: "verifiee" | "erreur" | "non_verifiable";
            docId: string;
            claimId: string;
        };
        FicheParagraph: {
            /** @description Intertitre facultatif */
            heading?: string;
            text: string;
            /** @description Affirmations (`Doc.claims`) sur lesquelles repose le paragraphe */
            claimIds?: string[];
        };
        RecallItem: {
            /** @enum {string} */
            kind: "date" | "formule" | "definition" | "nombre";
            /** @description Texte de l'affirmation citee, COPIE par le serveur (le modele ne choisit que `claimId` et `kind`), jamais reecrit. Depuis la v1.5 le texte peut contenir du LaTeX (`$...$`), controle par le serveur et rendu par le site (voir `Sentence.text`). */
            text: string;
            /** @description Affirmation d'ou vient l'element (`Doc.claims`) */
            claimId: string;
            /** @description true: l'affirmation est `verifiee`. false: elle est `non_verifiable` (reprise du cours, signalee comme telle). Une affirmation en `erreur` n'est jamais reprise. */
            verified: boolean;
        };
        /** @description Le scan est lu comme UN document (v1.3): pages lues dans l'ordre, avec le contexte des pages voisines; `docType`, `suggestedSubject` et `suggestedTopic` sont decides une seule fois sur l'ensemble; les phrases coupees entre deux pages sont recollees (`Sentence.pages`). `pages` est trie par numero de page croissant (numerique, jamais lexical) et contient une entree par page, meme sans phrase. */
        Transcription: {
            jobId: string;
            /**
             * @description Un seul type pour tout le scan
             * @enum {string}
             */
            docType: "cours" | "exercice" | "autre";
            pages: {
                page: number;
                sentences: components["schemas"]["Sentence"][];
            }[];
            suggestedSubject?: components["schemas"]["Subject"];
            suggestedTopic?: components["schemas"]["Topic"];
            /** @description Decoupage suggere (v1.3), au plus 6 sections; la premiere commence a la premiere phrase. Absent: pas de decoupage suggere (une seule section). */
            suggestedSections?: components["schemas"]["SuggestedSection"][];
            /** @description Facultatif (v1.6), ajout de pages seulement: les deux dernieres phrases du cours, en LECTURE SEULE (ni corrigees, ni retirees, ni coupees). Absent hors ajout. Les `pages` de la transcription ne contiennent que les nouvelles pages, numerotees a la suite du cours (cours de 4 pages, ajout de 2: pages 5 et 6). */
            context?: components["schemas"]["Sentence"][];
            /** @description Dans l'ordre des pages ENVOYEES (1 par page, la premiere est la photo de la premiere page de `pages`) */
            photoUrls: string[];
            /** Format: date-time */
            photoUrlsExpireAt: string;
            /** @description Facultatif (v1.5): mise en forme du document, dans l'ordre. Absent (job ancien): l'ecran retombe sur la liste de phrases de `pages`. Chaque phrase de `pages` est dans exactement un bloc. */
            blocks?: components["schemas"]["Block"][];
            /** @description Facultatif (v1.5): figures proposees par la lecture, 8 au plus par scan; l'eleve les confirme avec `ConfirmRequest.figures`. Les `url` de recadrage sont re-signees a chaque appel et expirent avec la photo. */
            figures?: components["schemas"]["Figure"][];
        };
        ConfirmRequest: {
            corrections: components["schemas"]["Sentence"][];
            /** @description Facultatif (v1.3): decoupage du texte en sections par sujet, dans l'ordre du texte (voir la route). Absent: une seule section. */
            sections?: components["schemas"]["ConfirmSection"][];
            subject?: components["schemas"]["Subject"];
            /** @description Un sujet vide apres nettoyage (espaces, chevrons, caracteres invisibles) repond 400 `requete_invalide`: le schema ne le detecte pas, le serveur le controle. */
            topic?: components["schemas"]["Topic"];
            /** @description Dossier de l'eleve (404 s'il n'existe pas); remplace celui de la creation */
            folderId?: string;
            /** @description Facultatif (v1.5): choix de l'eleve pour chaque figure proposee. Une figure absente de la liste n'est PAS conservee (par defaut, rien n'est garde). Un `figureId` inconnu: 400 `requete_invalide`. */
            figures?: components["schemas"]["ConfirmFigure"][];
            /** @description Facultatif (v1.5): phrases retirees du cours par l'eleve (bruit, remarque personnelle). Elles ne sont pas gardees dans le cours, ni extraites, ni verifiees. Une phrase retiree ne peut pas etre le `fromSentenceId` d'une section; une phrase inconnue: 400. Le seuil de 40 mots s'applique apres retrait. */
            removed?: string[];
        };
        DocSummary: {
            docId: string;
            title: string;
            subject: components["schemas"]["Subject"];
            /** Format: date-time */
            createdAt: string;
            topic?: components["schemas"]["Topic"];
            folderId?: string;
            /** @description Cours complet d'ou vient la fiche (v1.3); absent pour une fiche ancienne ou si le cours a ete supprime */
            coursId?: string;
            /** @description Taille de la banque de questions (v1.7): un nombre, jamais un contenu (visible aussi par le parent). Absent pour une fiche ancienne. */
            questionCount?: number;
            sectionIndex?: number;
        };
        DocList: {
            items: components["schemas"]["DocSummary"][];
        };
        Source: {
            passageId: string;
            /** Format: uri */
            url: string;
            site: string;
            titre: string;
            extrait: string;
            niveau: number;
        };
        Claim: {
            claimId: string;
            /** @description Texte de l'affirmation. Depuis la v1.5 le texte peut contenir du LaTeX (`$...$`), controle par le serveur et rendu par le site (voir `Sentence.text`). */
            text: string;
            /** @enum {string} */
            status: "verifiee" | "erreur" | "non_verifiable" | "non_factuelle";
            aRisque: boolean;
            /** @description Facultatif (v1.5): phrase du cours d'ou vient l'affirmation (celle de `Cours.texts` et `Cours.marks`). Absent pour une fiche ancienne ou si le cours a ete supprime. */
            sentenceId?: string;
            sources: components["schemas"]["Source"][];
        };
        Doc: components["schemas"]["DocSummary"] & {
            /** @description Texte continu de la fiche. Depuis la v1.5 il reprend `body` (paragraphes separes par une ligne vide, sans le rappel): un client 1.4 continue de fonctionner. */
            summary: string;
            claims: components["schemas"]["Claim"][];
            /** @description Facultatif (v1.5): la fiche en plusieurs paragraphes. Absent pour une fiche ancienne (un seul bloc `summary`). */
            body?: components["schemas"]["FicheParagraph"][];
            /** @description Facultatif (v1.5): rappel final des elements importants (dates, formules, definitions, nombres). Vide ou absent s'il n'y en a pas. */
            recall?: components["schemas"]["RecallItem"][];
            /** @description Facultatif (v1.5): figures du cours utiles a la fiche, avec `url` pre-signee. Absentes si le cours a ete supprime (les figures partent avec lui). Eleve seulement. */
            figures?: components["schemas"]["Figure"][];
        };
        ReportRequest: {
            claimId?: string;
            comment: string;
        };
        ReportValidateRequest: {
            /** @enum {string} */
            decision: "valide" | "rejete";
        };
        Report: {
            reportId: string;
            docId?: string;
            claimId?: string;
            /** @enum {string} */
            status: "ouvert" | "valide" | "rejete";
        };
        /** @description Jamais de cle de reponse dans une question (test L3/L4). */
        Question: {
            questionId: string;
            /** @enum {string} */
            kind: "qcm" | "gap";
            /** @description Enonce. Depuis la v1.5 le texte peut contenir du LaTeX (`$...$`), controle par le serveur et rendu par le site (voir `Sentence.text`). */
            prompt: string;
            /** @description Choix; ils peuvent contenir du LaTeX comme l'enonce. */
            choices?: string[];
            /** @description Fiche d'origine (v1.7), seulement pour un test sur plusieurs fiches */
            docId?: string;
            /** @description Titre de la fiche d'origine (v1.7), seulement pour un test sur plusieurs fiches */
            docTitle?: string;
        };
        Session: {
            docId: string;
            questions: components["schemas"]["Question"][];
            /** @description Questions distinctes utilisables dans la banque (v1.7), hors questions proches */
            available?: number;
            /** @description Vrai si le test est plus court que demande (v1.7) */
            short?: boolean;
            /** @description Points encore gagnables sur la fiche (v1.7): 50 au plus par fiche, pour toute la vie de la fiche */
            xpRemaining?: number;
        };
        /** @description Exactement un de `docIds` ou `folderId`. */
        PracticeRequest: {
            docIds?: string[];
            folderId?: string;
            /**
             * @default 10
             * @enum {integer}
             */
            size: 5 | 10 | 15 | 20;
        };
        PracticeSession: {
            /** @enum {string} */
            scope: "fiches" | "dossier";
            title: string;
            /** @description Fiches reellement interrogees, dans l'ordre */
            docIds: string[];
            questions: components["schemas"]["Question"][];
            available: number;
            short: boolean;
            /** @description Points encore gagnables par fiche (50 au plus par fiche) */
            xpRemaining?: {
                docId: string;
                xpRemaining: number;
            }[];
            skipped: {
                docId: string;
                /** @description Seulement pour une fiche de l'eleve (jamais pour un identifiant inconnu ou d'un autre eleve) */
                title?: string;
                /** @enum {string} */
                reason: "sans_question" | "introuvable";
            }[];
        };
        AnswerRequest: {
            questionId: string;
            choice: string;
        };
        Progress: {
            xp: number;
            level: number;
            streakDays: number;
            freezes: number;
            stage: number;
            pagesRemaining: number;
            pagesLimit: number;
            /** Format: date */
            resetDate: string;
            /** @description Identifiants de badges obtenus; catalogue dans docs/game-rules.md */
            badges?: string[];
        };
        ReadResult: {
            xpGained: number;
            badges: string[];
            progress: components["schemas"]["Progress"];
        };
        ActivationRequest: {
            token: string;
            password: string;
        };
        AnswerResult: {
            correct: boolean;
            /** @description Revele seulement apres la reponse */
            correctAnswer?: string;
            xpGained: number;
            /** @description Vrai si la reponse aurait rapporte des points mais la fiche a atteint 50 XP (v1.7); `xpGained` vaut alors 0 pour cette part */
            capped?: boolean;
            badges: string[];
            progress: components["schemas"]["Progress"];
        };
        Me: {
            userId: string;
            /** @enum {string} */
            role: "parent" | "eleve";
            familyId: string;
            /** @description Present pour le role eleve */
            studentId?: string;
            pseudo?: string;
            /** @description Parent seulement (contract-v1.4.1). Vrai si la famille a donne son consentement sur une autre version de la politique que celle en vigueur: le front demande alors de la relire et de l'accepter (POST /family/policy). Absent pour un eleve. */
            policyOutdated?: boolean;
        };
        Student: {
            studentId: string;
            /** @description Pseudo avec suffixe aleatoire (Lila-7k2f) */
            pseudo: string;
            /** @enum {string} */
            schoolLevel: "seconde" | "premiere" | "terminale";
            under15: boolean;
            /** @enum {string} */
            status: "actif" | "suspendu";
            /** @description Plafond reel = plafond de la famille de l environnement (50 en prod, 500 en dev), verifie par le serveur */
            pageQuota: number;
        };
        StudentCreateRequest: {
            /** @description Sans nom de famille */
            pseudo: string;
            /** @enum {string} */
            schoolLevel: "seconde" | "premiere" | "terminale";
            under15: boolean;
            /**
             * @description Case cochee par le parent (autorite parentale et lecture de la politique)
             * @constant
             */
            parentalAuthority: true;
            policyVersion: components["schemas"]["PolicyVersion"];
        };
        /** @description Version de la politique affichee au parent. Refusee si ce n'est pas la version en vigueur. */
        PolicyVersion: string;
        FamilyCreateRequest: {
            /** @constant */
            consent: true;
            policyVersion: components["schemas"]["PolicyVersion"];
        };
        InvitationCreated: {
            /** @description Code d'invitation en clair */
            code: string;
            /** Format: date-time */
            createdAt: string;
            /** @description Codes restants aujourd'hui pour cet administrateur. */
            remainingToday: number;
        };
        ActivationLink: {
            /** Format: uri */
            url: string;
            /** Format: date-time */
            expiresAt: string;
        };
        StudentCreateResponse: {
            student: components["schemas"]["Student"];
            activationLink: components["schemas"]["ActivationLink"];
        };
        /** @description Le pseudo et under15 ne se modifient pas (supprimer puis recreer l'eleve). */
        StudentUpdateRequest: {
            /** @enum {string} */
            status?: "actif" | "suspendu";
            /** @description Plafond reel = plafond de la famille de l environnement (50 en prod, 500 en dev), verifie par le serveur */
            pageQuota?: number;
            /** @enum {string} */
            schoolLevel?: "seconde" | "premiere" | "terminale";
        };
        Dashboard: {
            students: {
                student: components["schemas"]["Student"];
                progress: components["schemas"]["Progress"];
            }[];
            familyPagesRemaining: number;
            familyPagesLimit: number;
        };
        Leaderboard: {
            week: string;
            entries: {
                studentId: string;
                pseudo: string;
                xp: number;
                activeDays: number;
            }[];
        };
        FamilyExport: {
            familyId: string;
            /** Format: date-time */
            exportedAt: string;
            parentEmail?: string;
            consentement?: components["schemas"]["Consent"];
            students: components["schemas"]["StudentExport"][];
            docs: components["schemas"]["DocExport"][];
            reports: components["schemas"]["ReportExport"][];
        };
        Consent: {
            /** Format: date-time */
            consentementLe?: string;
            versionPolitique?: string;
        };
        StudentExport: components["schemas"]["Student"] & {
            consentement?: components["schemas"]["Consent"];
            createdAt?: string;
            /** @description Dossiers de l'eleve (v1.3) */
            folders?: components["schemas"]["Folder"][];
            /** @description Cours conserves (v1.3), SANS le texte (structure, sections, liens vers les fiches). Le texte se lit par GET /cours (eleve). */
            cours?: components["schemas"]["CoursMeta"][];
            /** @description Profil de jeu (XP, serie, badges, signalements valides) */
            profile: {
                [key: string]: unknown;
            };
            /** @description Jours (Paris) ou l'eleve a joue */
            activeDays: string[];
            /** @description Nombre de passages de test conserves (v1.4). Le detail est dans l'archive `POST /family/export/archive`. */
            testsCount?: number;
            attempts: {
                questionId: string;
                date: string;
                attempts: number;
            }[];
        };
        /** @description Un passage de test. `scorePct` = round(100 x correct / total); `total` = questions de la session ouverte, meme non repondues. */
        TestSummary: {
            testId: string;
            docId: string;
            /** @description Titre de la fiche au moment du test (copie courte, supprimee avec la fiche) */
            titre: string;
            matiere: string;
            /** @description Valeurs connues: `mixte`, `qcm`, `gap`. Un client traite une valeur inconnue comme `autre` (des modes s'ajouteront, par exemple le tirage de l'issue #42). */
            mode: string;
            /** @description Annee scolaire de `startedAt` (Europe/Paris): du 1er septembre au 31 aout. Septembre a decembre de l'annee Y donne `Y-(Y+1)`, janvier a aout de l'annee Y donne `(Y-1)-Y`. Calculee a l'ecriture, jamais modifiee. */
            schoolYear: string;
            /**
             * Format: date-time
             * @description Ouverture de la session
             */
            startedAt: string;
            /**
             * Format: date-time
             * @description Derniere reponse du passage (absent si aucune)
             */
            endedAt?: string;
            total: number;
            answered: number;
            /** @description Questions finalement justes */
            correct: number;
            /** @description Questions justes du premier coup */
            firstTry: number;
            scorePct: number;
            xpGained: number;
            /**
             * @description `complet` quand `answered` = `total`
             * @enum {string}
             */
            status: "complet" | "incomplet";
            /**
             * @description Q1 (v1.7): absent ou `fiche` = une seule fiche. `titre` est alors le titre de la fiche, le nom du dossier ou `N fiches` (copie; pour un passage multi-fiches, seules les lignes de la fiche supprimee partent).
             * @enum {string}
             */
            scope?: "fiche" | "fiches" | "dossier";
            /** @description Fiches interrogees (v1.7); `docId` reste la premiere */
            docIds?: string[];
        };
        /** @description Resultat d'une question dans un passage, sans aucun texte. */
        TestQuestionStatus: {
            questionId: string;
            /** @description Position de la question dans la session */
            rank: number;
            /** @enum {string} */
            kind: "qcm" | "gap";
            correct: boolean;
            attempts: number;
            firstTry: boolean;
            xpGained: number;
            /** Format: date-time */
            answeredAt: string;
        };
        TestQuestionResult: components["schemas"]["TestQuestionStatus"] & {
            /** @description Derniere reponse donnee par l'eleve. Visible de l'eleve seul. */
            choice?: string;
        };
        TestDetail: components["schemas"]["TestSummary"] & {
            questions: (components["schemas"]["TestQuestionResult"] & {
                /** @description Relu dans la fiche (absent si la question n'existe plus) */
                prompt?: string;
                choices?: string[];
                /** @description Present seulement si la question est terminee */
                correctAnswer?: string;
            })[];
        };
        TestPage: {
            items: components["schemas"]["TestSummary"][];
            /** @description Absent sur la derniere page */
            nextCursor?: string;
            /** @description Annees scolaires ayant des passages, la plus recente d'abord. Present sur la premiere page seulement. */
            schoolYears?: string[];
        };
        /** @description Passage vu par le parent et ecrit dans l'archive: resultat par question, sans texte ni reponse donnee. */
        TestParentDetail: components["schemas"]["TestSummary"] & {
            questions: components["schemas"]["TestQuestionStatus"][];
        };
        ExportArchive: {
            /**
             * Format: uri
             * @description Lien signe
             */
            url: string;
            /** Format: date-time */
            expiresAt: string;
            /** @enum {string} */
            format: "zip";
            sizeBytes: number;
            students: number;
            tests: number;
            truncated: boolean;
            /** @description Facultatif (v1.5, archive de l'eleve): nombre de cours dans l'archive */
            courses?: number;
            /** @description Facultatif (v1.5, archive de l'eleve): nombre de figures (fichiers JPEG) dans l'archive */
            figures?: number;
            /** @description Facultatif (v1.5.1, archive de l'eleve): cours les plus anciens dont les figures ont ete omises pour tenir dans 150 Mo (leur texte est dans l'archive). `truncated` vaut alors vrai. */
            omittedCourses?: number;
        };
        /** @description Demande d'archive de l'eleve (v1.5.1). `archive` est present quand `state` vaut `pret`. */
        ExportStatus: {
            exportId: string;
            /** @enum {string} */
            state: "en_cours" | "pret" | "echec";
            archive?: components["schemas"]["ExportArchive"];
        };
        DocProgress: {
            docId: string;
            titre: string;
            matiere: string;
            sujet?: string;
            pages: number;
            /** Format: date-time */
            createdAt: string;
            tests: number;
            bestScorePct?: number;
            lastScorePct?: number;
            /** Format: date-time */
            lastTestAt?: string;
        };
        /** @description Scan en cours ou recent: etape et nombre de pages seulement. */
        ScanProgress: {
            scanId: string;
            /** @description Etape du traitement, meme vocabulaire que `status` de GET /scans */
            stage: string;
            pages: number;
            /** Format: date-time */
            createdAt: string;
        };
        WeekStat: {
            week: string;
            tests: number;
            avgScorePct: number;
            activeDays: number;
        };
        SubjectStat: {
            matiere: string;
            tests: number;
            avgScorePct: number;
        };
        StudentProgressView: {
            student: components["schemas"]["Student"];
            progress: components["schemas"]["Progress"];
            /** @description Fiches les plus recentes d'abord */
            docs: components["schemas"]["DocProgress"][];
            scans: components["schemas"]["ScanProgress"][];
            /** @description Douze dernieres semaines, la plus recente d'abord */
            weeks: components["schemas"]["WeekStat"][];
            subjects: components["schemas"]["SubjectStat"][];
            /** @description Annees scolaires ayant des passages, la plus recente d'abord */
            schoolYears: string[];
            recentTests: components["schemas"]["TestSummary"][];
        };
        ExportQuestion: {
            questionId: string;
            /** @enum {string} */
            kind: "qcm" | "gap";
            prompt: string;
            choices?: string[];
            answer: string;
        };
        DocExport: components["schemas"]["DocSummary"] & {
            studentId: string;
            summary: string;
            claims: components["schemas"]["Claim"][];
            questions: components["schemas"]["ExportQuestion"][];
        };
        ReportExport: {
            reportId: string;
            docId: string;
            claimId?: string;
            studentId?: string;
            comment: string;
            /** @enum {string} */
            status: "ouvert" | "valide" | "rejete";
            createdAt: string;
        };
    };
    responses: {
        /** @description Requete invalide */
        BadRequest: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "code": "requete_invalide",
                 *       "message": "Champ manquant"
                 *     }
                 */
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Role insuffisant */
        Forbidden: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "code": "interdit",
                 *       "message": "Reserve au parent"
                 *     }
                 */
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Introuvable */
        NotFound: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "code": "introuvable",
                 *       "message": "Introuvable"
                 *     }
                 */
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description Limite de debit de la route depassee (la limite est globale a la route, voir infra). Le client reessaie apres quelques secondes, en espacant son interrogation. Corps produit par API Gateway, pas par le contrat Error. */
        TooManyRequests: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "message": "Too Many Requests"
                 *     }
                 */
                "application/json": {
                    message?: string;
                };
            };
        };
        /** @description Etat incompatible */
        Conflict: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "code": "etat_invalide",
                 *       "message": "Le job n'est pas a confirmer"
                 *     }
                 */
                "application/json": components["schemas"]["Error"];
            };
        };
        /** @description quota_epuise (pages du mois) ou budget_epuise (compteur de cout: seuils mensuels 15/18 EUR en prod, 95/100 EUR en dev; en dev, plafond d'essais cumule DEV_TRIAL_CAP_EUR = 100 EUR) */
        QuotaExceeded: {
            headers: {
                [name: string]: unknown;
            };
            content: {
                /**
                 * @example {
                 *       "code": "quota_epuise",
                 *       "message": "Quota de pages epuise",
                 *       "resetDate": "2027-01-01"
                 *     }
                 */
                "application/json": components["schemas"]["Error"];
            };
        };
    };
    parameters: {
        ScanId: string;
        JobId: string;
        DocId: string;
        CoursId: string;
        FolderId: string;
        TestId: string;
        /** @description Annee scolaire (1er septembre au 31 aout, Europe/Paris), ex. 2026-2027 */
        SchoolYear: string;
        TestLimit: number;
        /** @description Curseur opaque renvoye par la page precedente (`nextCursor`) */
        TestCursor: string;
        StudentId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
    listScans: {
        parameters: {
            query?: {
                /** @description Parent seulement: un eleve de la famille. Un eleve qui passe un identifiant, le sien excepte, recoit 404 (comme un parent dont l'eleve n'est pas de sa famille: jamais de 403 qui confirmerait l'existence). */
                studentId?: string;
                /** @description Matiere, ou `none` pour les scans sans matiere (job en cours de lecture) */
                subject?: "maths" | "physique" | "svt" | "histoire_geo" | "francais" | "autre" | "none";
                /** @description Sujet, comparaison sans casse ni accents (egalite exacte apres normalisation) */
                topic?: string;
                /** @description Un dossier de l'eleve, ou `none` pour les scans hors dossier. Un dossier inconnu (ou d'un autre eleve) repond 404. */
                folderId?: string;
                /** @description `en_cours` = tout ce qui n'est pas termine ni en echec (y compris `a_confirmer`) */
                status?: "en_cours" | "a_confirmer" | "termine" | "echec";
                /** @description Tri principal (defaut `date`). `subject` puis `topic` puis date; `topic` puis date; `status` = ordre des etapes. Les valeurs absentes passent en dernier. */
                sort?: "date" | "subject" | "topic" | "status";
                /** @description Sens du tri principal. Defaut selon `sort`: `desc` pour `date` et `status`, `asc` pour `subject` et `topic`. A egalite, la date decroissante departage toujours. */
                order?: "asc" | "desc";
                limit?: number;
                /** @description Valeur opaque `nextCursor` de la page precedente. Valable seulement avec les memes filtres et le meme tri; sinon la page peut avoir des doublons ou des trous. Un curseur invalide repond 400. */
                cursor?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Scans */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "scanId": "01JEXAMPLE0JOB0000000000AA",
                     *           "studentId": "01JEXAMPLE0STU0000000000AA",
                     *           "state": "termine",
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "title": "La Revolution francaise",
                     *           "subject": "histoire_geo",
                     *           "topic": "La Revolution francaise",
                     *           "folderId": "01JEXAMPLE0FLD0000000000AA",
                     *           "pages": 2,
                     *           "createdAt": "2026-12-01T10:00:00Z",
                     *           "status": {
                     *             "stage": "termine",
                     *             "pagesDone": 2,
                     *             "pagesTotal": 2,
                     *             "startedAt": "2026-12-01T10:00:00Z",
                     *             "finishedAt": "2026-12-01T10:03:00Z"
                     *           }
                     *         },
                     *         {
                     *           "scanId": "01JEXAMPLE0JOB0000000000AB",
                     *           "studentId": "01JEXAMPLE0STU0000000000AA",
                     *           "state": "transcription",
                     *           "pages": 3,
                     *           "createdAt": "2026-12-01T11:00:00Z",
                     *           "status": {
                     *             "stage": "lecture",
                     *             "pagesDone": 1,
                     *             "pagesTotal": 3,
                     *             "startedAt": "2026-12-01T11:00:00Z"
                     *           }
                     *         },
                     *         {
                     *           "scanId": "01JEXAMPLE0JOB0000000000AC",
                     *           "studentId": "01JEXAMPLE0STU0000000000AA",
                     *           "state": "a_confirmer",
                     *           "subject": "svt",
                     *           "topic": "La photosynthese",
                     *           "pages": 1,
                     *           "createdAt": "2026-12-01T09:00:00Z",
                     *           "status": {
                     *             "stage": "a_confirmer",
                     *             "pagesDone": 1,
                     *             "pagesTotal": 1,
                     *             "startedAt": "2026-12-01T09:00:00Z",
                     *             "expiresAt": "2026-12-01T21:00:00Z",
                     *             "expiresSoon": false
                     *           }
                     *         }
                     *       ],
                     *       "inProgress": 2,
                     *       "toReview": 1,
                     *       "facets": {
                     *         "subjects": [
                     *           {
                     *             "subject": "histoire_geo",
                     *             "count": 1
                     *           }
                     *         ],
                     *         "topics": [
                     *           {
                     *             "topic": "La Revolution francaise",
                     *             "count": 1
                     *           }
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ScanList"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            429: components["responses"]["TooManyRequests"];
        };
    };
    createScan: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "pages": 2,
                 *       "contentType": "image/jpeg",
                 *       "contentTypes": [
                 *         "image/jpeg",
                 *         "image/png"
                 *       ],
                 *       "folderId": "01JEXAMPLE0FLD0000000000AA",
                 *       "coursId": "01JEXAMPLE0CRS0000000000AA"
                 *     }
                 */
                "application/json": components["schemas"]["ScanCreateRequest"];
            };
        };
        responses: {
            /**
             * @description Job cree. **Une page = une photo = une URL pre-signee** (`uploads`, dans l'ordre des pages). Les `pages` sont reservees toutes ensemble
             *     (tout ou rien, `429` sinon) et rendues si le job echoue, est annule ou expire. Le traitement demarre quand les `pages` fichiers sont arrives.
             */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jobId": "01JEXAMPLE0JOB0000000000AA",
                     *       "upload": {
                     *         "url": "https://qcm-dev-scans.s3.eu-west-3.amazonaws.com/",
                     *         "fields": {
                     *           "key": "scans/01JEXAMPLE0STU0000000000AA/01JEXAMPLE0JOB0000000000AA/0",
                     *           "Content-Type": "image/jpeg"
                     *         }
                     *       },
                     *       "uploads": [
                     *         {
                     *           "page": 1,
                     *           "url": "https://qcm-dev-scans.s3.eu-west-3.amazonaws.com/",
                     *           "fields": {
                     *             "key": "scans/01JEXAMPLE0STU0000000000AA/01JEXAMPLE0JOB0000000000AA/0",
                     *             "Content-Type": "image/jpeg"
                     *           }
                     *         },
                     *         {
                     *           "page": 2,
                     *           "url": "https://qcm-dev-scans.s3.eu-west-3.amazonaws.com/",
                     *           "fields": {
                     *             "key": "scans/01JEXAMPLE0STU0000000000AA/01JEXAMPLE0JOB0000000000AA/1",
                     *             "Content-Type": "image/png"
                     *           }
                     *         }
                     *       ],
                     *       "expiresAt": "2026-12-01T10:15:00Z",
                     *       "pagesRemaining": 16
                     *     }
                     */
                    "application/json": components["schemas"]["ScanCreateResponse"];
                };
            };
            /**
             * @description Requete invalide. **PDF refuse en v1**: `contentType: application/pdf` (valeur encore listee dans l'enum, reservee a une version suivante) repond 400 `requete_invalide`
             *     AVANT toute reservation de page ni creation de job; le client doit envoyer des photos (image/jpeg ou image/png, une demande par envoi).
             */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Ajout de pages (`coursId`) impossible, AVANT toute reservation de page. `etat_invalide`: le cours est encore en cours de creation, ou un autre ajout est ouvert (il dure jusqu'a la confirmation ou l'annulation, 12 h au plus). `cours_plein` (v1.6): le cours depasserait 30 pages, ou a deja 20 sections. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            429: components["responses"]["QuotaExceeded"];
        };
    };
    deleteScan: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                scanId: components["parameters"]["ScanId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprime */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    getJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: components["parameters"]["JobId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Etat du job */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jobId": "01JEXAMPLE0JOB0000000000AA",
                     *       "state": "transcription",
                     *       "pages": 2,
                     *       "createdAt": "2026-12-01T10:00:00Z",
                     *       "status": {
                     *         "stage": "lecture",
                     *         "pagesDone": 1,
                     *         "pagesTotal": 2,
                     *         "startedAt": "2026-12-01T10:00:00Z"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["Job"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    getTranscription: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: components["parameters"]["JobId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Transcription a confirmer */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jobId": "01JEXAMPLE0JOB0000000000AA",
                     *       "docType": "cours",
                     *       "pages": [
                     *         {
                     *           "page": 1,
                     *           "sentences": [
                     *             {
                     *               "id": "p1-s1",
                     *               "text": "La photosynthese produit du dioxygene."
                     *             },
                     *             {
                     *               "id": "p1-s2",
                     *               "doubt": true,
                     *               "text": "Les plantes vertes utilisent la lumiere du soleil pour fabriquer leur matiere a partir du gaz carbonique de l'air.",
                     *               "pages": [
                     *                 1,
                     *                 2
                     *               ]
                     *             }
                     *           ]
                     *         },
                     *         {
                     *           "page": 2,
                     *           "sentences": [
                     *             {
                     *               "id": "p2-s2",
                     *               "text": "Ce phenomene a lieu dans les chloroplastes."
                     *             }
                     *           ]
                     *         }
                     *       ],
                     *       "suggestedSubject": "svt",
                     *       "suggestedTopic": "La photosynthese",
                     *       "blocks": [
                     *         {
                     *           "id": "b1",
                     *           "kind": "titre",
                     *           "level": 1,
                     *           "sentenceIds": [
                     *             "p1-s1"
                     *           ]
                     *         },
                     *         {
                     *           "id": "b2",
                     *           "kind": "paragraphe",
                     *           "sentenceIds": [
                     *             "p1-s2",
                     *             "p2-s2"
                     *           ]
                     *         },
                     *         {
                     *           "id": "b3",
                     *           "kind": "figure",
                     *           "figureId": "f1"
                     *         }
                     *       ],
                     *       "figures": [
                     *         {
                     *           "figureId": "f1",
                     *           "page": 2,
                     *           "kind": "schema",
                     *           "alt": "Schema d'une feuille avec les entrees de lumiere et de gaz carbonique",
                     *           "caption": "Fig. 1 La feuille",
                     *           "box": {
                     *             "x": 0.1,
                     *             "y": 0.4,
                     *             "w": 0.8,
                     *             "h": 0.35
                     *           },
                     *           "url": "https://qcm-dev-scans.s3.eu-west-3.amazonaws.com/scans/x/fig/f1.jpg?X-Amz-Signature=example"
                     *         }
                     *       ],
                     *       "photoUrls": [
                     *         "https://qcm-dev-scans.s3.eu-west-3.amazonaws.com/scans/x/0?X-Amz-Signature=example"
                     *       ],
                     *       "photoUrlsExpireAt": "2026-12-01T10:05:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Transcription"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    confirmJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: components["parameters"]["JobId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "corrections": [],
                 *       "figures": [
                 *         {
                 *           "figureId": "f1",
                 *           "keep": true
                 *         }
                 *       ],
                 *       "removed": [
                 *         "p2-s9"
                 *       ],
                 *       "sections": [
                 *         {
                 *           "fromSentenceId": "p1-s1",
                 *           "subject": "svt",
                 *           "topic": "La photosynthese",
                 *           "title": "La photosynthese"
                 *         },
                 *         {
                 *           "fromSentenceId": "p2-s2",
                 *           "subject": "histoire_geo",
                 *           "topic": "La Revolution francaise",
                 *           "folderId": "01JEXAMPLE0FLD0000000000AA"
                 *         }
                 *       ]
                 *     }
                 */
                "application/json": components["schemas"]["ConfirmRequest"];
            };
        };
        responses: {
            /** @description Job repris */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jobId": "01JEXAMPLE0JOB0000000000AA",
                     *       "state": "verification",
                     *       "pages": 2,
                     *       "createdAt": "2026-12-01T10:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["Job"];
                };
            };
            /** @description Demande invalide. Cas propres aux sections: phrase inconnue, coupes pas dans l'ordre ou en double, premiere section pas au debut, plus de 6 sections, aucune section non ignoree, `sections` avec `subject`/`topic`/`folderId`, `topic` ou `title` vide apres nettoyage. */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
            /** @description Erreur de stockage pendant la copie des figures gardees (`indisponible`, v1.5.1): rien n'a change, l'eleve renvoie la meme confirmation. */
            503: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "indisponible",
                     *       "message": "Service momentanément indisponible",
                     *       "réessaie": null
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    cancelJob: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                jobId: components["parameters"]["JobId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Job annule */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "jobId": "01JEXAMPLE0JOB0000000000AA",
                     *       "state": "rejete",
                     *       "pages": 2,
                     *       "createdAt": "2026-12-01T10:00:00Z",
                     *       "message": "Annulé par l'élève"
                     *     }
                     */
                    "application/json": components["schemas"]["Job"];
                };
            };
            404: components["responses"]["NotFound"];
            409: components["responses"]["Conflict"];
        };
    };
    listDocs: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fiches */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "title": "La photosynthese",
                     *           "subject": "svt",
                     *           "createdAt": "2026-12-01T10:03:00Z",
                     *           "topic": "La photosynthese",
                     *           "folderId": "01JEXAMPLE0FLD0000000000AA"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["DocList"];
                };
            };
        };
    };
    getDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Fiche */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "docId": "01JEXAMPLE0DOC0000000000AA",
                     *       "title": "La photosynthese",
                     *       "subject": "svt",
                     *       "createdAt": "2026-12-01T10:03:00Z",
                     *       "summary": "Les plantes fabriquent leur matiere avec la lumiere.",
                     *       "body": [
                     *         {
                     *           "heading": "Le principe",
                     *           "text": "Les plantes fabriquent leur matiere avec la lumiere.",
                     *           "claimIds": [
                     *             "01"
                     *           ]
                     *         }
                     *       ],
                     *       "recall": [
                     *         {
                     *           "kind": "definition",
                     *           "text": "La photosynthese produit du dioxygene.",
                     *           "claimId": "01",
                     *           "verified": true
                     *         }
                     *       ],
                     *       "claims": [
                     *         {
                     *           "claimId": "01",
                     *           "text": "La photosynthese produit du dioxygene.",
                     *           "status": "verifiee",
                     *           "aRisque": false,
                     *           "sentenceId": "p1-s1",
                     *           "sources": [
                     *             {
                     *               "passageId": "4f2a9c",
                     *               "url": "https://fr.wikipedia.org/wiki/Photosynth%C3%A8se",
                     *               "site": "fr.wikipedia.org",
                     *               "titre": "Photosynthese",
                     *               "extrait": "La photosynthese libere du dioxygene.",
                     *               "niveau": 2
                     *             }
                     *           ]
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Doc"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    deleteDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprimee */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            404: components["responses"]["NotFound"];
        };
    };
    updateDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "subject": "histoire_geo",
                 *       "topic": "La Revolution francaise"
                 *     }
                 */
                "application/json": components["schemas"]["DocUpdateRequest"];
            };
        };
        responses: {
            /** @description Fiche mise a jour */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "docId": "01JEXAMPLE0DOC0000000000AA",
                     *       "title": "La Revolution francaise",
                     *       "subject": "histoire_geo",
                     *       "createdAt": "2026-12-01T10:03:00Z",
                     *       "topic": "La Revolution francaise"
                     *     }
                     */
                    "application/json": components["schemas"]["DocSummary"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    reportDoc: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "claimId": "01",
                 *       "comment": "La date est fausse."
                 *     }
                 */
                "application/json": components["schemas"]["ReportRequest"];
            };
        };
        responses: {
            /** @description Signalement cree */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "reportId": "01JEXAMPLE0RPT0000000000AA",
                     *       "status": "ouvert"
                     *     }
                     */
                    "application/json": components["schemas"]["Report"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    markDocRead: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description XP de lecture accorde (ou 0 si deja pris ce jour) */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "xpGained": 10,
                     *       "badges": [],
                     *       "progress": {
                     *         "xp": 120,
                     *         "level": 2,
                     *         "streakDays": 3,
                     *         "freezes": 1,
                     *         "stage": 1,
                     *         "pagesRemaining": 18,
                     *         "pagesLimit": 20,
                     *         "resetDate": "2027-01-01",
                     *         "badges": [
                     *           "premier_scan"
                     *         ]
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ReadResult"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    getSession: {
        parameters: {
            query?: {
                /** @description Nombre de questions du test (v1.7). Autre valeur: 400. */
                size?: 5 | 10 | 15 | 20;
            };
            header?: never;
            path: {
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Session */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "docId": "01JEXAMPLE0DOC0000000000AA",
                     *       "questions": [
                     *         {
                     *           "questionId": "qcm-01",
                     *           "kind": "qcm",
                     *           "prompt": "Que produit la photosynthese ?",
                     *           "choices": [
                     *             "Du dioxygene",
                     *             "Du dioxyde de carbone",
                     *             "De l'azote",
                     *             "De l'eau"
                     *           ]
                     *         },
                     *         {
                     *           "questionId": "gap-01",
                     *           "kind": "gap",
                     *           "prompt": "La photosynthese produit du ____."
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Session"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    listFolders: {
        parameters: {
            query?: {
                /** @description Parent seulement (obligatoire pour lui); 404 si l'eleve n'est pas de sa famille */
                studentId?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Dossiers, par nom croissant */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "folderId": "01JEXAMPLE0FLD0000000000AA",
                     *           "name": "Controle de juin",
                     *           "createdAt": "2026-12-01T09:00:00Z",
                     *           "scanCount": 3
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["FolderList"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createFolder: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "name": "Controle de juin"
                 *     }
                 */
                "application/json": components["schemas"]["FolderNameRequest"];
            };
        };
        responses: {
            /** @description Dossier cree */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "folderId": "01JEXAMPLE0FLD0000000000AA",
                     *       "name": "Controle de juin",
                     *       "createdAt": "2026-12-01T09:00:00Z",
                     *       "scanCount": 0
                     *     }
                     */
                    "application/json": components["schemas"]["Folder"];
                };
            };
            /** @description Requete invalide: nom vide apres nettoyage (`requete_invalide`) ou 50 dossiers atteints (`dossiers_limite`) */
            400: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    "application/json": components["schemas"]["Error"];
                };
            };
            403: components["responses"]["Forbidden"];
            /** @description Nom de dossier deja pris (sans tenir compte de la casse ni des accents) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "dossier_nom_pris",
                     *       "message": "Tu as déjà un dossier avec ce nom"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    deleteFolder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                folderId: components["parameters"]["FolderId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprime */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    renameFolder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                folderId: components["parameters"]["FolderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "name": "Brevet blanc"
                 *     }
                 */
                "application/json": components["schemas"]["FolderNameRequest"];
            };
        };
        responses: {
            /** @description Dossier renomme */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "folderId": "01JEXAMPLE0FLD0000000000AA",
                     *       "name": "Brevet blanc",
                     *       "createdAt": "2026-12-01T09:00:00Z",
                     *       "scanCount": 3
                     *     }
                     */
                    "application/json": components["schemas"]["Folder"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Nom de dossier deja pris (sans tenir compte de la casse ni des accents) */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "dossier_nom_pris",
                     *       "message": "Tu as déjà un dossier avec ce nom"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    addScansToFolder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                folderId: components["parameters"]["FolderId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "docIds": [
                 *         "01JEXAMPLE0DOC0000000000AA",
                 *         "01JEXAMPLE0DOC0000000000AB"
                 *       ]
                 *     }
                 */
                "application/json": components["schemas"]["FolderScansRequest"];
            };
        };
        responses: {
            /** @description Dossier mis a jour */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "folderId": "01JEXAMPLE0FLD0000000000AA",
                     *       "name": "Controle de juin",
                     *       "createdAt": "2026-12-01T09:00:00Z",
                     *       "scanCount": 2
                     *     }
                     */
                    "application/json": components["schemas"]["Folder"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    removeScanFromFolder: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                folderId: components["parameters"]["FolderId"];
                docId: components["parameters"]["DocId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Retiree */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getCours: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                coursId: components["parameters"]["CoursId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Cours */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "coursId": "01JEXAMPLE0CRS0000000000AA",
                     *       "createdAt": "2026-12-01T10:05:00Z",
                     *       "pages": 2,
                     *       "texts": [
                     *         {
                     *           "page": 1,
                     *           "sentences": [
                     *             {
                     *               "id": "p1-s1",
                     *               "text": "La photosynthese produit du dioxygene."
                     *             }
                     *           ]
                     *         },
                     *         {
                     *           "page": 2,
                     *           "sentences": [
                     *             {
                     *               "id": "p2-s1",
                     *               "text": "La Revolution commence en 1789."
                     *             }
                     *           ]
                     *         }
                     *       ],
                     *       "sections": [
                     *         {
                     *           "fromSentenceId": "p1-s1",
                     *           "subject": "svt",
                     *           "topic": "La photosynthese",
                     *           "title": "La photosynthese",
                     *           "status": "fiche",
                     *           "docId": "01JEXAMPLE0DOC0000000000AA"
                     *         },
                     *         {
                     *           "fromSentenceId": "p2-s1",
                     *           "subject": "histoire_geo",
                     *           "status": "ignoree"
                     *         }
                     *       ],
                     *       "figureCount": 1,
                     *       "blocks": [
                     *         {
                     *           "id": "b1",
                     *           "kind": "paragraphe",
                     *           "sentenceIds": [
                     *             "p1-s1"
                     *           ]
                     *         },
                     *         {
                     *           "id": "b2",
                     *           "kind": "figure",
                     *           "figureId": "f1"
                     *         },
                     *         {
                     *           "id": "b3",
                     *           "kind": "paragraphe",
                     *           "sentenceIds": [
                     *             "p2-s1"
                     *           ]
                     *         }
                     *       ],
                     *       "figures": [
                     *         {
                     *           "figureId": "f1",
                     *           "page": 1,
                     *           "kind": "schema",
                     *           "alt": "Schema de la photosynthese",
                     *           "url": "https://qcm-dev-figures.s3.eu-west-3.amazonaws.com/figures/x/f1.jpg?X-Amz-Signature=example",
                     *           "urlExpireAt": "2026-12-01T10:10:00Z"
                     *         }
                     *       ],
                     *       "marks": [
                     *         {
                     *           "sentenceId": "p1-s1",
                     *           "status": "verifiee",
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "claimId": "01"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Cours"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteCours: {
        parameters: {
            query: {
                /** @description Obligatoire, pas de valeur par defaut: l'eleve choisit */
                fiches: "garder" | "supprimer";
            };
            header?: never;
            path: {
                coursId: components["parameters"]["CoursId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprime */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description Un ajout de pages est ouvert sur ce cours (v1.6, `etat_invalide`): annule-le d'abord. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "etat_invalide",
                     *       "message": "Un ajout est en cours"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postPracticeSession: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "docIds": [
                 *         "01JEXAMPLE0DOC0000000000AA",
                 *         "01JEXAMPLE0DOC0000000000AB"
                 *       ],
                 *       "size": 10
                 *     }
                 */
                "application/json": components["schemas"]["PracticeRequest"];
            };
        };
        responses: {
            /** @description Session tiree */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "scope": "fiches",
                     *       "title": "2 fiches",
                     *       "docIds": [
                     *         "01JEXAMPLE0DOC0000000000AA",
                     *         "01JEXAMPLE0DOC0000000000AB"
                     *       ],
                     *       "questions": [
                     *         {
                     *           "questionId": "01JEXAMPLE0DOC0000000000AA:qcm:01",
                     *           "kind": "qcm",
                     *           "prompt": "Que produit la photosynthese ?",
                     *           "choices": [
                     *             "Du dioxygene",
                     *             "De l azote",
                     *             "Du sable",
                     *             "Du fer"
                     *           ],
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "docTitle": "La photosynthese"
                     *         }
                     *       ],
                     *       "available": 12,
                     *       "short": false,
                     *       "xpRemaining": [
                     *         {
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "xpRemaining": 50
                     *         },
                     *         {
                     *           "docId": "01JEXAMPLE0DOC0000000000AB",
                     *           "xpRemaining": 35
                     *         }
                     *       ],
                     *       "skipped": []
                     *     }
                     */
                    "application/json": components["schemas"]["PracticeSession"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
            /** @description `aucune_question`: aucune des fiches n'a de question. */
            409: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "aucune_question",
                     *       "message": "Aucune question pour le moment"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    postAnswer: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "questionId": "qcm-01",
                 *       "choice": "Du dioxygene"
                 *     }
                 */
                "application/json": components["schemas"]["AnswerRequest"];
            };
        };
        responses: {
            /** @description Resultat */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "correct": true,
                     *       "xpGained": 10,
                     *       "badges": [],
                     *       "progress": {
                     *         "xp": 110,
                     *         "level": 2,
                     *         "streakDays": 3,
                     *         "freezes": 1,
                     *         "stage": 1,
                     *         "pagesRemaining": 18,
                     *         "pagesLimit": 20,
                     *         "resetDate": "2027-01-01"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["AnswerResult"];
                };
            };
            400: components["responses"]["BadRequest"];
        };
    };
    activateStudent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "token": "exemple-de-jeton-a-usage-unique-0123456789abcdef",
                 *       "password": "Un-mot-de-passe-long-1"
                 *     }
                 */
                "application/json": components["schemas"]["ActivationRequest"];
            };
        };
        responses: {
            /** @description Compte active */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            404: components["responses"]["NotFound"];
        };
    };
    getMe: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Profil */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "userId": "7b0f6c1e-0000-4000-8000-00000000a001",
                     *       "role": "eleve",
                     *       "familyId": "01JEXAMPLE0FAM0000000000AA",
                     *       "studentId": "01JEXAMPLE0STU0000000000AA",
                     *       "pseudo": "Lila-7k2f"
                     *     }
                     */
                    "application/json": components["schemas"]["Me"];
                };
            };
            /** @description Parent sans famille (famille pas encore creee par POST /family) */
            404: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "introuvable",
                     *       "message": "Introuvable"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMyProgress: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Progression */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "xp": 110,
                     *       "level": 2,
                     *       "streakDays": 3,
                     *       "freezes": 1,
                     *       "stage": 1,
                     *       "pagesRemaining": 18,
                     *       "pagesLimit": 20,
                     *       "resetDate": "2027-01-01"
                     *     }
                     */
                    "application/json": components["schemas"]["Progress"];
                };
            };
        };
    };
    listMyTests: {
        parameters: {
            query?: {
                limit?: components["parameters"]["TestLimit"];
                /** @description Curseur opaque renvoye par la page precedente (`nextCursor`) */
                cursor?: components["parameters"]["TestCursor"];
                /** @description Annee scolaire (1er septembre au 31 aout, Europe/Paris), ex. 2026-2027 */
                schoolYear?: components["parameters"]["SchoolYear"];
                /** @description Seulement les passages sur cette fiche */
                docId?: string;
                /** @description Premier jour inclus (fuseau Europe/Paris) */
                from?: string;
                /** @description Dernier jour inclus (fuseau Europe/Paris) */
                to?: string;
            };
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page de passages */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "testId": "01JF5T3ST0000000000000AAAA",
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "titre": "La photosynthese",
                     *           "matiere": "svt",
                     *           "mode": "mixte",
                     *           "schoolYear": "2026-2027",
                     *           "startedAt": "2026-12-01T17:02:11Z",
                     *           "endedAt": "2026-12-01T17:06:40Z",
                     *           "total": 10,
                     *           "answered": 10,
                     *           "correct": 8,
                     *           "firstTry": 7,
                     *           "scorePct": 80,
                     *           "xpGained": 63,
                     *           "status": "complet"
                     *         },
                     *         {
                     *           "testId": "01JF5T3ST0000000000000ABAA",
                     *           "docId": "01JEXAMPLE0DOC0000000000AB",
                     *           "titre": "La Revolution francaise",
                     *           "matiere": "histoire_geo",
                     *           "mode": "qcm",
                     *           "schoolYear": "2026-2027",
                     *           "startedAt": "2026-11-30T18:30:00Z",
                     *           "endedAt": "2026-11-30T18:32:05Z",
                     *           "total": 10,
                     *           "answered": 4,
                     *           "correct": 3,
                     *           "firstTry": 3,
                     *           "scorePct": 30,
                     *           "xpGained": 15,
                     *           "status": "incomplet"
                     *         }
                     *       ],
                     *       "schoolYears": [
                     *         "2026-2027",
                     *         "2025-2026"
                     *       ],
                     *       "nextCursor": "VEVTVCMyMDI2LTExLTMwVDE4OjMwOjAwWiMwMUpGNVQzU1QwMDAwMDAwMDAwMDAwQUJBQQ"
                     *     }
                     */
                    "application/json": components["schemas"]["TestPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
        };
    };
    getMyTest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                testId: components["parameters"]["TestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Passage */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "testId": "01JF5T3ST0000000000000AAAA",
                     *       "docId": "01JEXAMPLE0DOC0000000000AA",
                     *       "titre": "La photosynthese",
                     *       "matiere": "svt",
                     *       "mode": "mixte",
                     *       "schoolYear": "2026-2027",
                     *       "startedAt": "2026-12-01T17:02:11Z",
                     *       "endedAt": "2026-12-01T17:06:40Z",
                     *       "total": 2,
                     *       "answered": 2,
                     *       "correct": 1,
                     *       "firstTry": 1,
                     *       "scorePct": 50,
                     *       "xpGained": 5,
                     *       "status": "complet",
                     *       "questions": [
                     *         {
                     *           "questionId": "qcm-01",
                     *           "rank": 1,
                     *           "kind": "qcm",
                     *           "correct": true,
                     *           "attempts": 1,
                     *           "firstTry": true,
                     *           "xpGained": 5,
                     *           "answeredAt": "2026-12-01T17:02:40Z",
                     *           "choice": "Du dioxygene",
                     *           "prompt": "Que produit la photosynthese ?",
                     *           "choices": [
                     *             "Du dioxygene",
                     *             "Du dioxyde de carbone",
                     *             "De l'azote",
                     *             "De l'eau"
                     *           ],
                     *           "correctAnswer": "Du dioxygene"
                     *         },
                     *         {
                     *           "questionId": "gap-01",
                     *           "rank": 2,
                     *           "kind": "gap",
                     *           "correct": false,
                     *           "attempts": 1,
                     *           "firstTry": false,
                     *           "xpGained": 0,
                     *           "answeredAt": "2026-12-01T17:06:40Z",
                     *           "choice": "azote",
                     *           "prompt": "La photosynthese produit du ____.",
                     *           "correctAnswer": "dioxygene"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["TestDetail"];
                };
            };
            404: components["responses"]["NotFound"];
        };
    };
    getStudentProgress: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: components["parameters"]["StudentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Avancement */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "student": {
                     *         "studentId": "01JEXAMPLE0STU0000000000AA",
                     *         "pseudo": "Lila-7k2f",
                     *         "schoolLevel": "seconde",
                     *         "under15": false,
                     *         "status": "actif",
                     *         "pageQuota": 50
                     *       },
                     *       "progress": {
                     *         "xp": 110,
                     *         "level": 2,
                     *         "streakDays": 3,
                     *         "freezes": 1,
                     *         "stage": 2,
                     *         "pagesRemaining": 18,
                     *         "pagesLimit": 20,
                     *         "resetDate": "2027-01-01",
                     *         "badges": [
                     *           "premier_scan"
                     *         ]
                     *       },
                     *       "docs": [
                     *         {
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "titre": "La photosynthese",
                     *           "matiere": "svt",
                     *           "pages": 2,
                     *           "createdAt": "2026-11-28T16:00:00Z",
                     *           "tests": 3,
                     *           "bestScorePct": 90,
                     *           "lastScorePct": 80,
                     *           "lastTestAt": "2026-12-01T17:06:40Z"
                     *         }
                     *       ],
                     *       "scans": [
                     *         {
                     *           "scanId": "01JEXAMPLE0JOB0000000000AA",
                     *           "stage": "verification",
                     *           "pages": 3,
                     *           "createdAt": "2026-12-01T18:00:00Z"
                     *         }
                     *       ],
                     *       "weeks": [
                     *         {
                     *           "week": "2026-W48",
                     *           "tests": 4,
                     *           "avgScorePct": 72,
                     *           "activeDays": 3
                     *         }
                     *       ],
                     *       "subjects": [
                     *         {
                     *           "matiere": "svt",
                     *           "tests": 3,
                     *           "avgScorePct": 83
                     *         }
                     *       ],
                     *       "schoolYears": [
                     *         "2026-2027"
                     *       ],
                     *       "recentTests": [
                     *         {
                     *           "testId": "01JF5T3ST0000000000000AAAA",
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "titre": "La photosynthese",
                     *           "matiere": "svt",
                     *           "mode": "mixte",
                     *           "schoolYear": "2026-2027",
                     *           "startedAt": "2026-12-01T17:02:11Z",
                     *           "endedAt": "2026-12-01T17:06:40Z",
                     *           "total": 10,
                     *           "answered": 10,
                     *           "correct": 8,
                     *           "firstTry": 7,
                     *           "scorePct": 80,
                     *           "xpGained": 63,
                     *           "status": "complet"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["StudentProgressView"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    listStudentTests: {
        parameters: {
            query?: {
                limit?: components["parameters"]["TestLimit"];
                /** @description Curseur opaque renvoye par la page precedente (`nextCursor`) */
                cursor?: components["parameters"]["TestCursor"];
                /** @description Annee scolaire (1er septembre au 31 aout, Europe/Paris), ex. 2026-2027 */
                schoolYear?: components["parameters"]["SchoolYear"];
                docId?: string;
                from?: string;
                to?: string;
            };
            header?: never;
            path: {
                sid: components["parameters"]["StudentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Page de resumes */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "items": [
                     *         {
                     *           "testId": "01JF5T3ST0000000000000AAAA",
                     *           "docId": "01JEXAMPLE0DOC0000000000AA",
                     *           "titre": "La photosynthese",
                     *           "matiere": "svt",
                     *           "mode": "mixte",
                     *           "schoolYear": "2026-2027",
                     *           "startedAt": "2026-12-01T17:02:11Z",
                     *           "endedAt": "2026-12-01T17:06:40Z",
                     *           "total": 10,
                     *           "answered": 10,
                     *           "correct": 8,
                     *           "firstTry": 7,
                     *           "scorePct": 80,
                     *           "xpGained": 63,
                     *           "status": "complet"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["TestPage"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getStudentTest: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: components["parameters"]["StudentId"];
                testId: components["parameters"]["TestId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Passage, par question */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "testId": "01JF5T3ST0000000000000AAAA",
                     *       "docId": "01JEXAMPLE0DOC0000000000AA",
                     *       "titre": "La photosynthese",
                     *       "matiere": "svt",
                     *       "mode": "mixte",
                     *       "schoolYear": "2026-2027",
                     *       "startedAt": "2026-12-01T17:02:11Z",
                     *       "endedAt": "2026-12-01T17:06:40Z",
                     *       "total": 2,
                     *       "answered": 2,
                     *       "correct": 1,
                     *       "firstTry": 1,
                     *       "scorePct": 50,
                     *       "xpGained": 5,
                     *       "status": "complet",
                     *       "questions": [
                     *         {
                     *           "questionId": "qcm-01",
                     *           "rank": 1,
                     *           "kind": "qcm",
                     *           "correct": true,
                     *           "attempts": 1,
                     *           "firstTry": true,
                     *           "xpGained": 5,
                     *           "answeredAt": "2026-12-01T17:02:40Z"
                     *         },
                     *         {
                     *           "questionId": "gap-01",
                     *           "rank": 2,
                     *           "kind": "gap",
                     *           "correct": false,
                     *           "attempts": 1,
                     *           "firstTry": false,
                     *           "xpGained": 0,
                     *           "answeredAt": "2026-12-01T17:06:40Z"
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["TestParentDetail"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createStudent: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "pseudo": "Lila",
                 *       "schoolLevel": "seconde",
                 *       "under15": false,
                 *       "parentalAuthority": true,
                 *       "policyVersion": "2026-11-25"
                 *     }
                 */
                "application/json": components["schemas"]["StudentCreateRequest"];
            };
        };
        responses: {
            /** @description Eleve cree */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "student": {
                     *         "studentId": "01JEXAMPLE0STU0000000000AA",
                     *         "pseudo": "Lila-7k2f",
                     *         "schoolLevel": "seconde",
                     *         "under15": false,
                     *         "status": "actif",
                     *         "pageQuota": 20
                     *       },
                     *       "activationLink": {
                     *         "url": "https://app.example.invalid/activer#token=example",
                     *         "expiresAt": "2026-12-02T10:00:00Z"
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["StudentCreateResponse"];
                };
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
        };
    };
    createActivationLink: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: components["parameters"]["StudentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Lien */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "url": "https://app.example.invalid/activer#token=example",
                     *       "expiresAt": "2026-12-02T10:00:00Z"
                     *     }
                     */
                    "application/json": components["schemas"]["ActivationLink"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    deleteStudent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: components["parameters"]["StudentId"];
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Supprime */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    updateStudent: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                sid: components["parameters"]["StudentId"];
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "status": "suspendu"
                 *     }
                 */
                "application/json": components["schemas"]["StudentUpdateRequest"];
            };
        };
        responses: {
            /** @description Eleve mis a jour */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "studentId": "01JEXAMPLE0STU0000000000AA",
                     *       "pseudo": "Lila-7k2f",
                     *       "schoolLevel": "seconde",
                     *       "under15": false,
                     *       "status": "suspendu",
                     *       "pageQuota": 20
                     *     }
                     */
                    "application/json": components["schemas"]["Student"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    getFamilyDashboard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Tableau de bord */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "students": [
                     *         {
                     *           "student": {
                     *             "studentId": "01JEXAMPLE0STU0000000000AA",
                     *             "pseudo": "Lila-7k2f",
                     *             "schoolLevel": "seconde",
                     *             "under15": false,
                     *             "status": "actif",
                     *             "pageQuota": 20
                     *           },
                     *           "progress": {
                     *             "xp": 110,
                     *             "level": 2,
                     *             "streakDays": 3,
                     *             "freezes": 1,
                     *             "stage": 1,
                     *             "pagesRemaining": 18,
                     *             "pagesLimit": 20,
                     *             "resetDate": "2027-01-01"
                     *           }
                     *         }
                     *       ],
                     *       "familyPagesRemaining": 38,
                     *       "familyPagesLimit": 50
                     *     }
                     */
                    "application/json": components["schemas"]["Dashboard"];
                };
            };
            403: components["responses"]["Forbidden"];
        };
    };
    getFamilyLeaderboard: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Classement */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "week": "2026-W49",
                     *       "entries": [
                     *         {
                     *           "studentId": "01JEXAMPLE0STU0000000000AA",
                     *           "pseudo": "Lila-7k2f",
                     *           "xp": 310,
                     *           "activeDays": 4
                     *         }
                     *       ]
                     *     }
                     */
                    "application/json": components["schemas"]["Leaderboard"];
                };
            };
        };
    };
    validateReport: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                id: string;
            };
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "decision": "valide"
                 *     }
                 */
                "application/json": components["schemas"]["ReportValidateRequest"];
            };
        };
        responses: {
            /** @description Signalement traite */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "reportId": "01JEXAMPLE0RPT0000000000AA",
                     *       "status": "valide"
                     *     }
                     */
                    "application/json": components["schemas"]["Report"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    exportFamily: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Export */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "familyId": "01JEXAMPLE0FAM0000000000AA",
                     *       "exportedAt": "2026-12-01T10:00:00Z",
                     *       "parentEmail": "parent@example.invalid",
                     *       "students": [],
                     *       "docs": [],
                     *       "reports": []
                     *     }
                     */
                    "application/json": components["schemas"]["FamilyExport"];
                };
            };
            403: components["responses"]["Forbidden"];
        };
    };
    createMyExportArchive: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Demande acceptee */
            202: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "exportId": "01JF5EXP0RT00000000000AAAA",
                     *       "state": "en_cours"
                     *     }
                     */
                    "application/json": components["schemas"]["ExportStatus"];
                };
            };
            403: components["responses"]["Forbidden"];
            /** @description Plus de 3 demandes dans l'heure (`quota_epuise`), ou limite de debit de la route (corps API Gateway) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "quota_epuise",
                     *       "message": "Trop d'archives demandées, réessaie dans une heure"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    getMyExportArchive: {
        parameters: {
            query?: never;
            header?: never;
            path: {
                exportId: string;
            };
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Etat */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "exportId": "01JF5EXP0RT00000000000AAAA",
                     *       "state": "pret",
                     *       "archive": {
                     *         "url": "https://example.invalid/exports/archive.zip?signature=exemple",
                     *         "expiresAt": "2026-12-01T10:10:00Z",
                     *         "format": "zip",
                     *         "sizeBytes": 48211300,
                     *         "students": 1,
                     *         "tests": 120,
                     *         "truncated": false,
                     *         "courses": 12,
                     *         "figures": 31,
                     *         "omittedCourses": 0
                     *       }
                     *     }
                     */
                    "application/json": components["schemas"]["ExportStatus"];
                };
            };
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createExportArchive: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Archive prete */
            200: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "url": "https://example.invalid/exports/archive.zip?signature=exemple",
                     *       "expiresAt": "2026-12-01T10:10:00Z",
                     *       "format": "zip",
                     *       "sizeBytes": 482113,
                     *       "students": 2,
                     *       "tests": 1840,
                     *       "truncated": false
                     *     }
                     */
                    "application/json": components["schemas"]["ExportArchive"];
                };
            };
            403: components["responses"]["Forbidden"];
            /** @description Plus de 3 archives dans l'heure pour la famille (`quota_epuise`), ou limite de debit de la route (corps API Gateway, voir `TooManyRequests`) */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "quota_epuise",
                     *       "message": "Trop d'archives demandées, réessaie dans une heure"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
    acceptPolicy: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "consent": true,
                 *       "policyVersion": "2026-11-26"
                 *     }
                 */
                "application/json": components["schemas"]["FamilyCreateRequest"];
            };
        };
        responses: {
            /** @description Accepte (policyOutdated repasse a faux) */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            400: components["responses"]["BadRequest"];
            403: components["responses"]["Forbidden"];
            404: components["responses"]["NotFound"];
        };
    };
    createFamily: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody: {
            content: {
                /**
                 * @example {
                 *       "consent": true,
                 *       "policyVersion": "2026-11-25"
                 *     }
                 */
                "application/json": components["schemas"]["FamilyCreateRequest"];
            };
        };
        responses: {
            /** @description Famille creee */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "userId": "7b0f6c1e-0000-4000-8000-00000000a002",
                     *       "role": "parent",
                     *       "familyId": "01JEXAMPLE0FAM0000000000AA"
                     *     }
                     */
                    "application/json": components["schemas"]["Me"];
                };
            };
            400: components["responses"]["BadRequest"];
            409: components["responses"]["Conflict"];
        };
    };
    deleteFamily: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Famille supprimee */
            204: {
                headers: {
                    [name: string]: unknown;
                };
                content?: never;
            };
            403: components["responses"]["Forbidden"];
        };
    };
    createInvitation: {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        requestBody?: never;
        responses: {
            /** @description Code cree (a transmettre au parent, non reaffichable) */
            201: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "0123456789abcdef0123456789abcdef",
                     *       "createdAt": "2026-12-01T09:00:00.000Z",
                     *       "remainingToday": 19
                     *     }
                     */
                    "application/json": components["schemas"]["InvitationCreated"];
                };
            };
            403: components["responses"]["Forbidden"];
            /** @description Limite quotidienne de codes atteinte */
            429: {
                headers: {
                    [name: string]: unknown;
                };
                content: {
                    /**
                     * @example {
                     *       "code": "quota_epuise",
                     *       "message": "Limite de 20 codes par jour atteinte"
                     *     }
                     */
                    "application/json": components["schemas"]["Error"];
                };
            };
        };
    };
}
