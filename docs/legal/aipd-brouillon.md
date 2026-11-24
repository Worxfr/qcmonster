# Analyse d'impact (AIPD), brouillon

> **À faire valider par une personne compétente** (délégué à la protection des données, juriste ou conseil). Ce brouillon ne vaut pas validation. Cette validation est une condition de toute ouverture au-delà de la famille.

## 1. Pourquoi une AIPD ?

Les données concernent des **mineurs**, avec des **images de cours** traitées par une **IA**. Pour un usage familial privé, le registre suffit. Une ouverture plus large exige cette analyse.

## 2. Description

Voir `registre.md` (traitements T1 à T7) et `politique-confidentialite.md`.

## 3. Nécessité et proportionnalité

- Seules les données utiles sont collectées : pseudo, indicateur d'âge, cours, résultats.
- Pas d'e-mail ni de date de naissance pour les élèves.
- Images supprimées à la confirmation du texte par l'élève, au plus tard après 1 jour. Durées courtes pour les jobs (7 jours) et les extraits de sources web (30 jours). Journaux 14 jours, historique Step Functions 90 jours sans texte de cours.
- Fiches conservées jusqu'à suppression, à la demande du parent ou de l'élève.
- Aucun profilage publicitaire, aucune revente.

## 4. Risques et mesures

| Risque | Gravité | Probabilité | Mesures | Risque restant |
|---|---|---|---|---|
| Un élève met son nom ou des données personnelles dans un cours | Moyenne | Moyenne | Le parent est averti, les images sont supprimées, pas de contenu dans les journaux | À évaluer |
| Fuite de comptes | Élevée | Faible | Cognito, MFA proposé au parent, invitation seulement, chiffrement | À évaluer |
| Accès à des fiches d'une autre famille | Élevée | Faible | Isolation par famille, tests d'autorisation | À évaluer |
| Contenu de cours dans les journaux | Moyenne | Faible | Utilitaire de log restreint, test CI « aucun contenu », journalisation des invocations Bedrock désactivée | À évaluer |
| Erreur de l'IA (faux faits) présentée à un enfant | Moyenne | Moyenne | Vérification de sources par liste blanche, jeu d'essai | À évaluer |
| Perte de données (pas de PITR) | Faible | Faible | Risque accepté : rescanner les cours | Accepté |
| Document hors cours (photo de personne, document privé) | Moyenne | Faible | Type `autre` refusé, image supprimée au plus tard après 1 jour | À évaluer |
| Analyse par l'IA dans une autre région de l'UE que Paris | Faible | Moyenne | Profils d'inférence UE ; liste des régions à relever (lot 1) | À évaluer |
| Consentement parental non vérifié | Moyenne | Moyenne | Case d'autorité parentale, invitation seulement, parent seul créateur du compte élève | À évaluer |

## 5. Points ouverts pour la personne compétente

- Base légale et âge du consentement numérique (15 ans en France). Le parent crée toujours le compte, y compris pour un élève de 15 ans et plus.
- Vérification réelle de l'autorité parentale.
- Information adaptée aux mineurs.
- Nécessité de consulter la CNIL.
- Position du fournisseur de modèle et des conditions Marketplace (voir `sous-traitants.md`).

## 6. Validation

| Nom | Qualité | Date | Avis |
|---|---|---|---|
| (à compléter) | | | |
