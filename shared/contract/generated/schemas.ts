// GENERE par scripts/gen-contract.ts depuis shared/contract/openapi.yaml. NE PAS EDITER.
import { z } from 'zod';

export const ErrorSchema = z.object({ "code": z.enum(["requete_invalide","interdit","introuvable","etat_invalide","quota_epuise","budget_epuise"]), "message": z.string().max(500), "resetDate": z.string().date().describe("Remise a zero du quota (1er du mois a Paris)").optional() });

export const JobStateSchema = z.enum(["en_attente_envoi","verification_fichier","transcription","a_confirmer","verification","generation","termine","rejete","echec","expire"]);

export const JobSchema = z.object({ "jobId": z.string(), "state": z.enum(["en_attente_envoi","verification_fichier","transcription","a_confirmer","verification","generation","termine","rejete","echec","expire"]), "pages": z.number().int().gte(1).lte(10), "createdAt": z.string().datetime({ offset: true }), "durationSeconds": z.number().int().gte(0).optional(), "docId": z.string().describe("Present quand state = termine").optional(), "message": z.string().max(500).optional() });

export const ScanCreateRequestSchema = z.object({ "pages": z.number().int().gte(1).lte(10).describe("Une image = 1 page; un PDF = son nombre de pages (10 max)"), "contentType": z.enum(["image/jpeg","image/png","application/pdf"]) });

export const ScanCreateResponseSchema = z.object({ "jobId": z.string(), "upload": z.object({ "url": z.string().url(), "fields": z.record(z.string(), z.string()) }), "expiresAt": z.string().datetime({ offset: true }), "pagesRemaining": z.number().int().gte(0) });

export const SentenceSchema = z.object({ "id": z.string().regex(new RegExp("^p[0-9]+-s[0-9]+$")), "text": z.string().max(2000) });

export const TranscriptionSchema = z.object({ "jobId": z.string(), "docType": z.enum(["cours","exercice","autre"]), "pages": z.array(z.object({ "page": z.number().int().gte(1), "sentences": z.array(z.object({ "id": z.string().regex(new RegExp("^p[0-9]+-s[0-9]+$")), "text": z.string().max(2000) })) })), "photoUrls": z.array(z.string().url()), "photoUrlsExpireAt": z.string().datetime({ offset: true }) });

export const ConfirmRequestSchema = z.object({ "corrections": z.array(z.object({ "id": z.string().regex(new RegExp("^p[0-9]+-s[0-9]+$")), "text": z.string().max(2000) })).max(500) });

export const DocSummarySchema = z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) });

export const DocListSchema = z.object({ "items": z.array(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) })) });

export const SourceSchema = z.object({ "passageId": z.string(), "url": z.string().url(), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) });

export const ClaimSchema = z.object({ "claimId": z.string(), "text": z.string().max(1000), "status": z.enum(["verifiee","erreur","non_verifiable","non_factuelle"]), "aRisque": z.boolean(), "sources": z.array(z.object({ "passageId": z.string(), "url": z.string().url(), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) })) });

export const DocSchema = z.intersection(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) }), z.object({ "summary": z.string(), "claims": z.array(z.object({ "claimId": z.string(), "text": z.string().max(1000), "status": z.enum(["verifiee","erreur","non_verifiable","non_factuelle"]), "aRisque": z.boolean(), "sources": z.array(z.object({ "passageId": z.string(), "url": z.string().url(), "site": z.string(), "titre": z.string(), "extrait": z.string().max(1000), "niveau": z.number().int().gte(1).lte(3) })) })) }));

export const ReportRequestSchema = z.object({ "claimId": z.string().optional(), "comment": z.string().min(1).max(500) });

export const ReportValidateRequestSchema = z.object({ "decision": z.enum(["valide","rejete"]) });

export const ReportSchema = z.object({ "reportId": z.string(), "status": z.enum(["ouvert","valide","rejete"]) });

export const QuestionSchema = z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string().max(1000), "choices": z.array(z.string().max(300)).min(4).max(4).optional() }).describe("Jamais de cle de reponse dans une question (test L3/L4).");

export const SessionSchema = z.object({ "docId": z.string(), "questions": z.array(z.object({ "questionId": z.string(), "kind": z.enum(["qcm","gap"]), "prompt": z.string().max(1000), "choices": z.array(z.string().max(300)).min(4).max(4).optional() }).describe("Jamais de cle de reponse dans une question (test L3/L4).")) });

export const AnswerRequestSchema = z.object({ "questionId": z.string(), "choice": z.string().max(300) });

export const ProgressSchema = z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date() });

export const AnswerResultSchema = z.object({ "correct": z.boolean(), "correctAnswer": z.string().describe("Revele seulement apres la reponse").optional(), "xpGained": z.number().int().gte(0), "badges": z.array(z.string()), "progress": z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date() }) });

export const MeSchema = z.object({ "userId": z.string(), "role": z.enum(["parent","eleve"]), "familyId": z.string(), "studentId": z.string().describe("Present pour le role eleve").optional(), "pseudo": z.string().optional() });

export const StudentSchema = z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) });

export const StudentCreateRequestSchema = z.object({ "pseudo": z.string().regex(new RegExp("^[A-Za-z][A-Za-z0-9 -]{1,19}$")).describe("Sans nom de famille"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "parentalAuthority": z.literal(true) });

export const ActivationLinkSchema = z.object({ "url": z.string().url(), "expiresAt": z.string().datetime({ offset: true }) });

export const StudentCreateResponseSchema = z.object({ "student": z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) }), "activationLink": z.object({ "url": z.string().url(), "expiresAt": z.string().datetime({ offset: true }) }) });

export const StudentUpdateRequestSchema = z.object({ "status": z.enum(["actif","suspendu"]).optional(), "pageQuota": z.number().int().gte(0).lte(50).optional() });

export const DashboardSchema = z.object({ "students": z.array(z.object({ "student": z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) }), "progress": z.object({ "xp": z.number().int().gte(0), "level": z.number().int().gte(0), "streakDays": z.number().int().gte(0), "freezes": z.number().int().gte(0), "stage": z.number().int().gte(1).lte(5), "pagesRemaining": z.number().int().gte(0), "pagesLimit": z.number().int().gte(0), "resetDate": z.string().date() }) })), "familyPagesRemaining": z.number().int().gte(0), "familyPagesLimit": z.number().int().gte(0) });

export const LeaderboardSchema = z.object({ "week": z.string().regex(new RegExp("^[0-9]{4}-W[0-9]{2}$")), "entries": z.array(z.object({ "studentId": z.string(), "pseudo": z.string(), "xp": z.number().int().gte(0), "activeDays": z.number().int().gte(0).lte(7) })) });

export const FamilyExportSchema = z.object({ "familyId": z.string(), "exportedAt": z.string().datetime({ offset: true }), "students": z.array(z.object({ "studentId": z.string(), "pseudo": z.string().describe("Pseudo avec suffixe aleatoire (Lila-7k2f)"), "schoolLevel": z.enum(["seconde","premiere","terminale"]), "under15": z.boolean(), "status": z.enum(["actif","suspendu"]), "pageQuota": z.number().int().gte(0).lte(50) })), "docs": z.array(z.object({ "docId": z.string(), "title": z.string().max(200), "subject": z.enum(["maths","physique","svt","histoire_geo","francais","autre"]), "createdAt": z.string().datetime({ offset: true }) })) });

