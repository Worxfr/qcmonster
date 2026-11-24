import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';

export const GOLDEN_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'golden');

export const PageEntry = z.object({
  id: z.string(),
  kind: z.enum(['synthetic', 'real']),
  subject: z.enum(['maths', 'physique', 'svt', 'histoire-geo', 'francais']),
  level: z.string(),
  hidden: z.boolean(),
  degraded: z.boolean(),
  injectionCourse: z.boolean(),
  injectionPassage: z.boolean(),
  persons: z.boolean(),
  errors: z.number().int().min(0),
  claims: z.number().int().min(0),
  nonFactual: z.number().int().min(0),
  image: z.string().optional(),
  twinImage: z.string().optional(),
  annotation: z.string().optional(),
  passages: z.string().optional(),
});
export type PageEntry = z.infer<typeof PageEntry>;

export const Manifest = z.object({
  version: z.literal(1),
  note: z.string(),
  minimums: z.object({
    pages: z.number(), tuning: z.number(), hidden: z.number(), errors: z.number(), claims: z.number(),
    hiddenErrors: z.number(), hiddenClaims: z.number(), injectionCourse: z.number(), injectionPassage: z.number(),
    persons: z.number(), degraded: z.number(),
  }),
  pages: z.array(PageEntry),
  negatives: z.array(z.object({ id: z.string(), image: z.string(), expected: z.literal('refuse'), note: z.string() })),
});
export type Manifest = z.infer<typeof Manifest>;

export interface Sentence { id: string; text: string; kind: 'correct' | 'error' | 'non_factual' | 'injection'; correction?: string }
export interface Annotation { id: string; transcription: string; sentences: Sentence[] }
export interface Passage { sentenceId: string; passageId: string; text: string; injected: boolean }

export const loadManifest = (): Manifest => Manifest.parse(JSON.parse(readFileSync(join(GOLDEN_DIR, 'MANIFEST.json'), 'utf8')));

export interface Golden { manifest: Manifest; privateDir?: string }

/** Annotation d'une page. Les pages réelles et cachées viennent de GOLDEN_PRIVATE_DIR (coffre S3 plus tard). */
export function loadAnnotation(g: Golden, p: PageEntry): Annotation {
  if (p.annotation) return JSON.parse(readFileSync(join(GOLDEN_DIR, p.annotation), 'utf8'));
  if (!g.privateDir) throw new Error(`GOLDEN_PRIVATE_DIR requis pour ${p.id}`);
  const raw = JSON.parse(readFileSync(join(g.privateDir, 'annotations', `${p.id}.json`), 'utf8'));
  if (raw.sentences) return raw;
  // Vraie photo: seules des affirmations justes sont annotées.
  return { id: p.id, transcription: raw.transcription, sentences: raw.claims.map((c: { text: string }, i: number) => ({ id: `s${i + 1}`, text: c.text, kind: 'correct' })) };
}

export function loadImage(g: Golden, p: { id: string; image?: string }): Buffer {
  if (p.image) return readFileSync(join(GOLDEN_DIR, p.image));
  if (!g.privateDir) throw new Error(`GOLDEN_PRIVATE_DIR requis pour ${p.id}`);
  const idx = JSON.parse(readFileSync(join(g.privateDir, 'annotations', 'images.json'), 'utf8')) as Record<string, string>;
  return readFileSync(join(g.privateDir, idx[p.id]));
}

export function loadPassages(p: PageEntry): Passage[] {
  return p.passages && existsSync(join(GOLDEN_DIR, p.passages)) ? JSON.parse(readFileSync(join(GOLDEN_DIR, p.passages), 'utf8')) : [];
}

export function totals(m: Manifest) {
  const sum = (f: (p: PageEntry) => number, ps = m.pages) => ps.reduce((a, p) => a + f(p), 0);
  const hid = m.pages.filter((p) => p.hidden);
  return {
    pages: m.pages.length, hidden: hid.length, tuning: m.pages.length - hid.length,
    errors: sum((p) => p.errors), claims: sum((p) => p.claims),
    hiddenErrors: sum((p) => p.errors, hid), hiddenClaims: sum((p) => p.claims, hid),
    injectionCourse: m.pages.filter((p) => p.injectionCourse).length,
    injectionPassage: m.pages.filter((p) => p.injectionPassage).length,
    persons: m.pages.filter((p) => p.persons).length,
    degraded: m.pages.filter((p) => p.degraded).length,
    levels: new Set(m.pages.map((p) => p.level)).size,
    subjects: new Set(m.pages.map((p) => p.subject)).size,
  };
}

/** Les compteurs du manifeste doivent égaler ceux des annotations (privées comprises). Renvoie les écarts. */
export function verifyCounters(g: Golden): string[] {
  const bad: string[] = [];
  for (const p of g.manifest.pages) {
    const a = loadAnnotation(g, p);
    const n = (k: Sentence['kind']) => a.sentences.filter((s) => s.kind === k).length;
    const got = { errors: n('error'), claims: n('correct'), nonFactual: n('non_factual') };
    for (const k of ['errors', 'claims', 'nonFactual'] as const) if (got[k] !== p[k]) bad.push(`${p.id}.${k}: manifeste ${p[k]}, annotation ${got[k]}`);
  }
  return bad;
}
