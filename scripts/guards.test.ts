// Garde-fous du depot (design-v2 4.6 et 4.9): pas de modelId systeme, pas de console.*.
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const ROOT = new URL('..', import.meta.url).pathname;
const SKIP_DIRS = new Set(['node_modules', 'cdk.out', 'dist', 'generated', '.git']);

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    if (SKIP_DIRS.has(name)) continue;
    const p = join(dir, name);
    if (statSync(p).isDirectory()) walk(p, out);
    else if (/\.(ts|tsx|js|mjs)$/.test(name) && !/\.test\.ts$/.test(name)) out.push(p);
  }
  return out;
}
const files = (dirs: string[]) => dirs.flatMap((d) => walk(join(ROOT, d))).filter(Boolean);
const rel = (p: string) => p.slice(ROOT.length);

describe('aucun modelId systeme', () => {
  const SYSTEM = /\b(?:eu|us|apac|global)\.anthropic\.|\banthropic\.claude/;
  const MODEL_ID = /modelId\s*[:=]\s*(['"`])([^'"`]*)\1/g;
  it('ni profil systeme eu.anthropic... dans le code (sauf la stack Models qui cree les profils d\'application)', () => {
    const bad = files(['api', 'shared', 'infra', 'mock', 'eval', 'e2e', 'web/src'])
      .filter((f) => !rel(f).endsWith('infra/lib/models-stack.ts'))
      .filter((f) => SYSTEM.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });
  it('tout modelId litteral est un ARN de profil d\'application eu-west-3', () => {
    const bad: string[] = [];
    for (const f of files(['api', 'shared', 'infra', 'eval', 'e2e'])) {
      for (const m of readFileSync(f, 'utf8').matchAll(MODEL_ID)) {
        if (!m[2].startsWith('arn:aws:bedrock:eu-west-3:')) bad.push(`${rel(f)}: ${m[2]}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

describe('pas de console.*', () => {
  it('api, shared et infra utilisent log() (scripts/ et tests exclus)', () => {
    const bad = files(['api', 'shared', 'infra']).filter((f) => /\bconsole\s*\./.test(readFileSync(f, 'utf8')));
    expect(bad.map(rel)).toEqual([]);
  });
});

describe('aucun ID de compte AWS dans le depot', () => {
  // Regle du propriétaire: ni ID de compte, ni ARN complet, ni cle ou secret dans un fichier du depot (meme prive).
  // Le compte vient de secrets.AWS_ACCOUNT_ID (workflows), de CDK_DEFAULT_ACCOUNT (CDK) et de EXPECTED_ACCOUNT (setup-oidc.sh).
  const FAKE = new Set(['123456789012']); // fixtures de test clairement factices
  const TWELVE = /(?<!\d)\d{12}(?!\d)/g;
  it('aucune suite de 12 chiffres (hors fixtures factices) dans les fichiers suivis', () => {
    const list = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { cwd: ROOT, encoding: 'utf8' }).split('\n').filter(Boolean);
    const bad: string[] = [];
    for (const f of list) {
      if (f === 'package-lock.json' || /\.(png|jpe?g|webp|ico|woff2?)$/.test(f)) continue;
      readFileSync(join(ROOT, f), 'utf8').split('\n').forEach((line, i) => {
        for (const m of line.matchAll(TWELVE)) if (!FAKE.has(m[0])) bad.push(`${f}:${i + 1}`);
      });
    }
    expect(bad).toEqual([]);
  });
});
