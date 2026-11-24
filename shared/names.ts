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
