# Politique de confidentialité de QCMonster

Cette page explique, simplement, ce que QCMonster fait de tes données. Elle est écrite pour les élèves et pour leurs parents.

**Version : 2026-11-26**

*Version de travail, à faire relire par une personne compétente avant toute ouverture au-delà de la famille.*

## C'est quoi QCMonster ?

Tu prends en photo une page de cours. L'application lit la page, vérifie les faits, puis crée des QCM et des textes à trous pour t'aider à réviser.

## Quelles données sont collectées ?

- **Le compte du parent** : adresse e-mail et mot de passe. Quand il crée sa famille ou un compte élève, l'application garde la **date de son accord** et la **version de cette politique** qu'il a acceptée. Une double authentification (application d'authentification) est proposée.
- **Le compte de l'élève** : un pseudo choisi par le parent, sans nom de famille (l'application y ajoute des lettres au hasard), et un mot de passe. L'application ne demande ni ne garde d'adresse e-mail pour l'élève. On garde seulement la réponse « moins de 15 ans : oui ou non ». Aucune date de naissance.
- **Les photos de cours** : envoyées pour être analysés.
- **Le texte du cours** lu sur la photo, corrigé par l'élève, et les **fiches** créées (QCM, textes à trous). Le **texte complet du cours est gardé dans l'espace de l'élève**, y compris les parties pour lesquelles l'élève a choisi de ne pas faire de fiche.
- **Tes résultats** : les réponses données, les points d'expérience (XP), les passages d'entraînement. Chaque passage de test est gardé (date, fiche, score, résultat et ta réponse à chaque question) pour que tu puisses revoir tes erreurs, année scolaire après année scolaire.
- **Des données techniques** : numéro du travail d'analyse, étape, durée, coût. Jamais le contenu de tes cours.
- **Des extraits de sites web** trouvés pour vérifier les faits de ton cours (texte de la source et son adresse).
- **Des mots de ton cours envoyés à Wikimédia** : pour vérifier un fait, l'application cherche sur Wikipédia, Wikibooks, Wikiversité et Vikidia (sites de la Fondation Wikimedia). Elle leur envoie **au plus 8 mots tirés de l'affirmation**, sans ton nom, ton pseudo ni aucun identifiant. Si un mot de ton cours est un nom de personne, il peut donc faire partie de cette recherche.

## Pourquoi et sur quelle règle ?

- Créer ton compte et te connecter.
- Transformer ton cours en fiches de révision.
- Te montrer ta progression et laisser le parent la suivre.
- Limiter le nombre de pages par mois et surveiller le coût.
- Garder l'application sûre.

Rien n'est utilisé pour de la publicité. Rien n'est vendu.

**Ton accord.** En France, à partir de 15 ans, tu peux donner toi-même ton accord pour utiliser un service comme celui-ci. Avant 15 ans, c'est un parent (titulaire de l'autorité parentale) qui donne l'accord, avec toi. Le parent crée toujours le compte. **L'accord peut être retiré à tout moment** : il suffit de le dire au parent ou au responsable, et le compte et ses données sont supprimés. Pour le suivi du budget et la sécurité, la règle est l'intérêt légitime de l'application.

## Combien de temps ?

| Donnée | Durée |
|---|---|
| Fiches | Jusqu'à suppression par le parent ou l'élève |
| Cours complet (texte lu et corrigé, sans la photo) | Jusqu'à ce que l'élève le supprime, ou que le compte de l'élève soit supprimé |
| Points d'expérience (XP), niveau, série et badges | Jusqu'à suppression du compte ou de l'élève |
| Historique des tests (date, fiche, score, résultat et réponse donnée à chaque question), classé par année scolaire (de septembre à août) | **Jusqu'à suppression** : il n'y a pas de durée automatique. Il est effacé tout de suite si la fiche, l'élève ou la famille est supprimé. Le parent peut le supprimer à tout moment en supprimant le compte de l'élève |
| Travaux d'analyse et copie de travail du texte lu sur les photos (suivi d'un scan en cours) | 7 jours, plus un délai technique d'au plus 2 jours (le cours complet gardé dans l'espace de l'élève est une autre copie, voir ci-dessus) |
| Extraits de sites web trouvés pour vérifier les faits | 30 jours, plus un délai technique d'au plus 2 jours |
| Photos envoyées | Supprimées dès que tu as confirmé le texte lu (tu as 12 heures pour le faire, sinon le scan est annulé et la photo supprimée), et au plus tard dans les 2 jours. Si le compte de l'élève est supprimé, ses photos encore présentes sont effacées au même moment |
| Journaux techniques | 14 jours en principe (sans contenu de cours) |
| Historique technique du traitement chez AWS | 90 jours (numéros de travaux et étapes, jamais le texte de tes cours) |

