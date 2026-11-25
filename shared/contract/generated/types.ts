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
         *     Sans `sections`: une seule section couvre tout, avec `subject`, `topic` et `folderId` de la requete (ou les propositions de `Transcription`). `sections` et `subject`/`topic`/`folderId` ensemble: 400.
         *     Regles (400 `requete_invalide`, rien n'est modifie): au plus 6 sections; la premiere commence a la toute premiere phrase; `fromSentenceId` inconnu, en double ou pas dans l'ordre croissant du texte; au moins une section non ignoree; chaque section contient au moins une phrase; un `topic` ou `title` vide apres nettoyage; un `folderId` inconnu (404). Le quota de pages est consomme UNE fois pour le scan, quel que soit le nombre de sections; le plafond de cout `max(0,25 ; 0,15 x pages)` vaut pour l'ensemble du job (somme des sections).
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
         * Le cours complet corrige, par phrases, avec son decoupage et les liens vers les fiches (handler cours-api). Eleve seulement: le parent n'y accede que par l'export (403).
         * @description `coursId` vient de `DocSummary.coursId` ou de `ScanSummary.coursId`. Un lien de section vers une fiche supprimee n'a plus de `docId` (statut `supprimee`).
         */
        get: operations["getCours"];
        put?: never;
        post?: never;
        /** Supprime le texte du cours. Option explicite `fiches`: `garder` (les fiches restent, sans lien vers le cours) ou `supprimer` (les fiches du cours sont supprimees aussi). Supprimer une fiche ne supprime jamais le cours (handler cours-api) */
        delete: operations["deleteCours"];
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
        /** Export complet des donnees de la famille - e-mail du parent, eleves (profil de jeu, jours actifs, tentatives), fiches (affirmations, sources, questions), signalements (handler family-admin, L3). Le texte brut lu sur les photos (7 jours) n'est pas exporte. */
        get: operations["exportFamily"];
        put?: never;
        post?: never;
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
             * @description `dossier_nom_pris` (409) et `dossiers_limite` (400) ajoutes en 1.3 pour les dossiers; un client 1.2 qui ne les connait pas lit le statut HTTP.
             * @enum {string}
             */
            code: "requete_invalide" | "interdit" | "introuvable" | "etat_invalide" | "quota_epuise" | "budget_epuise" | "dossier_nom_pris" | "dossiers_limite";
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
            /** @description Etat precis du job (distingue rejete, echec, expire; un job annule est `rejete` avec le message « Annule par l'eleve »). Une fiche dont le job a expire est `termine`. */
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
        /** @description Cours complet corrige, conserve jusqu'a suppression par l'eleve ou le parent (comme les fiches). Contient le texte lu et corrige, jamais la photo. */
        Cours: {
            coursId: string;
            /** Format: date-time */
            createdAt: string;
            pages: number;
            /** @description Une entree par page, triee numeriquement; meme forme que `Transcription.pages` */
            texts: {
                page: number;
                sentences: components["schemas"]["Sentence"][];
            }[];
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
            /** @description `p<page de depart>-s<n>`: l'identifiant porte la PREMIERE page de la phrase, meme si elle se termine plus loin. */
            id: string;
            text: string;
            /** @description Facultatif (v1.3). Pages d'origine d'une phrase recollee: une phrase coupee par un saut de page est UNE phrase, `pages: [2, 3]`. Pages consecutives, croissantes, la premiere = celle de l'id. Absent: la phrase tient sur la page de son id. La phrase n'est listee que sous sa premiere page dans `Transcription.pages`; la page suivante ne la repete pas. Dans `ConfirmRequest.corrections`, `pages` est ignore (seuls `id` et `text` comptent). */
            pages?: number[];
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
            /** @description Dans l'ordre des pages (1 par page) */
            photoUrls: string[];
            /** Format: date-time */
            photoUrlsExpireAt: string;
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
            text: string;
            /** @enum {string} */
            status: "verifiee" | "erreur" | "non_verifiable" | "non_factuelle";
            aRisque: boolean;
            sources: components["schemas"]["Source"][];
        };
        Doc: components["schemas"]["DocSummary"] & {
            summary: string;
            claims: components["schemas"]["Claim"][];
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
            prompt: string;
            choices?: string[];
        };
        Session: {
            docId: string;
            questions: components["schemas"]["Question"][];
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
            /** @description Cours complets conserves (v1.3), texte compris: donnee personnelle exportee comme les fiches */
            cours?: components["schemas"]["Cours"][];
            /** @description Profil de jeu (XP, serie, badges, signalements valides) */
            profile: {
                [key: string]: unknown;
            };
            /** @description Jours (Paris) ou l'eleve a joue */
            activeDays: string[];
            attempts: {
                questionId: string;
                date: string;
                attempts: number;
            }[];
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
        /** @description quota_epuise (pages du mois) ou budget_epuise (compteur de cout: seuils mensuels 15/18 EUR; en dev, plafond d'essais cumule DEV_TRIAL_CAP_EUR = 50 EUR) */
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
        JobId: string;
        DocId: string;
        CoursId: string;
        FolderId: string;
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
                 *       "folderId": "01JEXAMPLE0FLD0000000000AA"
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
            404: components["responses"]["NotFound"];
            429: components["responses"]["QuotaExceeded"];
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
                     *       "message": "Annule par l'eleve"
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
                     *       "claims": [
                     *         {
                     *           "claimId": "01",
                     *           "text": "La photosynthese produit du dioxygene.",
                     *           "status": "verifiee",
                     *           "aRisque": false,
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
            query?: never;
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
                     *       "message": "Tu as deja un dossier avec ce nom"
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
                     *       "message": "Tu as deja un dossier avec ce nom"
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
