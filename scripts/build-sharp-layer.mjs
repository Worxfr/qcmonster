// Fabrique la couche Lambda de `sharp` (arm64, Node, glibc) pour l'etape `cropFigures` (docs/R1-design.md 3.4).
// Usage: node scripts/build-sharp-layer.mjs [dossier de sortie]   (defaut: node_modules/.cache/qcm-sharp-layer)
// Resultat: <sortie>/nodejs/node_modules/sharp et son binaire @img/sharp-linux-arm64 (Lambda monte la couche sous /opt/nodejs/node_modules).
// Les versions viennent de infra/layers/sharp/package-lock.json (`npm ci`): meme couche a chaque fabrication. Reseau requis (registre npm).
import { execFileSync } from 'node:child_process';
import process from 'node:process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const SRC = join(ROOT, 'infra', 'layers', 'sharp');

/** Fabrique la couche si elle est absente ou perimee (empreinte du fichier de verrouillage). Renvoie le dossier de la couche. */
export function buildSharpLayer(out = join(ROOT, 'node_modules', '.cache', 'qcm-sharp-layer')) {
  const stamp = createHash('sha256').update(readFileSync(join(SRC, 'package.json'))).update(readFileSync(join(SRC, 'package-lock.json'))).digest('hex');
  const marker = join(out, '.stamp');
  const arm = join(out, 'nodejs', 'node_modules', '@img', 'sharp-linux-arm64');
  if (existsSync(marker) && readFileSync(marker, 'utf8') === stamp && existsSync(arm)) return out;
  rmSync(out, { recursive: true, force: true });
  const dir = join(out, 'nodejs');
  mkdirSync(dir, { recursive: true });
  cpSync(join(SRC, 'package.json'), join(dir, 'package.json'));
  cpSync(join(SRC, 'package-lock.json'), join(dir, 'package-lock.json'));
  // --os/--cpu/--libc: npm choisit le binaire de la cible (Lambda arm64), pas celui de la machine de build.
  execFileSync('npm', ['ci', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund', '--os=linux', '--cpu=arm64', '--libc=glibc'], { cwd: dir, stdio: 'inherit' });
  if (!existsSync(arm)) throw new Error('couche sharp: @img/sharp-linux-arm64 absent apres npm ci');
  rmSync(join(dir, 'package.json'));
  rmSync(join(dir, 'package-lock.json'));
  writeFileSync(marker, stamp);
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) process.stdout.write(buildSharpLayer(process.argv[2] ? resolve(process.argv[2]) : undefined) + '\n');
