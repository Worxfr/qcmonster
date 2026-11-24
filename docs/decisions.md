# Décisions du propriétaire

| # | Sujet | Décision |
|---|---|---|
| D1 | Architecture | Lambda + Step Functions à la place d'AgentCore. AgentCore reste possible plus tard. |
| D2 | Quotas de pages | En production : 20 pages par élève et par mois, 50 par famille, réglables par le parent. Multipliés par 10 en dev et test. |
| D3 | Inscription | Sur invitation seulement. Double authentification (MFA) proposée au parent. |
| D4 | Jeu d'essai | Vraies photos de cours fournies par le propriétaire, gardées hors du dépôt. |
| D5 | Budget | Cible inférieure à 20 EUR par mois, avec alerte. |
| D6 | Estimation de coût | Validée : environ 10 EUR par mois pour une famille, 17 EUR au pire. À confirmer par une mesure sur de vraies pages. |
| D7 | Compte AWS | Confirmé par le propriétaire, stocké en secret GitHub. |
| D8 | Région | Paris (UE). Modèles Claude sur Bedrock via profils d'inférence UE. |
| D9 | Comptes | Comptes élève et parent liés (Cognito). Le parent valide la création du compte élève. |
| D10 | Images | Supprimées à la confirmation du texte par l'élève, au plus tard après 1 jour. |
| D11 | Déploiement | GitHub vers AWS par OIDC. Le propriétaire lance lui-même le script d'amorçage. |
