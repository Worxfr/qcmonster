# Index figés (design-v2 4.3, revue C6)

Fichiers JSON empaquetés avec la Lambda `verify-run` (esbuild), recherchés en mémoire par mots-clés. Aucune requête réseau vers ces sources, pas de type DynamoDB, pas de TTL.

Format: `{ "site", "niveau" (1 à 3), "entrees": [{ "titre", "url", "motsCles", "texte" }] }`. Le `texte` est une phrase ou un court passage; Eduscol demande de citer et de renvoyer par lien: ne pas recopier de longs passages.

- `nist.json`: 7 constantes (valeurs exactes du SI 2019, G et g normale). Écrites à la main; à comparer à la page NIST avant la prod.
- `eduscol.json`: **vide**. Les pages de programmes sont à choisir et à saisir à la main (rien n'a été téléchargé: les conditions d'usage d'Eduscol n'ont pas été lues). Tant qu'il est vide, « ce que le programme demande » n'est pas vérifiable par cet outil.
