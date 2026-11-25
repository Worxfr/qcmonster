// Dates du jeu: toujours l'heure du serveur, fuseau Europe/Paris (design 5.7 point 7). Aucune date ne vient du client.
const fmt = new Intl.DateTimeFormat('en-CA', { timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit' });

/** Jour au format aaaa-mm-jj (Paris). */
export const parisDate = (d: Date): string => fmt.format(d);
/** Mois au format aaaa-mm (Paris), memes valeurs que `monthParis` de shared. */
export const parisMonth = (d: Date): string => parisDate(d).slice(0, 7);

const utc = (date: string): number => {
  const [y, m, d] = date.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
};
const DAY = 86_400_000;

/** Nombre de jours entre deux dates aaaa-mm-jj (b - a). */
export const daysBetween = (a: string, b: string): number => Math.round((utc(b) - utc(a)) / DAY);

export const addDays = (date: string, n: number): string => new Date(utc(date) + n * DAY).toISOString().slice(0, 10);

/** Semaine ISO (lundi a dimanche) au format aaaa-Www. */
export function isoWeek(date: string): string {
  const t = new Date(utc(date));
  const dow = (t.getUTCDay() + 6) % 7; // lundi = 0
  t.setUTCDate(t.getUTCDate() - dow + 3); // le jeudi de la semaine donne l'annee ISO
  const year = t.getUTCFullYear();
  const week = 1 + Math.floor(Math.round((t.getTime() - Date.UTC(year, 0, 1)) / DAY) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

/** 1er du mois suivant (date de remise a zero du quota). */
export function resetDate(date: string): string {
  const [y, m] = date.split('-').map(Number);
  return m === 12 ? `${y + 1}-01-01` : `${y}-${String(m + 1).padStart(2, '0')}-01`;
}
