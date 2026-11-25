# ACCENTS: accents dans les messages visibles de l'API

## Corrigé
Messages renvoyés à l'élève ou au parent, réécrits avec accents (texte seul):
- dossiers: « Tu as déjà un dossier avec ce nom »
- scans: « Annulé par l'élève », « Quota de pages épuisé », « Le job n'est pas / plus à confirmer », « Ce traitement ne peut plus être annulé », « Choisis soit des sections, soit une matière… », refus de découpage (« Phrase de départ inconnue », « La première section commence à la première phrase »)
- erreurs communes: « Accès refusé », « Réservé à l'élève », « Réservé au parent », « Requête invalide », « État incompatible », « Réessaie »
- famille: « Famille déjà créée », « Signalement déjà traité », « Nombre maximal d'élèves atteint », « Quota supérieur au plafond de la famille », « Mot de passe refusé : … »
- jeu: « Trop rapide, réessaie dans une seconde »
- exemples du contrat OpenAPI (texte d'exemple seulement).

`api/src/pipeline/steps.ts` contenait déjà des messages accentués (rien à changer).

## Non modifié (volontairement)
- codes d'erreur, valeurs d'enum, clés, identifiants (`quota_epuise`, `etat_invalide`, `rejete`…).
- prompts envoyés au modèle (`prompts.ts`): non visibles par l'élève.
- commentaires et noms de tests.
- Anciens jobs en base avec « Annule par l'eleve »: `isCancelled` (shared) et `labels.ts` (web) ignorent déjà accents et casse, ils restent reconnus.

## Test
`api/src/accents.test.ts` échoue si une des formes sans accent connues réapparaît dans `api/src` (hors tests). Tests: 545 verts, tsc et eslint propres. Aucun appel Claude ni AWS.
