// Liste courte de mots refuses dans un surnom (ID1, design 4.3). Tenue a jour par le proprietaire du depot; ne remplace pas la surveillance du parent.
// Les mots sont compares apres mise en minuscules, retrait des accents et des separateurs, et remplacement des chiffres usuels (shared/pseudo-rules.ts).
// Trois listes pour limiter les faux positifs (un prenom qui contient un fragment): une sous-chaine ne vaut que pour un mot d'au moins 6 lettres.

/** Refuse si le nom normalise (separateurs retires) CONTIENT le mot. 6 lettres au moins. */
export const BLOCK_CONTAINS: readonly string[] = [
  'connard', 'connasse', 'salope', 'enculer', 'encule', 'putain', 'merdeux', 'bordel', 'pedophile', 'pornographie', 'asshole', 'motherfucker', 'bitches',
  'cocaine', 'heroine', 'cannabis', 'qcmonster', 'moderateur', 'administrateur', 'professeur', 'hitler', 'suicide', 'violeur',
];

/** Refuse si un mot du surnom (decoupe aux separateurs) COMMENCE par ce mot. */
export const BLOCK_STARTS: readonly string[] = ['fuck', 'shit', 'bitch', 'porn', 'pornos', 'admin', 'parent', 'modo', 'staff', 'niquer', 'nique', 'sexe', 'sexy', 'fdp', 'ntm', 'tg'];

/** Refuse si un mot du surnom est exactement ce mot, ou si le nom entier (separateurs retires) l'est. */
export const BLOCK_EXACT: readonly string[] = ['pute', 'cul', 'bite', 'zob', 'con', 'cons', 'sex', 'nazi', 'pd', 'pede', 'tapette', 'sida', 'drogue', 'vagin', 'penis', 'sein', 'seins', 'kkk', 'prof', 'moi'];
