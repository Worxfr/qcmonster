// GENERE par scripts/gen-contract.ts depuis shared/contract/openapi.yaml. NE PAS EDITER.
import { z } from 'zod';

export const ErrorSchema = z.object({ "code": z.enum(["requete_invalide","interdit","introuvable","etat_invalide","quota_epuise","budget_epuise"]), "message": z.string().max(500), "resetDate": z.string().date().describe("Remise a zero du quota (1er du mois a Paris)").optional() });

export const JobStateSchema = z.enum(["en_attente_envoi","verification_fichier","transcription","a_confirmer","verification","generation","termine","rejete","echec","expire"]);

export const JobSchema = z.object({ "jobId": z.string(), "state": z.enum(["en_attente_envoi","verification_fichier","transcription","a_confirmer","verification","generation","termine","rejete","echec","expire"]), "pages": z.number().int().gte(1).lte(10), "createdAt": z.string().datetime({ offset: true }), "durationSeconds": z.number().int().gte(0).optional(), "costCents": z.number().int().gte(0).describe("Cout Bedrock du traitement en centimes d'euro (mesure").optional(), "docId": z.string().describe("Present quand state = termine").optional(), "message": z.string().max(500).optional() });

export const ScanCreateRequestSchema = z.object({ "pages": z.number().int().gte(1).lte(10).describe("Nombre de pages de l'envoi (10 max). v1: une image = 1 page (PDF refuse, voir contentType)"), "contentType": z.enum(["image/jpeg","image/png","application/pdf"]).describe("v1: seules les images (image/jpeg, image/png) sont acceptees. application/pdf est refuse (400 requete_invalide) tant que la prise en charge des PDF n'existe pas.") });

export const ScanCreateResponseSchema = z.object({ "jobId": z.string(), "upload": z.object({ "url": z.string().url(), "fields": z.record(z.string(), z.string()) }), "expiresAt": z.string().datetime({ offset: true }), "pagesRemaining": z.number().int().gte(0) });

export const SentenceSchema = z.object({ "id": z.string().regex(new RegExp("^p[0-9]+-s[0-9]+$")), "text": z.string().max(2000) });

export const TranscriptionSchema = z.object({ "jobId": z.string(), "docType": z.enum(["cours","exercice","autre"]), "pages": z.array(z.object({ "page": z.number().int().gte(1), "sentences": z.array(z.object({ "id": z.string().regex(new RegExp("^p[0-9]+-s[0-9]+$")), "text": z.string().max(2000) })) })), "photoUrls": z.array(z.string().url()), "photoUrlsExpireAt": z.string().datetime({ offset: true }) });

export const ConfirmRequestSchema = z.object({ "corrections": z.array(z.object({ "id": z.string().regex(new RegExp("^p[0-9]+-s[0-9]+$")), "text": z.string().max(2000) })).max(500) });

export const DocSummarySchema = z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) });

export const DocListSchema = z.object({ "items": z.array(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) })) });

export const SourceSchema = z.object({ "passageId": z.string(), "url": z.string().url().regex(new RegExp("^https://")), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) });

export const ClaimSchema = z.object({ "claimId": z.string(), "text": z.string().max(1000), "status": z.enum(["verifiee","erreur","non_verifiable","non_factuelle"]), "aRisque": z.boolean(), "sources": z.array(z.object({ "passageId": z.string(), "url": z.string().url().regex(new RegExp("^https://")), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) })) });

export const DocSchema = z.intersection(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) }), z.object({ "summary": z.string(), "claims": z.array(z.object({ "claimId": z.string(), "text": z.string().max(1000), "status": z.enum(["verifiee","erreur","non_verifiable","non_factuelle"]), "aRisque": z.boolean(), "sources": z.array(z.object({ "passageId": z.string(), "url": z.string().url().regex(new RegExp("^https://")), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) })) })) }));

export const ReportRequestSchema = z.object({ "claimId": z.string().optional(), "comment": z.string().min(1).max(500) });

export const ReportValidateRequestSchema = z.object({ "decision": z.enum(["valide","rejete"]) });

