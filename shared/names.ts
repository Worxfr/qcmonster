// Noms partages (design-v2 10.1): les stacks se referencent par NOM, jamais par import entre stacks.
export const PROJECT = 'QCMonster';
export const OWNER = 'Worxfr';
export const REGION = 'eu-west-3';
export const ENVS = ['dev', 'prod'] as const;
export type Env = (typeof ENVS)[number];

export const tableName = (env: Env) => `qcm-${env}`;
export const stackName = (env: Env, stack: string) => `qcm-${env}-${stack}`;
export const ssmParam = (env: Env, path: string) => `/qcm/${env}/${path}`;

/** Roles IAM des Lambda de traitement (crees par L2a/L2b); l'action du budget securite-40 les cible. */
export const processingRoleNames = (env: Env) => [`qcm-${env}-pipeline-role`, `qcm-${env}-verify-role`];

/** Noms des fonctions Lambda par handler (design-v2 section 6). */
export const fn = (env: Env, handler: string) => `qcm-${env}-${handler}`;

/** Quotas par defaut (decision le propriétaire): 20 pages/eleve/mois et 50/famille en prod, x10 en dev. */
export const quotaDefaults = (env: Env) => {
  const k = env === 'prod' ? 1 : 10;
  return { studentPages: 20 * k, familyPages: 50 * k };
};

/** Seuils du compteur de cout applicatif, en euros (design-v2 4.6). */
export const COST_ALERT_EUR = 10;
export const COST_BLOCK_NEW_EUR = 15;
export const COST_STOP_ALL_EUR = 18;
export const METRIC_NAMESPACE = 'QCMonster';
export const METRIC_COST_MONTH = 'CostMonthToDateEur';

/** Handlers du workflow (L2a/L2b, design-v2 4.1). Une seule Lambda de verification enchaine les etapes 7 a 10. */
export const WORKFLOW_HANDLERS = { verify: 'verify-run', consume: 'quota-consume', scanCheck: 'scan-check', stateMachine: 'process' } as const;
/** Fonctions et machine d'etats: qcm-<env>-<nom>. */
export const stateMachineName = (env: Env) => `qcm-${env}-${WORKFLOW_HANDLERS.stateMachine}`;
/** Prefixe de cle S3 des photos deposees; la regle EventBridge (Object Created) de L2a filtre dessus. */
export const SCAN_EVENT_PREFIX = 'scans/';

/** Garde cout des essais en dev (decision du proprietaire, 2026-11-24; releve de 12 a 50 EUR le 2026-11-25): le CUMUL `COST#dev / TOTAL` (toute la phase dev, jamais remis a zero) bloque tout appel Bedrock au-dela. */
export const DEV_TRIAL_CAP_EUR = 50;
/** Mise au point: echantillon de 10 pages; au plus 2 passages complets par lot (cout estime en 4.6 / docs/cost-guard.md). */
export const TRIAL_TUNING_PAGES = 10;
export const TRIAL_MAX_FULL_RUNS_PER_LOT = 2;
/** Plafond par job (design-v2 4.1): au-dela, les affirmations restantes sont non_verifiable. */
export const JOB_COST_CAP_EUR = 0.25;

/** Role d'evaluation: seul a lire le coffre du jeu cache (cree par la stack Data). */
export const evalRoleName = (env: Env) => `qcm-${env}-eval-role`;

/** Modeles (design-v2 4.6): profil systeme UE copie en profil d'application, un par modele et par environnement. */
export const MODEL_KEYS = ['haiku', 'sonnet'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];
export const modelProfileName = (env: Env, model: ModelKey) => `qcm-${env}-${model}`;

/** Role GitHub Actions cree par infra-bootstrap/setup-oidc.sh. */
export const DEPLOY_ROLE_NAME = 'QCMonster-GitHubActions-Deploy';
