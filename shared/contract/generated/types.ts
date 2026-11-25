// GENERE par scripts/gen-contract.ts depuis shared/contract/openapi.yaml. NE PAS EDITER.
export interface paths {
    "/scans": {
        parameters: {
            query?: never;
            header?: never;
            path?: never;
            cookie?: never;
        };
        get?: never;
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
        /** Etat du traitement (handler jobs-get, L2a) */
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
        /** Texte numerote et URL pre-signee de lecture de la photo, 5 min (handler jobs-transcription, L2a) */
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
        /** Texte corrige, reprend le workflow (handler jobs-confirm, L2a) */
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
        patch?: never;
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
}
export type webhooks = Record<string, never>;
export interface components {
    schemas: {
        Error: {
            /** @enum {string} */
            code: "requete_invalide" | "interdit" | "introuvable" | "etat_invalide" | "quota_epuise" | "budget_epuise";
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
        };
        ScanCreateRequest: {
            /** @description Nombre de pages de l'envoi (10 max). v1: une image = 1 page (PDF refuse, voir contentType) */
            pages: number;
            /**
             * @description v1: seules les images (image/jpeg, image/png) sont acceptees. application/pdf est refuse (400 requete_invalide) tant que la prise en charge des PDF n'existe pas.
             * @enum {string}
             */
            contentType: "image/jpeg" | "image/png" | "application/pdf";
        };
        ScanCreateResponse: {
            jobId: string;
            upload: {
                /** Format: uri */
                url: string;
                fields: {
                    [key: string]: string;
                };
            };
            /** Format: date-time */
            expiresAt: string;
            pagesRemaining: number;
        };
        Sentence: {
            id: string;
            text: string;
        };
        Transcription: {
            jobId: string;
            /** @enum {string} */
            docType: "cours" | "exercice" | "autre";
            pages: {
                page: number;
                sentences: components["schemas"]["Sentence"][];
            }[];
            photoUrls: string[];
            /** Format: date-time */
            photoUrlsExpireAt: string;
        };
        ConfirmRequest: {
            corrections: components["schemas"]["Sentence"][];
        };
        DocSummary: {
            docId: string;
            title: string;
            /** @enum {string} */
            subject: "maths" | "physique" | "svt" | "histoire_geo" | "francais" | "autre";
            /** Format: date-time */
            createdAt: string;
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
        StudentId: string;
    };
    requestBodies: never;
    headers: never;
    pathItems: never;
}
export type $defs = Record<string, never>;
export interface operations {
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
                 *       "contentType": "image/jpeg"
                 *     }
                 */
                "application/json": components["schemas"]["ScanCreateRequest"];
            };
        };
        responses: {
            /** @description Job cree */
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
                     *           "key": "scans/01JEXAMPLE0JOB0000000000AA/0",
                     *           "Content-Type": "image/jpeg"
                     *         }
                     *       },
                     *       "expiresAt": "2026-12-01T10:15:00Z",
                     *       "pagesRemaining": 18
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
                     *       "createdAt": "2026-12-01T10:00:00Z"
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
                     *             }
                     *           ]
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
                 *       "corrections": [
                 *         {
                 *           "id": "p1-s1",
                 *           "text": "La photosynthese produit du dioxygene."
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
                     *           "createdAt": "2026-12-01T10:03:00Z"
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
}