export const ReportSchema = z.object({ "reportId": z.string(), "docId": z.string().optional(), "claimId": z.string().optional(), "status": z.enum(["ouvert","valide","rejete"]) });

export const QuestionSchema = z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string().max(1000), "choices": z.array(z.string().max(300)).min(4).max(4).optional() }).describe("Jamais de cle de reponse dans une question (test L3/L4).");

export const SessionSchema = z.object({ "docId": z.string(), "questions": z.array(z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string().max(1000), "choices": z.array(z.string().max(300)).min(4).max(4).optional() }).describe("Jamais de cle de reponse dans une question (test L3/L4).")) });

export const AnswerRequestSchema = z.object({ "questionId": z.string(), "choice": z.string().max(300) });

export const ProgressSchema = z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date(), "badges": z.array(z.string().regex(new RegExp("^[a-z0-9_]{1,40}$"))).describe("Identifiants de badges obtenus; catalogue dans docs/game-rules.md").optional() });

export const ReadResultSchema = z.object({ "xpGained": z.number().int().gte(0), "badges": z.array(z.string().regex(new RegExp("^[a-z0-9_]{1,40}$"))), "progress": z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date(), "badges": z.array(z.string().regex(new RegExp("^[a-z0-9_]{1,40}$"))).describe("Identifiants de badges obtenus; catalogue dans docs/game-rules.md").optional() }) });

export const ActivationRequestSchema = z.object({ "token": z.string().min(20).max(200), "password": z.string().min(12).max(128) });

export const AnswerResultSchema = z.object({ "correct": z.boolean(), "correctAnswer": z.string().describe("Revele seulement apres la reponse").optional(), "xpGained": z.number().int().gte(0), "badges": z.array(z.string()), "progress": z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date(), "badges": z.array(z.string().regex(new RegExp("^[a-z0-9_]{1,40}$"))).describe("Identifiants de badges obtenus; catalogue dans docs/game-rules.md").optional() }) });

export const MeSchema = z.object({ "userId": z.string(), "role": z.enum(["parent","eleve"]), "familyId": z.string(), "studentId": z.string().describe("Present pour le role eleve").optional(), "pseudo": z.string().optional() });

export const StudentSchema = z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) });

export const StudentCreateRequestSchema = z.object({ "pseudo": z.string().regex(new RegExp("^[A-Za-z][A-Za-z0-9 -]{1,19}$")).describe("Sans nom de famille"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "parentalAuthority": z.literal(true).describe("Case cochee par le parent (autorite parentale et lecture de la politique)"), "policyVersion": z.string().regex(new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).describe("Version de la politique affichee au parent. Refusee si ce n'est pas la version en vigueur.") });

export const PolicyVersionSchema = z.string().regex(new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).describe("Version de la politique affichee au parent. Refusee si ce n'est pas la version en vigueur.");

export const FamilyCreateRequestSchema = z.object({ "consent": z.literal(true), "policyVersion": z.string().regex(new RegExp("^[0-9]{4}-[0-9]{2}-[0-9]{2}$")).describe("Version de la politique affichee au parent. Refusee si ce n'est pas la version en vigueur.") });

export const InvitationCreatedSchema = z.object({ "code": z.string().regex(new RegExp("^[0-9a-f]{32}$")).describe("Code d'invitation en clair"), "createdAt": z.string().datetime({ offset: true }), "remainingToday": z.number().int().gte(0).lte(20).describe("Codes restants aujourd'hui pour cet administrateur.") });

export const ActivationLinkSchema = z.object({ "url": z.string().url(), "expiresAt": z.string().datetime({ offset: true }) });

export const StudentCreateResponseSchema = z.object({ "student": z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) }), "activationLink": z.object({ "url": z.string().url(), "expiresAt": z.string().datetime({ offset: true }) }) });

export const StudentUpdateRequestSchema = z.object({ "status": z.enum(["actif","suspendu"]).optional(), "pageQuota": z.number().int().gte(0).lte(50).optional(), "schoolLevel": z.enum(["seconde","premiere","terminale"]).optional() }).describe("Le pseudo et under15 ne se modifient pas (supprimer puis recreer l'eleve).");

