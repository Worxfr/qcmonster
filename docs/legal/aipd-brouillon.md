# Analyse d'impact (AIPD), brouillon

> **À faire valider par une personne compétente** (délégué à la protection des données, juriste ou conseil). Ce brouillon ne vaut pas validation. Cette validation est une condition de toute ouverture au-delà de la famille.

## 1. Pourquoi une AIPD ?

Les données concernent des **mineurs**, avec des **images de cours** traitées par une **IA**. Pour un usage familial privé, le registre suffit. Une ouverture plus large exige cette analyse.

## 2. Description

Voir `registre.md` (traitements T1 à T7) et `politique-confidentialite.md`.

## 3. Nécessité et proportionnalité

- Seules les données utiles sont collectées : identifiant de connexion, pseudo affiché (filtré : pas de mot grossier, pas d'adresse, au plus 2 chiffres ; jamais envoyé à un tiers), indicateur d'âge, cours, résultats.
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
| **Conservation de morceaux d'image du cours (schémas) d'un mineur** (R1, à valider ; **le repli « page entière » conserve une photo complète de la page**, avec ses écritures manuscrites ou noms éventuels, la consigne de ne pas proposer de zone manuscrite ne s'y applique pas : le choix reste explicite, par figure, et la page entière est signalée comme telle à l'élève) : un schéma peut contenir une écriture manuscrite, un nom ou un visage que le remplacement `[nom]` du texte ne couvre pas | Moyenne | Faible | Choix explicite de l'élève pour chaque schéma (rien gardé par défaut), découpage supprimé avec la photo s'il n'est pas gardé, métadonnées de l'image retirées, taille réduite, bucket privé chiffré, lien de 5 minutes pour l'élève seul, jamais lu ni exporté pour le parent (archive de l'élève seule, lien de 10 minutes, fichier supprimé sous 2 jours), suppression avec le cours, l'élève ou la famille | À évaluer |
| Texte du cours plus longtemps en copie de travail (12 h de confirmation, copie de travail 7 jours) | Faible | Moyenne | Suppression de la copie de travail avec le cours, photo supprimée à la confirmation | À évaluer |
| Perte de données (pas de PITR) | Faible | Faible | Risque accepté : rescanner les cours | Accepté |
| Document hors cours (photo de personne, document privé) | Moyenne | Faible | Type `autre` refusé, image supprimée au plus tard dans les 12 heures après l'envoi (2 jours au plus en secours) | À évaluer |
| Analyse par l'IA dans une autre région de l'UE que Paris | Faible | Moyenne | Profils d'inférence UE ; liste des régions à relever (lot 1) | À évaluer |
| Consentement parental non vérifié | Moyenne | Moyenne | Case d'autorité parentale, invitation seulement, parent seul créateur du compte élève | À évaluer |
| **Surveillance fine d'un mineur par le parent** (historique des tests : date, score et résultat juste ou faux de chaque question, sur plusieurs années scolaires) | Moyenne | Moyenne | Le parent ne voit **ni le texte des questions, ni les réponses données, ni le texte des cours** ; lecture seule ; limité à ses propres enfants (404 pour une autre famille) ; l'élève voit ce que voit le parent (information dans la politique) ; archive d'export sans réponses données ; suppression possible à tout moment (fiche, élève, famille). **À examiner : élève de 15 ans et plus, dont le parent voit quand même le même résumé (décision P7)** | À évaluer |
| **Conservation sans durée automatique de l'historique des tests** d'un mineur (décision D12) | Moyenne | Forte (tout élève actif) | Pas de texte de cours ni de question dans l'historique ; effacement immédiat et sans copie avec la fiche, l'élève ou la famille ; export complet ; rappel annuel au parent proposé (hors de ce lot). **Risque accepté par le propriétaire, durée maximale à reconsidérer si l'application s'ouvre au-delà de la famille** | À évaluer |

## 5. Points ouverts pour la personne compétente

- Base légale et âge du consentement numérique (15 ans en France). Le parent crée toujours le compte, y compris pour un élève de 15 ans et plus.
- Vérification réelle de l'autorité parentale.
- Information adaptée aux mineurs.
- Nécessité de consulter la CNIL.
- Historique des tests conservé **jusqu'à suppression**, sans durée automatique (choix du propriétaire, D12). À faire valider : proportionnalité d'une conservation de plusieurs années pour un mineur, et rappel annuel proposé au parent.
- **Droit d'accès du parent au cours et aux schémas de son enfant (point ouvert P16)** : l'archive du parent n'a ni le texte des cours, ni les schémas, ni les réponses données ; l'archive de l'élève a tout. À trancher avec la personne compétente avant toute ouverture au-delà de la famille.
- Position du fournisseur de modèle et des conditions Marketplace (voir `sous-traitants.md`).

## 6. Validation

| Nom | Qualité | Date | Avis |
|---|---|---|---|
| (à compléter) | | | |
