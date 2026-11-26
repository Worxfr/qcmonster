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
| D10 bis | Cours complet et délai de confirmation | **Validé par le propriétaire le 2026-11-25.** L'élève découpe son cours en sections (une fiche par sujet). Le texte complet corrigé est conservé jusqu'à suppression par l'élève ou avec le compte, sans accès du parent (ni lecture ni export du texte). L'élève a 12 heures pour confirmer (au lieu de 30 minutes) : la photo est supprimée à la confirmation, donc D10 (« au plus tard après 1 jour ») reste vraie. |
| D11 | Déploiement | GitHub vers AWS par OIDC. Le propriétaire lance lui-même le script d'amorçage. |
| D12 | Historique des tests et vue parent (issues #44 et #45) | **Décidé par le propriétaire le 2026-11-25.** Historique de chaque passage de test conservé **jusqu'à suppression** (pas de durée automatique), classé par année scolaire (du 1er septembre au 31 août). La suppression d'une fiche supprime ses passages ; pas d'effacement partiel. Le parent voit le score et le résultat juste ou faux de chaque question, **sans texte de question ni réponse de l'élève** ; les réponses données ne sont lues que par l'élève. Même résumé pour les 15 ans et plus. Export sous forme d'archive téléchargeable (lien de 10 minutes). Voir `docs/H1-design.md`. |
