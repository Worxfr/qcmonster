// Ports E1: fichiers de copie (S3), demarrage de la correction (Step Functions), lancement de la generation (Lambda), ré-encodage d'image (sharp).
// Les implementations AWS sont chargees a la demande (entry-real.ts); les tests utilisent les versions memoire de ce fichier.
import { createHash } from 'node:crypto';

export const copiePrefix = (sid: string, copieId: string): string => `copies/${sid}/${copieId}/`;
/** Cle EXACTE de la page `n` (1 a 3): deduite de `COPIE.pages`, jamais obtenue par une liste. */
export const pageKey = (sid: string, copieId: string, n: number): string => `${copiePrefix(sid, copieId)}p${n}`;
export const sha256Hex = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex');

export interface CopieFiles {
  /** Envoi pre-signe: cle EXACTE, type fige, 1 octet a `maxBytes`, `expiresSec` secondes. */
  presign(key: string, contentType: string, maxBytes: number, expiresSec: number): Promise<{ url: string; fields: Record<string, string> }>;
  /** Cles presentes sous le prefixe `copies/<eleve>/<copie>/` (ListBucket avec condition de prefixe). */
  list(prefix: string): Promise<string[]>;
  getBytes(key: string): Promise<Uint8Array>;
  /** Suppression par cles EXACTES; une cle absente n'est pas une erreur. */
  deleteKeys(keys: string[]): Promise<void>;
}
export interface CopieStarter {
  /** Une execution par copie, nommee par `copieId` (un double clic ne lance pas deux executions). Entree sans contenu. */
  start(name: string, input: CopieInput): Promise<void>;
}
export interface CopieInput {
  copieId: string;
  sid: string;
  fid: string;
  exoRef: string;
  pages: number;
}
export interface GenInput {
  sid: string;
  fid: string;
  docId: string;
  nn: number;
}
export interface GenInvoker {
  /** Invocation asynchrone de `exo-gen`. */
  invoke(input: GenInput): Promise<void>;
}
/** Ré-encodage avant l'appel de modele: JPEG de 1 600 px au plus, sans EXIF ni GPS, `limitInputPixels` fixe (shortcut: `sharp` en couche Lambda, voir entry-real.ts). */
export interface Reencoder {
  reencode(image: Uint8Array): Promise<Uint8Array>;
}

export function memoryFiles(): CopieFiles & { objects: Map<string, Uint8Array>; deleted: string[] } {
  const objects = new Map<string, Uint8Array>();
  const deleted: string[] = [];
  return {
    objects,
    deleted,
    async presign(key, contentType, maxBytes, expiresSec) {
      return { url: 'https://scans.example.invalid/', fields: { key, 'Content-Type': contentType, policy: `max=${maxBytes};exp=${expiresSec}` } };
    },
    async list(prefix) {
      return [...objects.keys()].filter((k) => k.startsWith(prefix)).sort();
    },
    async getBytes(key) {
      const b = objects.get(key);
      if (!b) throw new Error('objet absent');
      return b;
    },
    async deleteKeys(keys) {
      for (const k of keys) {
        deleted.push(k);
        objects.delete(k);
      }
    },
  };
}
export function memoryStarter(): CopieStarter & { started: { name: string; input: CopieInput }[] } {
  const started: { name: string; input: CopieInput }[] = [];
  return {
    started,
    async start(name, input) {
      if (!started.some((s) => s.name === name)) started.push({ name, input });
    },
  };
}
export function memoryInvoker(): GenInvoker & { calls: GenInput[]; fail: { on: boolean } } {
  const calls: GenInput[] = [];
  const fail = { on: false };
  return {
    calls,
    fail,
    async invoke(i) {
      if (fail.on) throw new Error('invocation impossible');
      calls.push(i);
    },
  };
}
export const identityReencoder: Reencoder = { reencode: async (b) => b };
