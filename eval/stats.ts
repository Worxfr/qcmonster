export interface Rate {
  k: number;
  n: number;
  rate: number | null;
  lo: number | null;
  hi: number | null;
}

/** Intervalle de Wilson à 95 % pour k succès sur n essais. */
export function wilson(k: number, n: number, z = 1.959964): Rate {
  if (n === 0) return { k, n, rate: null, lo: null, hi: null };
  const p = k / n;
  const d = 1 + (z * z) / n;
  const c = (p + (z * z) / (2 * n)) / d;
  const h = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / d;
  return { k, n, rate: p, lo: Math.max(0, c - h), hi: Math.min(1, c + h) };
}

export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null;
  const s = [...xs].sort((a, b) => a - b);
  const i = (s.length - 1) * q;
  const lo = Math.floor(i);
  return s[lo] + (s[Math.ceil(i)] - s[lo]) * (i - lo);
}

export const mean = (xs: number[]): number | null => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : null);
