// Mots de conseil autorises dans le retour d'une copie (E1, design 6.6): verbes et tournures de consigne, sans accents ni majuscules.
// Un mot du retour qui n'est ni ici ni dans le vocabulaire de l'exercice fait remplacer l'indice par un texte generique: un prenom
// ou une information personnelle citee en un mot ne passe donc pas. shortcut: liste fixe de ~330 mots, a completer apres mesure sur de vraies copies.
const WORDS = `
a ai au aux avec avant apres alors ainsi aussi autre autres assez
bien bon bonne bonnes bons beaucoup bravo
ca ce cet cette ces ceci cela celle celui chaque comme comment compte compter calcul calculs calcule calculer calcules conserve conserver
coherent coherente complete completer completes conclusion contraire correct correcte corrige corriger corrigee corrigees corrects cours
dans de des du donc donne donner donnee donnees dernier derniere deux debut deja demande demarre detail details different differente direct
elle elles en encore enonce erreur erreurs essaie essayer est et etape etapes etre eviter exemple exercice explique expliquer
fais faire fait faut formule formules forme final finale fin
generale grandeur grandeurs il ils je juste justes
la le les leur leurs lire lis ligne lignes lorsque lui
ma mais manque manques mauvais mauvaise me mes mesure mesures methode mets mettre mieux moins mon montre montrer
ne ni non nombre nombres note notes nos notre nous nouveau
ok ou ou on oublie oublier oublies ordre
par parce partie pas passe passer pense penser peu peut peux plus point pose poser pour pourquoi premier premiere presque probleme proche propre puis
que quand quel quelle quelles quels qui quoi
raisonnement rappel rappelle rappeler reponse reponses refais refaire regarde regarder relis relire relation resultat resultats retrouve retrouver reviens revoir
sa sans se sens ses seulement si signe simple simplifie simplifier son sont sous suffit suis suit suite sur sure sens
ta tes ton tout toute toutes tous te tu trop trouve trouver trouves type
un une unite unites utilise utiliser utilises utile
va valeur valeurs verifie verifier verifies vers vrai vraie voir vois votre vos vous
y
bonne reponse presque tout a fait deja pas encore bien vu penses
addition soustraction multiplication division produit somme difference quotient
egal egale egalite equation equations inconnue inconnues isole isoler remplace remplacer remplacement
convertis convertir conversion heures minutes secondes metres kilometres
cherche chercher choisis choisir choisi application appliquer applique ecris ecrire ecrit
arrondi arrondis arrondir chiffres chiffre significatif significatifs ecart
trop petit petite grand grande plus moins fois deux trois quatre cinq
physique chimie maths
d l m n s t j c qu
`;
export const EXO_VOCAB: ReadonlySet<string> = new Set(WORDS.split(/\s+/).filter(Boolean));