Il n'y a **pas de copie de secours automatique** de la base de données. Quand un compte est supprimé, les données sont effacées tout de suite, sans copie cachée. L'inconvénient : si des données sont perdues par accident, il faut rescanner les cours.

## Où sont les données ?

Chez Amazon Web Services (AWS), dans l'Union européenne. Tes données sont **stockées à Paris**. L'analyse par l'IA peut se faire dans une **autre région de l'Union européenne** que Paris, mais pas en dehors de l'UE.

## Qui voit les données ?

- Le parent voit les comptes de ses enfants et leur progression : les fiches étudiées, la date et le score de chaque test, **si chaque question est juste ou fausse**, les séries et les badges. Il ne voit **ni le texte des questions, ni les réponses que l'élève a données, ni le texte des cours**. Cette vue est en lecture seule et ne concerne que ses propres enfants. **Les réponses données ne sont lisibles que par l'élève.**
- Le responsable de l'application ne lit pas les cours des élèves. Il peut agir sur les comptes pour les supprimer ou corriger un problème.
- AWS, l'entreprise qui héberge l'application et fait tourner l'IA. On dit que c'est un « sous-traitant » : elle travaille pour nous, selon nos consignes, et n'a pas le droit d'utiliser tes données pour elle-même. Le détail est dans le dossier `docs/legal/` du projet.
- Personne d'autre. Aucune donnée n'est donnée ni vendue.

## Tes droits

Toi, ou ton parent, tu peux demander :

- à **voir** tes données : le parent peut télécharger dans l'application un fichier avec son e-mail, les comptes élèves (profil de jeu, jours de jeu, réponses), les fiches (affirmations, sources, questions et réponses) et les signalements. Ce fichier ne contient **pas le texte des cours** (ni le texte brut lu sur les photos) ni les extraits de sites web partagés : il indique seulement la structure de chaque cours et les fiches qui en viennent. **L'élève lit le texte complet de ses cours dans l'application** (écran « Cours complet »), c'est sa façon d'exercer son droit d'accès ;
- à les **corriger** : le parent peut changer le niveau d'un élève dans l'application. Pour changer un pseudo ou la réponse « moins de 15 ans », il faut **supprimer le compte de l'élève et le recréer** (les fiches et les cours sont alors perdus) ;
- à les **supprimer** (le parent peut supprimer le compte de l'élève ; l'effacement de la base est immédiat et comprend ses fiches, ses cours complets, ses résultats et ses signalements ; ses photos encore stockées sont effacées dans la même opération (au plus tard 2 jours si la suppression échoue, par la règle d'expiration du stockage) ; **l'élève peut aussi supprimer lui-même un cours**, en gardant ou en supprimant ses fiches, au choix, sans passer par le parent ; la copie de travail du texte, gardée 7 jours, est supprimée en même temps) ;
- à **limiter** ou t'**opposer** à leur utilisation (pour le budget et la sécurité) ;
- à **retirer ton accord** à tout moment ;
- à les **récupérer** dans un format lisible : le parent peut télécharger une **archive** (fichier zip) avec l'export et l'historique des tests de chaque élève (résultat de chaque question, **sans le texte des questions ni les réponses données**, sans texte de cours). Le lien de téléchargement ne marche que 10 minutes et le fichier est supprimé au plus tard 2 jours après.

Si tu as moins de 15 ans, c'est ton parent qui exerce ces droits avec toi. Une réponse t'est donnée **dans un délai d'un mois**. Si tu n'es pas d'accord avec la réponse, tu peux écrire à l'autorité de protection des données (la CNIL en France).

## Sécurité

Connexion chiffrée, mots de passe gérés par un service spécialisé, fichiers privés, accès limité au strict nécessaire, aucun contenu de cours dans les journaux.

## Contact

Écris au **responsable de l'application**. Ses coordonnées sont données au parent lors de son inscription sur invitation.

## Changements

Si cette politique change, les parents sont prévenus dans l'application.
