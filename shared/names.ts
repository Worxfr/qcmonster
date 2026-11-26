// Noms partages (design-v2 10.1): les stacks se referencent par NOM, jamais par import entre stacks.
export const PROJECT = 'QCMonster';
export const OWNER = 'Worxfr';
export const REGION = 'eu-west-3';
export const ENVS = ['dev', 'prod'] as const;
export type Env = (typeof ENVS)[number];

export const tableName = (env: Env) => `qcm-${env}`;
export const stackName = (env: Env, stack: string) => `qcm-${env}-${stack}`;
export const ssmParam = (env: Env, path: string) => `/qcm/${env}/${path}`;
/** Parametre SSM du bucket des figures conservees (R1-B). */
export const FIGURES_BUCKET_PARAM = 'data/figuresBucket';

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
/** Seuils mensuels par environnement. Prod: 10/15/18. Dev (F12, 2026-11-26): 80/95/100, alignes sur le plafond cumule DEV_TRIAL_CAP_EUR (100) pour ne pas bloquer avant lui; l'alerte e-mail part a 80. */
export const costThresholdsFor = (env: Env) =>
  env === 'dev'
    ? { alertEur: 80, blockNewEur: 95, stopAllEur: 100 }
    : { alertEur: COST_ALERT_EUR, blockNewEur: COST_BLOCK_NEW_EUR, stopAllEur: COST_STOP_ALL_EUR };
export const METRIC_NAMESPACE = 'QCMonster';
export const METRIC_COST_MONTH = 'CostMonthToDateEur';

/** Handlers du workflow (L2a/L2b, design-v2 4.1). Une seule Lambda de verification enchaine les etapes 7 a 10. */
export const WORKFLOW_HANDLERS = { verify: 'verify-run', consume: 'quota-consume', scanCheck: 'scan-check', stateMachine: 'process' } as const;
/** Fonctions et machine d'etats: qcm-<env>-<nom>. */
export const stateMachineName = (env: Env) => `qcm-${env}-${WORKFLOW_HANDLERS.stateMachine}`;
/** Prefixe de cle S3 des photos deposees; la regle EventBridge (Object Created) de L2a filtre dessus. */
export const SCAN_EVENT_PREFIX = 'scans/';

/** Garde cout des essais en dev (decision du proprietaire, 2026-11-24; releve de 12 a 50 EUR le 2026-11-25, puis a 100 EUR le 2026-11-26 (F12)): le CUMUL `COST#dev / TOTAL` (toute la phase dev, jamais remis a zero) bloque tout appel Bedrock au-dela. */
export const DEV_TRIAL_CAP_EUR = 100;
/** Mise au point: echantillon de 10 pages; au plus 2 passages complets par lot (cout estime en 4.6 / docs/cost-guard.md). */
export const TRIAL_TUNING_PAGES = 10;
export const TRIAL_MAX_FULL_RUNS_PER_LOT = 2;
/** Plafond par job (design-v2 4.1): au-dela, les affirmations restantes sont non_verifiable. */
export const JOB_COST_CAP_EUR = 0.25;
/** Plafond par page au-dela d'une page et demie (decision du 2026-11-25, docs/cost-guard.md): cout mesure ~0,09 EUR par page, p95 0,12. */
export const JOB_COST_CAP_PER_PAGE_EUR = 0.15;
/** Plafond d'un job de `pages` pages: max(0,25 ; 0,15 x pages) EUR, arrondi au centime. 1 page: 0,25; 3 pages: 0,45; 10 pages: 1,50. `pages` hors 1..10 est ramene dans cet intervalle. */
export const jobCapEur = (pages: number): number => {
  const n = Number.isFinite(pages) ? Math.min(10, Math.max(1, Math.trunc(pages))) : 1;
  return Math.max(JOB_COST_CAP_EUR, Math.round(JOB_COST_CAP_PER_PAGE_EUR * n * 100) / 100);
};

/** Role d'evaluation: seul a lire le coffre du jeu cache (cree par la stack Data). */
export const evalRoleName = (env: Env) => `qcm-${env}-eval-role`;

/** Modeles (design-v2 4.6): profil systeme UE copie en profil d'application, un par modele et par environnement. */
export const MODEL_KEYS = ['haiku', 'sonnet'] as const;
export type ModelKey = (typeof MODEL_KEYS)[number];
export const modelProfileName = (env: Env, model: ModelKey) => `qcm-${env}-${model}`;

/** Role GitHub Actions cree par infra-bootstrap/setup-oidc.sh. */
export const DEPLOY_ROLE_NAME = 'QCMonster-GitHubActions-Deploy';