export const DashboardSchema = z.object({ "students": z.array(z.object({ "student": z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) }), "progress": z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date(), "badges": z.array(z.string().regex(new RegExp("^[a-z0-9_]{1,40}$"))).describe("Identifiants de badges obtenus; catalogue dans docs/game-rules.md").optional() }) })), "familyPagesRemaining": z.number().int().gte(0), "familyPagesLimit": z.number().int().gte(0) });

export const LeaderboardSchema = z.object({ "week": z.string().regex(new RegExp("^[0-9]{4}-W[0-9]{2}$")), "entries": z.array(z.object({ "studentId": z.string(), "pseudo": z.string(), "xp": z.number().int().gte(0), "activeDays": z.number().int().gte(0).lte(7) })) });

export const FamilyExportSchema = z.object({ "familyId": z.string(), "exportedAt": z.string().datetime({ offset: true }), "parentEmail": z.string().optional(), "consentement": z.object({ "consentementLe": z.string().datetime({ offset: true }).optional(), "versionPolitique": z.string().optional() }).optional(), "students": z.array(z.intersection(z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) }), z.object({ "consentement": z.object({ "consentementLe": z.string().datetime({ offset: true }).optional(), "versionPolitique": z.string().optional() }).optional(), "createdAt": z.string().optional(), "profile": z.record(z.string(), z.any()).describe("Profil de jeu (XP, serie, badges, signalements valides)"), "activeDays": z.array(z.string()).describe("Jours (Paris) ou l'eleve a joue"), "attempts": z.array(z.object({ "questionId": z.string(), "date": z.string(), "attempts": z.number().int() })) }))), "docs": z.array(z.intersection(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) }), z.object({ "studentId": z.string(), "summary": z.string(), "claims": z.array(z.object({ "claimId": z.string(), "text": z.string().max(1000), "status": z.enum(["verifiee","erreur","non_verifiable","non_factuelle"]), "aRisque": z.boolean(), "sources": z.array(z.object({ "passageId": z.string(), "url": z.string().url().regex(new RegExp("^https://")), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) })) })), "questions": z.array(z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string(), "choices": z.array(z.string()).optional(), "answer": z.string() })) }))), "reports": z.array(z.object({ "reportId": z.string(), "docId": z.string(), "claimId": z.string().optional(), "studentId": z.string().optional(), "comment": z.string(), "status": z.enum(["ouvert","valide","rejete"]), "createdAt": z.string() })) });

export const ConsentSchema = z.object({ "consentementLe": z.string().datetime({ offset: true }).optional(), "versionPolitique": z.string().optional() });

export const StudentExportSchema = z.intersection(z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) }), z.object({ "consentement": z.object({ "consentementLe": z.string().datetime({ offset: true }).optional(), "versionPolitique": z.string().optional() }).optional(), "createdAt": z.string().optional(), "profile": z.record(z.string(), z.any()).describe("Profil de jeu (XP, serie, badges, signalements valides)"), "activeDays": z.array(z.string()).describe("Jours (Paris) ou l'eleve a joue"), "attempts": z.array(z.object({ "questionId": z.string(), "date": z.string(), "attempts": z.number().int() })) }));

export const ExportQuestionSchema = z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string(), "choices": z.array(z.string()).optional(), "answer": z.string() });

export const DocExportSchema = z.intersection(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) }), z.object({ "studentId": z.string(), "summary": z.string(), "claims": z.array(z.object({ "claimId": z.string(), "text": z.string().max(1000), "status": z.enum(["verifiee","erreur","non_verifiable","non_factuelle"]), "aRisque": z.boolean(), "sources": z.array(z.object({ "passageId": z.string(), "url": z.string().url().regex(new RegExp("^https://")), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) })) })), "questions": z.array(z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string(), "choices": z.array(z.string()).optional(), "answer": z.string() })) }));

export const ReportExportSchema = z.object({ "reportId": z.string(), "docId": z.string(), "claimId": z.string().optional(), "studentId": z.string().optional(), "comment": z.string(), "status": z.enum(["ouvert","valide","rejete"]), "createdAt": z.string() });

