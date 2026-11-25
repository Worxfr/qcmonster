// Test de contrat (acceptation L1 n.4): chacune des 22 operations a une reponse de succes avec un exemple
// valide contre son schema, et les schemas Zod generes acceptent les exemples.
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';
import $RefParser from '@apidevtools/json-schema-ref-parser';
import Ajv2020Import from 'ajv/dist/2020.js';
import addFormatsImport from 'ajv-formats';
import * as zodSchemas from './generated/schemas.js';

// Interop CJS/ESM (NodeNext): le module exporte la classe, parfois sous `.default`.
interface AjvLike {
  compile(schema: object): ((d: unknown) => boolean) & { errors?: unknown };
}
const unwrap = <T>(m: unknown): T => ((m as { default?: T }).default ?? m) as T;
const Ajv2020 = unwrap<new (o: object) => AjvLike>(Ajv2020Import);
const addFormats = unwrap<(a: AjvLike) => AjvLike>(addFormatsImport);

const spec = parse(readFileSync(new URL('./openapi.yaml', import.meta.url), 'utf8'));
const EXPECTED = [
  'POST /scans', 'GET /jobs/{jobId}', 'GET /jobs/{jobId}/transcription', 'POST /jobs/{jobId}/confirm', 'POST /jobs/{jobId}/cancel',
  'GET /docs', 'GET /docs/{docId}', 'DELETE /docs/{docId}', 'POST /docs/{docId}/report', 'GET /docs/{docId}/session', 'POST /answers',
  'GET /me', 'GET /me/progress', 'POST /students', 'POST /students/{sid}/activation-link', 'PATCH /students/{sid}', 'DELETE /students/{sid}',
  'GET /family/dashboard', 'GET /family/leaderboard', 'POST /reports/{id}/validate', 'GET /family/export', 'DELETE /family',
  // contract-v1.1 (L1c)
  'POST /activation', 'POST /docs/{docId}/read', 'POST /family',
  // contract-v1.2 (A1)
  'POST /admin/invitations',
];
const ops = Object.entries(spec.paths as Record<string, Record<string, { operationId: string; responses: Record<string, unknown> }>>).flatMap(([path, item]) =>
  Object.entries(item).map(([method, op]) => ({ key: `${method.toUpperCase()} ${path}`, op })),
);

describe('contrat OpenAPI', () => {
  it('contient exactement les routes du design (section 6)', () => {
    expect(ops.map((o) => o.key).sort()).toEqual([...EXPECTED].sort());
  });
  it('chaque operation a un operationId unique et est protegee par JWT, sauf POST /activation (publique)', () => {
    const ids = ops.map((o) => o.op.operationId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(spec.security).toEqual([{ bearerAuth: [] }]);
    const publicOps = ops.filter((o) => (o.op as { security?: unknown[] }).security?.length === 0).map((o) => o.key);
    expect(publicOps).toEqual(['POST /activation']);
  });
  it.each(ops.map((o) => [o.key, o.op] as const))('%s: exemple de succes valide', async (_k, op) => {
    const deref = (await $RefParser.dereference(structuredClone(spec))) as typeof spec;
    const dop = Object.values(deref.paths as Record<string, Record<string, { operationId: string }>>).flatMap((i) => Object.values(i)).find((o) => o.operationId === op.operationId) as unknown as {
      responses: Record<string, { content?: Record<string, { schema: object; example: unknown }> }>;
    };
    const ok = Object.entries(dop.responses).filter(([c]) => c.startsWith('2'));
    expect(ok.length).toBeGreaterThan(0);
    const ajv = addFormats(new Ajv2020({ strict: false, allErrors: true }));
    for (const [, r] of ok) {
      if (!r.content) continue; // 204
      const media = r.content['application/json'];
      expect(media.example, 'exemple manquant').toBeDefined();
      const validate = ajv.compile(media.schema);
      expect(validate(media.example), JSON.stringify(validate.errors)).toBe(true);
    }
  });
  it('les schemas Zod generes parsent les exemples des reponses', async () => {
    const deref = (await $RefParser.dereference(structuredClone(spec))) as typeof spec;
    const ex = deref.paths['/docs/{docId}'].get.responses['200'].content['application/json'].example;
    expect(() => zodSchemas.DocSchema.parse(ex)).not.toThrow();
    expect(() => zodSchemas.StudentCreateRequestSchema.parse({ pseudo: 'Lila', schoolLevel: 'seconde', under15: false, parentalAuthority: false })).toThrow();
  });
  it('aucune question de session ne porte de cle de reponse', () => {
    expect(Object.keys(spec.components.schemas.Question.properties).sort()).toEqual(['choices', 'kind', 'prompt', 'questionId']);
  });
  it('contrat v1: /me d\'un parent sans famille repond 404; le PDF est refuse en 400 (pas de page reservee)', () => {
    expect(Object.keys(spec.paths['/me'].get.responses)).toContain('404');
    expect(spec.paths['/me'].get.description).toMatch(/sans|pas encore cree/);
    const r400 = spec.paths['/scans'].post.responses['400'];
    expect(r400.description).toMatch(/PDF refuse en v1/);
    expect(JSON.stringify(r400.content['application/json'].examples.pdf.value)).toContain('requete_invalide');
    expect(spec.components.schemas.ScanCreateRequest.properties.contentType.description).toMatch(/application\/pdf est refuse/);
  });
});
