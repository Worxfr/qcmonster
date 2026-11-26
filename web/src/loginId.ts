// Identifiant de connexion (ID1). Les identifiants neufs sont en minuscules: base, tiret, suffixe de 5 caracteres (alphabet sans 0 o 1 l i).
// Un ancien identifiant (Lila-7k2f, suffixe de 4) est envoye tel quel: le pool distingue probablement les majuscules (design ID1 point 7).
const NEW_FORMAT = /^[a-z0-9]+(?:-[a-z0-9]+)*-[abcdefghjkmnpqrstuvwxyz2-9]{5}$/;

/** Ce que l'on envoie a la connexion: espaces retires; passe en minuscules si la saisie a le format neuf; une adresse e-mail reste telle quelle. */
export function normalizeLoginInput(raw: string): string {
  const t = raw.trim();
  if (t.includes('@')) return t;
  const low = t.toLowerCase();
  return NEW_FORMAT.test(low) ? low : t;
}
