// Lit les sorties CDK (--outputs-file) et ecrit les variables VITE_* du build du front, au format KEY=VALUE.
// Valeurs publiques seulement (adresse API, ids du client Cognito sans secret, adresse du site).
// Usage: node scripts/front-env.mjs cdk-outputs.json dev >> "$GITHUB_ENV"
import { readFileSync } from 'node:fs';
import process from 'node:process';

const [file, env] = process.argv.slice(2);
const out = JSON.parse(readFileSync(file, 'utf8'));
const get = (stack, key) => {
  const v = out[`qcm-${env}-${stack}`]?.[key];
  if (!v) {
    process.stderr.write(`sortie manquante: qcm-${env}-${stack}.${key}\n`);
    process.exit(1);
  }
  return v;
};
process.stdout.write(`VITE_API_URL=${get('api', 'ApiUrl')}` + '\n');
process.stdout.write(`VITE_COGNITO_POOL_ID=${get('auth', 'UserPoolId')}` + '\n');
process.stdout.write(`VITE_COGNITO_CLIENT_ID=${get('auth', 'WebClientId')}` + '\n');
process.stdout.write(`VITE_COGNITO_SIGNUP_CLIENT_ID=${get('auth', 'SignupClientId')}` + '\n');
process.stdout.write(`SITE_URL=${get('web', 'SiteUrl')}` + '\n');
