# Registre des traitements

*Registre simple, usage familial privé puis invitation. Responsable du traitement : le responsable de l'application (le propriétaire). Version du 2026-11-24.*

| # | Traitement | Finalité | Personnes | Données | Base légale | Destinataires | Durée | Mesures |
|---|---|---|---|---|---|---|---|---|
| T1 | Comptes parents | Se connecter, gérer la famille | Parents | E-mail, mot de passe (géré par Cognito), MFA optionnel | Contrat (compte) ; consentement pour la double authentification | AWS (sous-traitant) | Jusqu'à suppression du compte | Invitation obligatoire, MFA proposé |
| T2 | Comptes élèves | Accès élève | Élèves, dont mineurs | Pseudo, indicateur « moins de 15 ans », identifiant famille | Moins de 15 ans : consentement du titulaire de l'autorité parentale (art. 45 loi Informatique et Libertés). 15 ans et plus : consentement de l'élève. Le parent crée toujours le compte. Retrait du consentement possible à tout moment (suppression du compte) | AWS | Jusqu'à suppression | Pas d'e-mail ni de date de naissance, lien d'activation à usage unique de 24 h |
| T3 | Analyse de pages de cours | Lire une photo, vérifier, créer des fiches | Élèves | Image du cours, texte extrait, **texte complet corrigé du cours (y compris les parties ignorées)** | Même règle que T2 | AWS (stockage, calcul, modèles d'IA de Bedrock). Analyse possible dans une autre région de l'UE que Paris | Image supprimée à la confirmation du texte par l'élève, ou après **12 heures** sans réponse, et au plus tard 2 jours (cycle de vie S3 quotidien). **Texte complet corrigé du cours : conservé jusqu'à suppression par l'élève, ou avec le compte de l'élève ou de la famille (comme les fiches), sans durée automatique ; le parent ne lit pas ce texte (ni lecture, ni export).** Jobs 7 jours, plus un délai technique d au plus 2 jours. Extraits de sources web (`PASSAGE`) et cache de verdicts : 30 jours. **Destinataire** : sites Wikimedia (au plus 8 mots par affirmation, sans identifiant) | Chiffrement, accès limité, aucun contenu dans les journaux, texte du cours dans la partition de l'élève (jamais lu par le parent), suppression par l'élève (écran « Cours complet ») ou avec le compte |
| T4 | Fiches de révision | Réviser | Élèves | Fiches, textes, sources citées | Même règle que T2 | AWS | Jusqu'à suppression | Isolation par famille |
| T5 | Progression et XP | Suivi par l'élève et le parent | Élèves | Tentatives (réponses), profil de jeu, XP | Même règle que T2 | Parent ; AWS (sous-traitant) | Jusqu'à suppression (durée à décider par le propriétaire) | Isolation par famille |
| T6 | Quotas et coûts | Limiter les pages, contrôler le budget | Élèves, parents | Compteurs de pages, coût par job | Intérêt légitime | AWS | Selon les compteurs, sans contenu | Alerte de budget |
| T7 | Journaux techniques | Sécurité, diagnostic | Tous | Identifiant de job, étape, durée, statut | Intérêt légitime | AWS | Journaux : 14 jours (hypothèse du design). Historique Step Functions : 90 jours, avec identifiants de jobs mais sans texte de cours | Utilitaire de log restreint, test « aucun contenu », journalisation sans données d'exécution |

## Transferts hors UE

Aucun transfert hors UE prévu. Stockage à Paris. Les profils d'inférence de l'UE peuvent faire traiter la requête dans une autre région de l'UE que Paris. **À faire (lot 1, avant l'AIPD) : relever la liste réelle des régions de destination du profil.** À revérifier à chaque changement de modèle.

## Sauvegardes

Pas de PITR DynamoDB. Risque accepté : une perte de données demande de rescanner les cours.

## Dernière mise à jour

2026-11-24. À renseigner à chaque modification.
