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
  /** Extraction par tranches: phrases non lues (arret anticipe ou tranche sautee) et raison (`size`, `calls`, `budget`, `skipped`). */
  sentencesUncovered?: number;
  stopReason?: string;
  /** Audit sans contenu: evenement et auteur (hache du `sub`, 16 caracteres hexadecimaux). */
  audit?: 'invitation_creee';
  actor?: string;
  /** Figures (R1), sans contenu: reprise par le modele plus gros (`retry`) ou page entiere (`page`). */
  fallback?: 'page' | 'retry';
}

const ALLOWED = ['jobId', 'step', 'durationMs', 'status', 'tokensIn', 'tokensOut', 'costEur', 'errorCode', 'outputReadable', 'claimsExpected', 'verdictsReceived', 'citationsRejected', 'retried', 'sentencesUncovered', 'stopReason', 'audit', 'actor', 'fallback'] as const;

/** Ecrit une ligne JSON. Les champs hors liste blanche sont ignores (jamais de texte libre). */
export function log(fields: LogFields): void {
  const out: Record<string, unknown> = { ts: new Date().toISOString() };
  for (const k of ALLOWED) {
    if (fields[k] !== undefined) out[k] = fields[k];
  }
  process.stdout.write(`${JSON.stringify(out)}\n`);
}
