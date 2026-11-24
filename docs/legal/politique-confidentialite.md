# Politique de confidentialité de QCMonster

Cette page explique, simplement, ce que QCMonster fait de tes données. Elle est écrite pour les élèves et pour leurs parents.

*Version de travail, à faire relire par une personne compétente avant toute ouverture au-delà de la famille.*

## C'est quoi QCMonster ?

Tu prends en photo une page de cours. L'application lit la page, vérifie les faits, puis crée des QCM et des textes à trous pour t'aider à réviser.

## Quelles données sont collectées ?

- **Le compte du parent** : adresse e-mail et mot de passe. Une double authentification (application d'authentification) est proposée.
- **Le compte de l'élève** : un pseudo choisi par le parent, sans nom de famille (l'application y ajoute des lettres au hasard), et un mot de passe. Aucune adresse e-mail d'élève. On garde seulement la réponse « moins de 15 ans : oui ou non ». Aucune date de naissance.
- **Les photos et PDF de cours** : envoyés pour être analysés.
- **Le texte du cours** lu sur la photo, et les **fiches** créées (QCM, textes à trous).
- **Tes résultats** : les réponses données, les points d'expérience (XP), les passages d'entraînement.
- **Des données techniques** : identifiant du travail, étape, durée, coût. Jamais le contenu de tes cours.

## Pourquoi ?

- Créer ton compte et te connecter.
- Transformer ton cours en fiches de révision.
- Te montrer ta progression et laisser le parent la suivre.
- Limiter le nombre de pages par mois et surveiller le coût.
- Garder l'application sûre.

Rien n'est utilisé pour de la publicité. Rien n'est vendu.

## Combien de temps ?

| Donnée | Durée |
|---|---|
| Fiches et textes de cours | Jusqu'à suppression par le parent ou l'élève |
| Travaux d'analyse (jobs) | 7 jours |
| Passages d'entraînement | 30 jours |
| Photos et PDF envoyés | Supprimés dès que l'analyse est finie |
| Journaux techniques | 14 jours (sans contenu de cours) |

Il n'y a **pas de sauvegarde à la minute** (pas de PITR). Quand un compte est supprimé, les données sont effacées tout de suite, sans copie cachée. L'inconvénient : si des données sont perdues par accident, il faut rescanner les cours.

## Où sont les données ?

Chez Amazon Web Services (AWS), dans l'Union européenne. Les données sont stockées en région de Paris. Les modèles d'IA sont appelés par des profils d'inférence de l'UE : le traitement reste dans l'UE.

## Qui voit les données ?

- Le parent voit les comptes de ses enfants et leur progression.
- Le responsable de l'application ne lit pas les cours des élèves. Il peut agir sur les comptes pour les supprimer ou corriger un problème.
- AWS héberge et fait fonctionner l'application (sous-traitant). Voir `sous-traitants.md`.
- Personne d'autre. Aucune donnée n'est donnée ni vendue.

## Tes droits

Toi, ou ton parent, tu peux demander :

- à **voir** tes données ;
- à les **corriger** ;
- à les **supprimer** (le parent peut supprimer le compte de l'élève, l'effacement est immédiat) ;
- à **limiter** ou t'**opposer** à leur utilisation ;
- à les **récupérer** dans un format lisible.

Si tu as moins de 15 ans, c'est ton parent qui exerce ces droits avec toi. Tu peux aussi saisir l'autorité de protection des données (la CNIL en France).

## Sécurité

Connexion chiffrée, mots de passe gérés par un service spécialisé, fichiers privés, accès limité au strict nécessaire, aucun contenu de cours dans les journaux.

## Contact

Écris au **responsable de l'application** (les coordonnées sont données au parent lors de son inscription sur invitation).

## Changements

Si cette politique change, les parents sont prévenus dans l'application.
