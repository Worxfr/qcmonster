# Regles du jeu (grille de points)

Source de verite pour L3 (`api/src/game/**`) et L4. Reprend `design.md` section 5 (v1) avec les changements de `docs/design-v2.md` section 7.
Tout se calcule cote serveur; le client n'envoie que des actions. Heure et jour: serveur, fuseau `Europe/Paris`.
Proprietaire de ce fichier: L1c (une demande de changement passe par une PR vers lui).

## 1. Points d'experience (XP)

| Action | XP | Limite |
|---|---|---|
| Scanner un cours et lire la fiche jusqu'au bout (`POST /docs/{docId}/read`) | **10 par page consommee dans le quota** | **2 pages payees par jour** (v2). Pas d'XP si la fiche est un doublon |
| QCM: bonne reponse du premier coup | 5 | une recompense par question |
| QCM: bonne reponse au 2e essai | 2 | |
| Texte a trous: mot correct | 5 | une recompense par question |
| Terminer une serie de 10 questions | +20 | |
| Serie parfaite (10/10) | +30 | pas de gain si la fiche contient une affirmation `erreur` ou `non_verifiable` |
| Revoir une fiche un autre jour que sa creation | 8 | 1 fois par fiche et par jour |
| Signalement d'erreur valide (valide par le parent) | 15 | |

**Plafond quotidien: 250 XP.** Au-dela, on peut repondre mais rien n'est gagne.

## 2. Niveaux

Seuil cumule du niveau `n`: `25 x n x (n + 1)` XP (50, 150, 300, 500, 750 pour les niveaux 1 a 5; 2 750 au niveau 10; 10 500 au niveau 20).
A 100-150 XP par jour: un niveau par jour la premiere semaine, niveau 5 vers le 6e jour, niveau 10 vers le 22e jour, niveau 20 vers le 84e jour.

## 3. Series de jours

- Un jour compte a partir de **30 XP**.
- **2 gels** par mois, stock maximum 2: un jour manque consomme un gel au lieu de casser la serie.
- Jours de repos designes par le parent: 3 par semaine au plus.
- Bonus: une serie de 7 jours donne **+2 pages** de quota (`addBonus` dans `shared/quota.ts`).
- Message de perte de serie: encourageant, jamais culpabilisant.

## 4. Badges (catalogue d'identifiants)

`Progress.badges` et `AnswerResult.badges` ne contiennent que ces identifiants (test a ecrire par L3 sur `answers-post`). Libelle affiche par le front.

| Identifiant | Condition |
|---|---|
| `premier_scan` | premiere fiche lue |
| `serie_7`, `serie_30` | 7 puis 30 jours de suite |
| `cent_bonnes_reponses` | 100 bonnes reponses |
| `serie_parfaite_x5` | 5 series parfaites |
| `chasseur_d_erreurs` | 1 signalement valide |
| `explorateur` | 5 matieres differentes dans le mois |
| `maitre_maths`, `maitre_physique`, `maitre_svt`, `maitre_histoire_geo`, `maitre_francais` | 500 XP dans la matiere |

## 5. Mascotte (stade selon le niveau)

| Stade (`Progress.stage`) | Niveaux |
|---|---|
| 1 oeuf | 0 |
| 2 bebe | 1-4 |
| 3 jeune | 5-9 |
| 4 confirme | 10-19 |
| 5 legendaire | 20 et plus |

Elle ne meurt jamais et ne s'attriste pas: si l'eleve s'absente, elle dort. Pas d'achat integre.

## 6. Classement familial

- Seulement entre eleves de la meme famille. Semaine du lundi au dimanche, remise a zero automatique.
- Classe sur l'XP des fiches verifiees. Variante « progression relative »: base = **max(moyenne des 4 semaines precedentes, 150 XP)**.
- Un eleve n'entre au classement qu'avec **au moins 3 jours actifs** dans la semaine.
- Vue parent: temps, series, matieres faibles. Aucune comparaison humiliante.

## 7. Anti-triche

1. Plafond quotidien d'XP (250) et de pages payees (2).
2. Une recompense par question, quelle que soit la fiche (`questionId` = `<docId>:<qcm|gap>:<nn>`).
3. Reponse recue **moins de 1 s** apres `shownAt`: rien. Serie de 10 questions finie en **moins de 20 s**: rien.
4. Fiche identique a une fiche deja scannee par la famille (Jaccard sur groupes de 5 mots, seuil 0,85): pas d'XP de scan.
5. Pas de bonus de serie parfaite sur les affirmations `erreur` ou `non_verifiable`.
6. Signalements valides par le parent.
7. Heure serveur pour les series.
8. Plus de **100 bonnes reponses en 10 minutes**: gains en quarantaine, parent notifie.
9. Les bonnes reponses ne sont **jamais** envoyees avant la reponse.

## 8. Texte a trous

Comparaison apres normalisation: minuscules, sans accents, espaces et ponctuation de bord retires. Aucune tolerance de faute dans la v1.
