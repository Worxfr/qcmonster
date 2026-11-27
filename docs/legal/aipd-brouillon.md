# Analyse d'impact (AIPD), brouillon

> **À faire valider par une personne compétente** (délégué à la protection des données, juriste ou conseil). Ce brouillon ne vaut pas validation. Cette validation est une condition de toute ouverture au-delà de la famille.

## 1. Pourquoi une AIPD ?

Les données concernent des **mineurs**, avec des **images de cours** traitées par une **IA**. Pour un usage familial privé, le registre suffit. Une ouverture plus large exige cette analyse.

## 2. Description

Voir `registre.md` (traitements T1 à T8) et `politique-confidentialite.md`.

## 3. Nécessité et proportionnalité

- Seules les données utiles sont collectées : identifiant de connexion, pseudo affiché (filtré : pas de mot grossier, pas d'adresse, au plus 2 chiffres ; jamais envoyé à un tiers), indicateur d'âge, cours, résultats.
- Pas d'e-mail ni de date de naissance pour les élèves.
- Images supprimées à la confirmation du texte par l'élève (12 heures pour confirmer, sinon le scan est annulé et l'image supprimée), au plus tard dans les 2 jours. **Texte complet corrigé du cours conservé sans durée automatique** (jusqu'à suppression par l'élève ou avec le compte), parties ignorées comprises ; le parent n'y a pas accès. **Volume maximal par élève : 30 pages par cours** (ajout de pages en plusieurs envois de 10 pages au plus, même conservation ; au premier ajout, les deux dernières phrases du cours repartent vers le modèle de Bedrock, même sous-traitant). **Modification d'un cours confirmé (M1 #90), prévue, pas encore ouverte : seules les phrases modifiées, plus jusqu'à deux phrases de contexte avant la première phrase modifiée de la partie (lecture seule), repartiront vers Bedrock ; copie de travail de 7 jours ; affirmations et questions retirées gardées jusqu'à la suppression de la fiche, jamais tirées ni exportées, visibles seulement dans l'historique de l'élève (risque d'un texte erroné conservé : mesure = elles ne sortent plus).** Durées courtes pour les jobs (7 jours) et les extraits de sources web (30 jours). Journaux 14 jours, historique Step Functions 90 jours sans texte de cours.
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
| **Conservation de morceaux d'image du cours (schémas) d'un mineur** (R1 ; **le repli « page entière » conserve une photo complète de la page**, avec ses écritures manuscrites ou noms éventuels, la consigne de ne pas proposer de zone manuscrite ne s'y applique pas : le choix reste explicite, par figure, et la page entière est signalée comme telle à l'élève) : un schéma peut contenir une écriture manuscrite, un nom ou un visage que le remplacement `[nom]` du texte ne couvre pas | Moyenne | Faible | Choix explicite de l'élève pour chaque schéma (rien gardé par défaut), découpage supprimé avec la photo s'il n'est pas gardé, métadonnées de l'image retirées, taille réduite, bucket privé chiffré, lien de 5 minutes pour l'élève seul, jamais lu ni exporté pour le parent (l'archive de l'élève, qui les contient, existe : voir §5), suppression avec le cours, l'élève ou la famille | À évaluer |
| Texte du cours plus longtemps en copie de travail (12 h de confirmation, copie de travail 7 jours) | Faible | Moyenne | Suppression de la copie de travail avec le cours, photo supprimée à la confirmation | À évaluer |
| Perte de données (pas de PITR) | Faible | Faible | Risque accepté : rescanner les cours | Accepté |
| Document hors cours (photo de personne, document privé) | Moyenne | Faible | Type `autre` refusé, image supprimée au plus tard dans les 12 heures après l'envoi (2 jours au plus en secours) | À évaluer |
| Analyse par l'IA dans une autre région de l'UE que Paris | Faible | Moyenne | Profils d'inférence UE ; liste des régions à relever (lot 1) | À évaluer |
| Consentement parental non vérifié | Moyenne | Moyenne | Case d'autorité parentale, invitation seulement, parent seul créateur du compte élève | À évaluer |
| **Surveillance fine d'un mineur par le parent** (historique des tests : date, score et résultat juste ou faux de chaque question, nom du dossier choisi par l'élève, sur plusieurs années scolaires) | Moyenne | Moyenne | Le parent ne voit **ni le texte des questions, ni les réponses données, ni le texte des cours** ; lecture seule ; limité à ses propres enfants (404 pour une autre famille) ; l'élève voit ce que voit le parent (information dans la politique) ; archive d'export sans réponses données ; suppression possible à tout moment (fiche, élève, famille). **À examiner : élève de 15 ans et plus, dont le parent voit quand même le même résumé (décision P7)** | À évaluer |
| **Conservation sans durée automatique de l'historique des tests** d'un mineur (décision D12) | Moyenne | Forte (tout élève actif) | Pas de texte de cours ni de question dans l'historique ; effacement immédiat et sans copie avec la fiche, l'élève ou la famille ; export complet ; rappel annuel au parent proposé (hors de ce lot). **Risque accepté par le propriétaire, durée maximale à reconsidérer si l'application s'ouvre au-delà de la famille** | À évaluer |
| **Photo manuscrite d'un élève mineur envoyée à un modèle d'IA** (exercices corrigés, E1 ; peut contenir un nom, un visage, une remarque personnelle) | Moyenne | Moyenne | Photo ré-encodée sans métadonnées, **supprimée dès la fin de la correction** (au plus 2 jours dans tous les cas), texte lu **non conservé**, consigne de ne pas transcrire l'en-tête, Bedrock dans l'UE seulement, aucun journal de contenu, 3 pages au plus et 5 corrections par jour | À évaluer |
| **Évaluation automatisée d'un mineur** (note et conseils par IA, E1) | Faible | Moyenne | Aucune décision à effet juridique ni profilage : seulement des points de jeu ; la note est calculée par le code et non par le modèle ; message « peut se tromper » ; solution disponible. **Si ces notes servaient un jour à autre chose, prévoir une intervention humaine** | À évaluer |
| **Correction fausse qui décourage ou trompe l'élève** (E1) | Moyenne | Moyenne | Exercices vérifiés par une double résolution, solution montrée à la demande, parent sans accès au détail, mesure sur des copies factices avant ouverture | À évaluer |
| **Texte d'un mineur diffusé par un lien public** (partage de QCM, S1 ; titre libre, énoncés dérivés du cours qu'il a pu corriger) | Moyenne | Moyenne | Partage désactivé par défaut et activé par le parent ; copie sans identité ; filtre des adresses, téléphones, pseudos et identifiants de la famille ; titre filtré ; aperçu avant création ; 30 jours au plus ; révocation immédiate. **Un nom propre dans un énoncé n'est pas détecté** | À évaluer |
| **Lien de partage transmis plus loin que prévu** (S1) | Moyenne | Moyenne | Jeton de 128 bits non stocké (empreinte seule), expiration de 30 jours au plus, plafond de 1 000 lectures par jour, révocation immédiate, aucune donnée d'identité derrière le lien. **Limite : un lien déjà ouvert reste lisible dans l'onglet du destinataire jusqu'à sa fermeture ; on ne peut pas empêcher de recopier les questions** | Accepté |
| **Contenu inapproprié ou droits d'auteur d'un cours partagé** (S1) | Moyenne | Faible | Filtre à la création, signalement, suspension automatique à 3 signalements (le signalement exige le lien : un tiers sans lien ne peut pas suspendre ; un détenteur du lien peut suspendre en 3 appels, risque accepté), information du parent (état et nombre de signalements dans la liste), questions vérifiées sans texte du cours ni figure ; mention « non relu par un enseignant ». Un signalement ne garde que le motif et la date, 30 jours au plus | À évaluer ; pas de modération humaine |
| **Accès à d'autres données par la route publique de partage** (S1) | Élevée | Faible | Copie dans une partition à part, sans identifiant de l'élève, de la famille, du cours ni de la fiche ; rôle de la route publique limité à cette partition (lecture, écriture et ajout d'un élément, aucune recherche, aucune lecture de fiche, de clé de réponse ni de compte), test « droits déclarés = droits réels » ; suppression de la copie **avant** la fiche, filet de 32 jours au plus. **Limite : un lien créé pendant la suppression de la fiche peut survivre jusqu'à son échéance (32 jours au plus)** ; **les rôles du pipeline atteignent toute la table (ticket de resserrement à traiter avant l'ouverture)** | Faible |

## 5. Points ouverts pour la personne compétente

- Base légale et âge du consentement numérique (15 ans en France). Le parent crée toujours le compte, y compris pour un élève de 15 ans et plus.
- Vérification réelle de l'autorité parentale.
- Information adaptée aux mineurs.
- Nécessité de consulter la CNIL.
- Historique des tests conservé **jusqu'à suppression**, sans durée automatique (choix du propriétaire, D12). À faire valider : proportionnalité d'une conservation de plusieurs années pour un mineur, et rappel annuel proposé au parent.
- **Droit d'accès du parent au cours et aux schémas de son enfant (point ouvert P16)** : l'archive du parent n'a ni le texte des cours, ni les schémas, ni les réponses données ; l'archive de l'élève (construite) contient tout. À trancher avec la personne compétente avant toute ouverture au-delà de la famille.
- Position du fournisseur de modèle et des conditions Marketplace (voir `sous-traitants.md`). **Détection d'abus de Bedrock** : AWS peut, dans des cas limités (notamment détection de contenus pédopornographiques dans les images), conserver et examiner une entrée ; à accepter ou non pour des photos de cours de mineurs.
- **Partage de QCM par lien (S1, #34)** : première donnée lisible hors de la famille, par une personne sans compte, y compris un enfant. À trancher avec la personne compétente : droits d'auteur d'un cours d'enseignant, détection des noms propres, partage à des mineurs d'autres familles, forme de l'accord du parent (réglage par élève).
- **Partage de QCM, état au 2026-11-27** : l'API est livrée avec l'interrupteur fermé, sans écran ; l'export des liens (S1-P15) n'est pas encore dans le code. Le filtre des données personnelles n'est pas mesuré sur de vraies questions.
- **Textes publiés avant les fonctions** : la modification d'un cours confirmé (M1 #90) est décrite dans la politique alors que son interrupteur est fermé. À ouvrir seulement avec la version 2026-11-28 en vigueur ; à vérifier avant chaque déploiement que le texte ne promet que ce qui existe.

## 6. Validation

| Nom | Qualité | Date | Avis |
|---|---|---|---|
| (à compléter) | | | |
