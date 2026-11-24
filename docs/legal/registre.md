# Registre des traitements

*Registre simple, usage familial privé puis invitation. Responsable du traitement : le responsable de l'application (le propriétaire).*

| # | Traitement | Finalité | Personnes | Données | Base légale | Destinataires | Durée | Mesures |
|---|---|---|---|---|---|---|---|---|
| T1 | Comptes parents | Se connecter, gérer la famille | Parents | E-mail, mot de passe (géré par Cognito), MFA optionnel | Contrat / consentement | AWS (sous-traitant) | Jusqu'à suppression du compte | Invitation obligatoire, MFA proposé |
| T2 | Comptes élèves | Accès élève | Élèves, dont mineurs | Pseudo, indicateur « moins de 15 ans », identifiant famille | Consentement du titulaire de l'autorité parentale | AWS | Jusqu'à suppression | Pas d'e-mail ni de date de naissance, lien d'activation à usage unique de 24 h |
| T3 | Analyse de pages de cours | Lire une photo, vérifier, créer des fiches | Élèves | Image du cours, texte extrait | Consentement parental | AWS (stockage, calcul, modèles d'IA de Bedrock) | Image supprimée après analyse. Jobs 7 jours | Chiffrement, accès limité, aucun contenu dans les journaux |
| T4 | Fiches de révision | Réviser | Élèves | Fiches, textes, sources citées | Consentement parental | AWS | Jusqu'à suppression | Isolation par famille |
| T5 | Progression et XP | Suivi par l'élève et le parent | Élèves | Réponses, XP, passages | Consentement parental | Parent | Passages 30 jours | TTL DynamoDB |
| T6 | Quotas et coûts | Limiter les pages, contrôler le budget | Élèves, parents | Compteurs de pages, coût par job | Intérêt légitime | AWS | Selon les compteurs, sans contenu | Alerte de budget |
| T7 | Journaux techniques | Sécurité, diagnostic | Tous | Identifiant de job, étape, durée, statut | Intérêt légitime | AWS | 14 jours | Utilitaire de log restreint, test « aucun contenu » |

## Transferts hors UE

Aucun prévu. Stockage en région de Paris, modèles via profils d'inférence de l'UE. À revérifier à chaque changement de modèle.

## Sauvegardes

Pas de PITR DynamoDB. Risque accepté : une perte de données demande de rescanner les cours.

## Dernière mise à jour

À renseigner à chaque modification.
