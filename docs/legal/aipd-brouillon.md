# Analyse d'impact (AIPD), brouillon

> **À faire valider par une personne compétente** (délégué à la protection des données, juriste ou conseil). Ce brouillon ne vaut pas validation. Cette validation est une condition de toute ouverture au-delà de la famille.

## 1. Pourquoi une AIPD ?

Les données concernent des **mineurs**, avec des **images de cours** traitées par une **IA**. Pour un usage familial privé, le registre suffit. Une ouverture plus large exige cette analyse.

## 2. Description

Voir `registre.md` (traitements T1 à T7) et `politique-confidentialite.md`.

## 3. Nécessité et proportionnalité

- Seules les données utiles sont collectées : pseudo, indicateur d'âge, cours, résultats.
- Pas d'e-mail ni de date de naissance pour les élèves.
- Images supprimées à la confirmation du texte par l'élève (12 heures pour confirmer, sinon le scan est annulé et l'image supprimée), au plus tard dans les 2 jours. **Texte complet corrigé du cours conservé sans durée automatique** (jusqu'à suppression par l'élève ou avec le compte), parties ignorées comprises ; le parent n'y a pas accès. Durées courtes pour les jobs (7 jours) et les extraits de sources web (30 jours). Journaux 14 jours, historique Step Functions 90 jours sans texte de cours.
- Vérification des faits : au plus 8 mots de l'affirmation sont envoyés aux sites Wikimedia (recherche), sans identifiant. Un nom de personne présent dans le cours peut en faire partie (risque à évaluer, §4).
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
| **Conservation durable du texte intégral des cours d'un mineur** (noms, remarques, notes écrites sur la page ; les noms de personnes sont remplacés par `[nom]` à la transcription mais l'élève peut en réécrire en corrigeant ; une partie « ignorée » reste conservée) | Moyenne | Moyenne | Remplacement des noms à la lecture, texte dans la partition de l'élève, jamais lu par le parent (ni écran ni export), suppression par l'élève (écran « Cours complet », deux choix explicites) ou avec le compte, chiffrement, aucun contenu dans les journaux, mention dans l'écran de découpe (« ignorée = gardée dans le cours complet »). Pas d'expiration automatique : **risque accepté ou durée d'inactivité à décider** | À évaluer |
| Texte du cours plus longtemps en copie de travail (12 h de confirmation, copie de travail 7 jours) | Faible | Moyenne | Suppression de la copie de travail avec le cours, photo supprimée à la confirmation | À évaluer |
| Perte de données (pas de PITR) | Faible | Faible | Risque accepté : rescanner les cours | Accepté |
| Document hors cours (photo de personne, document privé) | Moyenne | Faible | Type `autre` refusé, image supprimée au plus tard dans les 12 heures après l'envoi (2 jours au plus en secours) | À évaluer |
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
