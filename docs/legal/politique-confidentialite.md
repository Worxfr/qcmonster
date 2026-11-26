# Politique de confidentialité de QCMonster

Cette page explique, simplement, ce que QCMonster fait de tes données. Elle est écrite pour les élèves et pour leurs parents.

**Version : 2026-11-28**

*Version de travail, à faire relire par une personne compétente avant toute ouverture au-delà de la famille.*

## C'est quoi QCMonster ?

Tu prends en photo une page de cours. L'application lit la page, vérifie les faits, puis crée des QCM et des textes à trous pour t'aider à réviser.

## Quelles données sont collectées ?

- **Le compte du parent** : adresse e-mail et mot de passe. Quand il crée sa famille ou un compte élève, l'application garde la **date de son accord** et la **version de cette politique** qu'il a acceptée. Une double authentification (application d'authentification) est proposée.
- **Le compte de l'élève** : un **identifiant de connexion** fabriqué par l'application (le surnom de départ donné par le parent, sans nom de famille, auquel l'application ajoute des lettres au hasard), un **pseudo affiché** que l'élève choisit à l'activation de son compte (le parent peut le changer ensuite) et un mot de passe. Le pseudo reste dans la famille : il n'est ni envoyé à un tiers ni gardé dans les journaux. L'application ne demande ni ne garde d'adresse e-mail pour l'élève. On garde seulement la réponse « moins de 15 ans : oui ou non ». Aucune date de naissance.
- **Les photos de cours** : envoyées pour être analysées. Chaque envoi (10 pages au plus) est traité et confirmé séparément, y compris quand c'est un ajout à un cours existant.
- **Le texte du cours** lu sur la photo, corrigé par l'élève, et les **fiches** créées (QCM, textes à trous). Le **texte complet du cours est gardé dans l'espace de l'élève**, y compris les parties pour lesquelles l'élève a choisi de ne pas faire de fiche. Les **phrases que l'élève retire** à la relecture ne sont pas gardées. Les **phrases qu'il ajoute** à la relecture (pour un oubli) sont traitées comme celles lues sur la photo : elles sont envoyées au modèle de Bedrock pour être vérifiées, puis gardées avec le cours. Les **formules** sont gardées comme du texte. L'élève peut **ajouter des pages à un cours déjà scanné** (30 pages au plus par cours) : le texte ajouté est gardé comme le reste du cours, avec la même durée. Pour lire la suite correctement, l'application renvoie à l'IA (chez AWS, comme pour tout le reste) les **deux dernières phrases** du cours déjà gardé. **Bientôt, tu pourras modifier un cours déjà confirmé** (corriger, retirer ou ajouter des phrases). Quand cette fonction sera disponible, les phrases que tu changeras seront envoyées au modèle de Bedrock pour être vérifiées, comme à la relecture, avec jusqu'à deux phrases qui précèdent la première phrase changée de la partie. Ces phrases servent seulement à comprendre le contexte : elles sont lues, et aucune affirmation n'en est gardée. Les anciennes questions touchées ne te seront plus posées ni exportées ; elles resteront visibles seulement dans ton historique de tests, et seront effacées avec la fiche.
- **Les schémas du cours** : quand ton cours contient un schéma, un graphique ou une carte, l'application peut en proposer un **découpage** (un morceau de ta photo) et une courte description. **Rien n'est gardé sans ton choix** : tu gardes ou tu retires chaque schéma au moment de relire ton texte. Un schéma gardé est un morceau de ta photo (parfois la page entière si le schéma n'a pas pu être découpé), sans les informations cachées de la photo (lieu, appareil). Il est lisible par toi seul, pas par ton parent.
- **Les copies d'exercices** : pour certains exercices (maths, physique-chimie), tu peux **photographier ta copie** pour qu'elle soit corrigée étape par étape par une intelligence artificielle (Amazon Bedrock, dans l'Union européenne). **La photo est supprimée dès la fin de la correction**, et au plus tard dans les 2 jours. **Le texte lu sur ta copie n'est pas conservé.** Ce qui reste : pour chaque étape, si elle est juste ou non, un court conseil, ta note et tes points. Évite d'écrire ton nom ou des informations personnelles sur ta copie. La correction peut se tromper.
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
| Schémas gardés du cours (morceaux de la photo, avec leur description) | Comme le cours complet : jusqu'à ce que l'élève supprime le cours, ou que le compte de l'élève soit supprimé. Supprimer le cours supprime ses schémas, même si les fiches sont gardées. Les morceaux que tu n'as pas gardés sont supprimés avec la photo |
| Points d'expérience (XP), niveau, série et badges | Jusqu'à suppression du compte ou de l'élève |
| Historique des tests (date, fiche, plusieurs fiches ou nom du dossier choisi, score, résultat et réponse donnée à chaque question), classé par année scolaire (de septembre à août) | **Jusqu'à suppression** : il n'y a pas de durée automatique. Il est effacé tout de suite si la fiche, l'élève ou la famille est supprimé (pour un passage sur plusieurs fiches, seules les lignes de la fiche supprimée sont retirées). Le parent peut le supprimer à tout moment en supprimant le compte de l'élève |
| Quand la fonction « modifier un cours » sera disponible : copie de travail d'une modification (les phrases que tu changes, pendant la modification) | 7 jours au plus, supprimée dès que la modification est finie ou annulée |
| Travaux d'analyse et copie de travail du texte lu sur les photos (suivi d'un scan en cours) | 7 jours, plus un délai technique d'au plus 2 jours (le cours complet gardé dans l'espace de l'élève est une autre copie, voir ci-dessus) |
| Extraits de sites web trouvés pour vérifier les faits | 30 jours, plus un délai technique d'au plus 2 jours |
| Photos envoyées | Supprimées (avec les découpages de schémas non gardés) dès que tu as confirmé le texte lu (tu as 12 heures pour le faire, sinon le scan est annulé et la photo supprimée), et au plus tard dans les 2 jours. Si le compte de l'élève est supprimé, ses photos encore présentes sont effacées au même moment |
| Photos de copies d'exercices | Supprimées dès la fin de la correction, et au plus tard dans les 2 jours (même si la correction échoue ou est annulée). Si le compte de l'élève est supprimé, les photos encore présentes sont effacées au même moment |
| Retour d'un exercice corrigé (état de chaque étape, conseils, note) | Jusqu'à suppression de la fiche, de l'élève ou de la famille : effacement immédiat, sans copie cachée |
| Journaux techniques | 14 jours en principe (sans contenu de cours) |
| Historique technique du traitement chez AWS | 90 jours (numéros de travaux et étapes, jamais le texte de tes cours) |

Il n'y a **pas de copie de secours automatique** de la base de données. Quand un compte est supprimé, les données sont effacées tout de suite, sans copie cachée. L'inconvénient : si des données sont perdues par accident, il faut rescanner les cours.

## Où sont les données ?

Chez Amazon Web Services (AWS), dans l'Union européenne. Tes données sont **stockées à Paris**. L'analyse par l'IA peut se faire dans une **autre région de l'Union européenne** que Paris, mais pas en dehors de l'UE.

## Qui voit les données ?

- Le parent voit les comptes de ses enfants et leur progression : les fiches étudiées, la date et le score de chaque test (avec le nom du dossier quand le passage porte sur plusieurs fiches), **si chaque question est juste ou fausse**, les séries et les badges. Il ne voit **ni le texte des questions, ni les réponses que l'élève a données, ni le texte des cours**. Pour un exercice corrigé, il voit seulement la date, la note et si chaque étape est juste ou fausse : **ni l'énoncé, ni les conseils, ni la photo de la copie**. Cette vue est en lecture seule et ne concerne que ses propres enfants. **Les réponses données ne sont lisibles que par l'élève.**
- Le responsable de l'application ne lit pas les cours des élèves. Il peut agir sur les comptes pour les supprimer ou corriger un problème.
- AWS, l'entreprise qui héberge l'application et fait tourner l'IA. On dit que c'est un « sous-traitant » : elle travaille pour nous, selon nos consignes, et n'a pas le droit d'utiliser tes données pour elle-même. Le fournisseur du modèle d'IA n'a pas accès à tes données. Dans de rares cas de détection d'abus (par exemple un contenu interdit dans une image), AWS peut conserver et examiner l'image concernée. Le détail est dans le dossier `docs/legal/` du projet.
- Personne d'autre. Aucune donnée n'est donnée ni vendue.

## Tes droits

Toi, ou ton parent, tu peux demander :

- à **voir** tes données : le parent peut télécharger dans l'application un fichier avec son e-mail, les comptes élèves (profil de jeu, jours de jeu, réponses), les fiches (affirmations, sources, questions et réponses) et les signalements. Ce fichier ne contient **pas le texte des cours** (ni le texte brut lu sur les photos) ni les extraits de sites web partagés : il indique seulement la structure de chaque cours et les fiches qui en viennent. **L'élève lit le texte complet de ses cours dans l'application** (écran « Cours complet »), ainsi que ses schémas gardés : c'est sa façon d'exercer son droit d'accès ;
- à les **corriger** : le parent peut changer le niveau d'un élève, son pseudo affiché et son identifiant de connexion dans l'application. Pour changer la réponse « moins de 15 ans », il faut **supprimer le compte de l'élève et le recréer** (les fiches et les cours sont alors perdus) ;
- à les **supprimer** (le parent peut supprimer le compte de l'élève ; l'effacement de la base est immédiat et comprend ses fiches, ses cours complets, ses résultats et ses signalements ; ses photos encore stockées sont effacées dans la même opération (au plus tard 2 jours si la suppression échoue, par la règle d'expiration du stockage) ; **l'élève peut aussi supprimer lui-même un cours**, en gardant ou en supprimant ses fiches, au choix, sans passer par le parent ; la copie de travail du texte, gardée 7 jours, est supprimée en même temps) ;
- à **limiter** ou t'**opposer** à leur utilisation (pour le budget et la sécurité) ;
- à **retirer ton accord** à tout moment ;
- à les **récupérer** dans un format lisible : le parent peut télécharger une **archive** (fichier zip) avec l'export et l'historique des tests de chaque élève (résultat de chaque question, **sans le texte des questions ni les réponses données**, sans texte de cours). Le lien de téléchargement ne marche que 10 minutes et le fichier est supprimé au plus tard 2 jours après. **L'élève peut aussi télécharger sa propre archive** (bouton « Télécharger mes données » dans l'écran des cours, 3 demandes par heure au plus) : un fichier zip avec tout ce qui est à lui, c'est-à-dire ses cours (texte complet), ses fiches, ses schémas gardés et l'historique de ses tests **avec ses réponses**. Si les images dépassent 150 Mo, les plus anciennes sont laissées de côté et le texte reste complet. Même lien de 10 minutes, même suppression du fichier sous 2 jours. Ce fichier n'est lisible que par l'élève, pas par le parent.

Si tu as moins de 15 ans, c'est ton parent qui exerce ces droits avec toi. Une réponse t'est donnée **dans un délai d'un mois**. Si tu n'es pas d'accord avec la réponse, tu peux écrire à l'autorité de protection des données (la CNIL en France).

## Sécurité

Connexion chiffrée, mots de passe gérés par un service spécialisé, fichiers privés, accès limité au strict nécessaire, aucun contenu de cours dans les journaux.

## Contact

Écris au **responsable de l'application**. Ses coordonnées sont données au parent lors de son inscription sur invitation.

## Changements

Si cette politique change, les parents sont prévenus dans l'application.
