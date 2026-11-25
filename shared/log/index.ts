// Seul utilitaire de journal autorise (design-v2 4.9): AUCUN contenu de cours, uniquement des champs techniques.
// Un test CI interdit tout appel a la console dans api, shared et infra.
export interface LogFields {
  jobId?: string;
  step?: string;
  durationMs?: number;
  status?: 'ok' | 'error' | 'rejected';
  tokensIn?: number;
  tokensOut?: number;
  costEur?: number;
  /** Nom de la classe d'erreur (ex. ThrottlingException), jamais son message. */
  errorCode?: string;
  /** Appel de jugement (sans contenu): sortie lisible, verdicts attendus et recus, citations rejetees, relance faite. */
  outputReadable?: boolean;
  claimsExpected?: number;
  verdictsReceived?: number;
  citationsRejected?: number;
  retried?: boolean;
}

const ALLOWED = ['jobId', 'step', 'durationMs', 'status', 'tokensIn', 'tokensOut', 'costEur', 'errorCode', 'outputReadable', 'claimsExpected', 'verdictsReceived', 'citationsRejected', 'retried'] as const;

/** Ecrit une ligne JSON. Les champs hors liste blanche sont ignores (jamais de texte libre). */
export function log(fields: LogFields): void {
  const out: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const k of ALLOWED) {
    if (fields[k] !== undefined) out[k] = fields[k];
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
