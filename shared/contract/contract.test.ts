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
  'GET /docs', 'GET /docs/{docId}', 'DELETE /docs/{docId}', 'POST /docs/{docId}/report', 'GET /docs/{docId}/session', 'POST /answers', 'POST /practice/session',
  'GET /me', 'GET /me/progress', 'POST /students', 'POST /students/{sid}/activation-link', 'POST /students/{sid}/login-id', 'PATCH /students/{sid}', 'DELETE /students/{sid}',
  'GET /family/dashboard', 'GET /family/leaderboard', 'POST /reports/{id}/validate', 'GET /family/export', 'DELETE /family',
  // contract-v1.1 (L1c)
  'POST /activation', 'POST /docs/{docId}/read', 'POST /family',
  // contract-v1.2 (A1)
  'POST /admin/invitations',
  // contract-v1.3 (FEAT-A)
  'GET /scans', 'PATCH /docs/{docId}', 'GET /folders', 'POST /folders', 'PATCH /folders/{folderId}', 'DELETE /folders/{folderId}',
  'POST /folders/{folderId}/scans', 'DELETE /folders/{folderId}/scans/{docId}',
  'DELETE /scans/{scanId}', 'GET /cours/{coursId}', 'DELETE /cours/{coursId}',
  // contract-v1.4 (H1)
  'GET /me/tests', 'GET /me/tests/{testId}', 'GET /students/{sid}/progress', 'GET /students/{sid}/tests',
  'GET /students/{sid}/tests/{testId}', 'POST /family/export/archive', 'POST /family/policy', 'POST /me/export/archive', 'GET /me/export/archive/{exportId}',
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
    expect(Object.keys(spec.components.schemas.Question.properties).sort()).toEqual(['choices', 'docId', 'docTitle', 'kind', 'prompt', 'questionId']);
  });
  it('Q1: PracticeSession sans cle ni mot attendu, 10 fiches au plus, exemple valide, reservee a l\'eleve', () => {
    expect(JSON.stringify(spec.components.schemas.PracticeSession)).not.toMatch(/"(cle|attendu|correctAnswer)"/);
    expect(spec.components.schemas.PracticeSession.properties.docIds.maxItems).toBe(10);
    expect(spec.components.schemas.PracticeRequest.properties.docIds.maxItems).toBe(10);
    const ex = spec.paths['/practice/session'].post.responses['200'].content['application/json'].example;
    expect(zodSchemas.PracticeSessionSchema.safeParse(ex).success).toBe(true);
    expect(zodSchemas.PracticeRequestSchema.safeParse({ docIds: Array.from({ length: 11 }, (_, i) => `d${i}`) }).success).toBe(false);
    expect(zodSchemas.PracticeRequestSchema.safeParse({ docIds: ['a'], size: 7 }).success).toBe(false);
    expect(Object.keys(spec.paths).filter((p) => p.startsWith('/students/') && JSON.stringify(spec.paths[p]).includes('PracticeSession'))).toEqual([]);
  });
  it('contrat v1: /me d\'un parent sans famille repond 404; le PDF est refuse en 400 (pas de page reservee)', () => {
    expect(Object.keys(spec.paths['/me'].get.responses)).toContain('404');
    expect(spec.paths['/me'].get.description).toMatch(/sans|pas encore cree/);
    const r400 = spec.paths['/scans'].post.responses['400'];
    expect(r400.description).toMatch(/PDF refuse en v1/);
    expect(JSON.stringify(r400.content['application/json'].examples.pdf.value)).toContain('requete_invalide');
    expect(spec.components.schemas.ScanCreateRequest.properties.contentType.description).toMatch(/application\/pdf est refuse/);
  });
  it('contrat 1.3 additif: un client 1.2 reste valide, les nouveautes sont presentes', () => {
    expect(spec.info.version).toBe('1.8.0');
    // Requetes 1.2 inchangees
    expect(zodSchemas.ScanCreateRequestSchema.safeParse({ pages: 1, contentType: 'image/jpeg' }).success).toBe(true);
    expect(zodSchemas.ConfirmRequestSchema.safeParse({ corrections: [] }).success).toBe(true);
    // Aucun champ requis nouveau dans une requete: seules des reponses gagnent des champs requis
    expect(spec.components.schemas.ScanCreateRequest.required).toEqual(['pages', 'contentType']);
    expect(spec.components.schemas.ConfirmRequest.required).toEqual(['corrections']);
    expect(spec.components.schemas.DocSummary.required).toEqual(['docId', 'title', 'subject', 'createdAt']);
    expect(spec.components.schemas.Job.required).toEqual(['jobId', 'state', 'pages', 'createdAt']);
    // Multi-pages: une URL par page, `upload` garde pour la 1.2
    expect(spec.components.schemas.ScanCreateResponse.required).toEqual(['jobId', 'upload', 'expiresAt', 'pagesRemaining']);
    expect(Object.keys(spec.components.schemas.ScanCreateResponse.properties)).toContain('uploads');
    expect(spec.components.schemas.ScanCreateRequest.properties.contentTypes.maxItems).toBe(10);
    expect(spec.components.schemas.ScanCreateRequest.properties.pages.maximum).toBe(10);
  });
  it('contrat 1.3: etapes, matieres et filtres de GET /scans', () => {
    expect(spec.components.schemas.ScanStage.enum).toEqual(['envoi', 'lecture', 'a_confirmer', 'fiche', 'verification', 'qcm', 'termine', 'echec']);
    expect(spec.components.schemas.Subject.enum).toEqual(['maths', 'physique', 'svt', 'histoire_geo', 'francais', 'autre']);
    const names = (spec.paths['/scans'].get.parameters as { name: string }[]).map((p) => p.name);
    expect(names).toEqual(expect.arrayContaining(['studentId', 'subject', 'topic', 'folderId', 'status', 'sort', 'order', 'limit', 'cursor']));
    expect(spec.components.schemas.ScanStatus.required).toEqual(['stage', 'pagesDone', 'pagesTotal', 'startedAt']);
  });
  it('schemas Zod 1.3: dossiers, mise a jour matiere/sujet, selection multiple', () => {
    const z = zodSchemas;
    expect(z.FolderNameRequestSchema.safeParse({ name: '' }).success).toBe(false);
    expect(z.FolderNameRequestSchema.safeParse({ name: 'x'.repeat(61) }).success).toBe(false);
    expect(z.FolderNameRequestSchema.safeParse({ name: 'Brevet' }).success).toBe(true);
    // minProperties n'est pas traduit en Zod: le handler refuse {} (400), voir docs/feat-a-lots.md
    expect(spec.components.schemas.DocUpdateRequest.minProperties).toBe(1);
    expect(z.DocUpdateRequestSchema.safeParse({ subject: 'latin' }).success).toBe(false);
    expect(z.DocUpdateRequestSchema.safeParse({ topic: null }).success).toBe(true);
    expect(z.DocUpdateRequestSchema.safeParse({ subject: 'svt', topic: 'La cellule' }).success).toBe(true);
    expect(z.FolderScansRequestSchema.safeParse({ docIds: [] }).success).toBe(false);
    expect(z.FolderScansRequestSchema.safeParse({ docIds: ['a', 'a'] }).success).toBe(false);
    expect(z.FolderScansRequestSchema.safeParse({ docIds: Array.from({ length: 51 }, (_, i) => `d${i}`) }).success).toBe(false);
    expect(z.ScanCreateRequestSchema.safeParse({ pages: 11, contentType: 'image/jpeg' }).success).toBe(false);
    expect(z.ScanCreateRequestSchema.safeParse({ pages: 2, contentType: 'image/jpeg', contentTypes: ['application/pdf', 'image/png'] }).success).toBe(false);
  });
  it('contrat 1.3: scans a relire (echeance, expire bientot, compteur)', () => {
    const st = spec.components.schemas.ScanStatus.properties;
    expect(st.expiresAt.format).toBe('date-time');
    expect(st.expiresSoon.type).toBe('boolean');
    expect(spec.components.schemas.ScanStatus.required).not.toContain('expiresAt'); // facultatif: absent hors a_confirmer et avant 1.3
    expect(spec.components.schemas.ScanList.required).toContain('toReview');
    expect(spec.paths['/scans'].get.description).toMatch(/Scans a relire/);
    expect(spec.paths['/jobs/{jobId}/transcription'].get.description).toMatch(/autant de fois/);
    const ex = spec.paths['/scans'].get.responses['200'].content['application/json'].example;
    expect(ex.items.some((i: { status: { stage: string; expiresSoon?: boolean } }) => i.status.stage === 'a_confirmer' && i.status.expiresSoon === false)).toBe(true);
  });
  it('contrat 1.3 apres revue: codes dossier, 429, etat du scan, defauts', () => {
    expect(spec.components.schemas.Error.properties.code.enum).toEqual(expect.arrayContaining(['dossier_nom_pris', 'dossiers_limite']));
    expect(zodSchemas.ErrorSchema.safeParse({ code: 'dossier_nom_pris', message: 'x' }).success).toBe(true);
    expect(Object.keys(spec.paths['/scans'].get.responses)).toContain('429');
    expect(spec.components.schemas.ScanSummary.required).toContain('state');
    expect(spec.components.schemas.ScanSummary.properties.state.$ref).toBe('#/components/schemas/JobState');
    const f409 = spec.paths['/folders'].post.responses['409'].content['application/json'].example;
    expect(f409.code).toBe('dossier_nom_pris');
    expect(spec.paths['/folders'].post.responses['400'].content['application/json'].examples.limite.value.code).toBe('dossiers_limite');
    const names = (spec.paths['/scans'].get.parameters as { name: string; schema: { default?: string }; description?: string }[]);
    expect(names.find((p) => p.name === 'order')!.schema.default).toBeUndefined(); // defaut dependant de `sort`, ecrit dans la description
    expect(names.find((p) => p.name === 'order')!.description).toMatch(/asc.*subject/);
    expect(names.find((p) => p.name === 'cursor')!.description).toMatch(/memes filtres/);
  });
  it('contrat 1.3: phrase a cheval sur plusieurs pages (Sentence.pages), additif', () => {
    const z = zodSchemas.SentenceSchema;
    expect(z.safeParse({ id: 'p1-s1', text: 'x' }).success).toBe(true); // 1.2 inchange
    expect(z.safeParse({ id: 'p1-s2', text: 'x', pages: [1, 2] }).success).toBe(true);
    expect(z.safeParse({ id: 'p1-s2', text: 'x', pages: [] }).success).toBe(false);
    expect(z.safeParse({ id: 'p1-s2', text: 'x', pages: [0] }).success).toBe(false);
    expect(z.safeParse({ id: 'p1-s2', text: 'x', pages: [1, 2, 3, 4, 5] }).success).toBe(false);
    expect(spec.components.schemas.Sentence.required).toEqual(['id', 'text']);
    expect(spec.components.schemas.Transcription.description).toMatch(/UN document/);
    const ex = spec.paths['/jobs/{jobId}/transcription'].get.responses['200'].content['application/json'].example;
    expect(ex.pages[0].sentences.some((x: { pages?: number[] }) => x.pages?.length === 2)).toBe(true);
    expect(ex.pages.map((p: { page: number }) => p.page)).toEqual([1, 2]);
    expect(zodSchemas.TranscriptionSchema.safeParse(ex).success).toBe(true);
  });
  it('contrat 1.3: sections a la confirmation (une fiche par sujet), cours conserve', () => {
    const z = zodSchemas.ConfirmRequestSchema;
    expect(z.safeParse({ corrections: [] }).success).toBe(true); // client 1.2 inchange
    expect(spec.components.schemas.ConfirmRequest.required).toEqual(['corrections']);
    expect(spec.components.schemas.ConfirmSection.required).toEqual(['fromSentenceId', 'subject']);
    const ok = { corrections: [], sections: [{ fromSentenceId: 'p1-s1', subject: 'svt' }, { fromSentenceId: 'p2-s3', subject: 'autre', ignore: true, topic: 'Fin', title: 'T', folderId: 'f' }] };
    expect(z.safeParse(ok).success).toBe(true);
    expect(z.safeParse({ corrections: [], sections: [] }).success).toBe(false);
    expect(z.safeParse({ corrections: [], sections: [{ fromSentenceId: 'p2-1', subject: 'svt' }] }).success).toBe(false); // format reel p<page>-s<n>
    expect(z.safeParse({ corrections: [], sections: [{ fromSentenceId: 'p1-s1', subject: 'latin' }] }).success).toBe(false);
    expect(z.safeParse({ corrections: [], sections: Array.from({ length: 7 }, (_, i) => ({ fromSentenceId: `p${i + 1}-s1`, subject: 'svt' })) }).success).toBe(false);
    const op = spec.paths['/jobs/{jobId}/confirm'].post;
    expect(op.description).toMatch(/au plus 6 sections.*au plus 2 par page/s);
    expect(op.description).toMatch(/draftSubject.*autre/s); // repli de matiere pour un client 1.2
    expect(op.description).toMatch(/herite du .folderId. du job/);
    expect(op.description).toMatch(/consomme UNE fois/);
    expect(op.description).toMatch(/au total.*jamais a chaque section/s);
    expect(Object.keys(op.responses['400'].content['application/json'].examples)).toEqual(['inconnu', 'ordre', 'debut', 'rien', 'court']);
    expect(z.safeParse(op.requestBody.content['application/json'].example).success).toBe(true); // `example` (et non `examples`): l'API simulee et mock:check l'utilisent comme corps
    expect(z.safeParse({ corrections: [], subject: 'svt', topic: 'La photosynthese', folderId: 'f' }).success).toBe(true); // une seule section
  });
  it('contrat 1.3: GET/DELETE /cours, regroupement des fiches, export', () => {
    const del = spec.paths['/cours/{coursId}'].delete;
    const fiches = del.parameters.find((p: { name?: string }) => p.name === 'fiches');
    expect(fiches.required).toBe(true);
    expect(fiches.schema.enum).toEqual(['garder', 'supprimer']);
    expect(fiches.schema.default).toBeUndefined(); // option explicite, pas de defaut
    expect(spec.components.schemas.CoursMeta.properties.sections.items.properties.status.enum).toEqual(['fiche', 'ignoree', 'sans_fiche', 'supprimee']);
    for (const k of ['coursId', 'sectionIndex', 'sectionCount', 'docIds']) expect(spec.components.schemas.ScanSummary.properties[k]).toBeDefined();
    expect(spec.components.schemas.ScanSummary.required).not.toContain('docIds');
    expect(spec.components.schemas.DocSummary.properties.coursId).toBeDefined();
    expect(spec.components.schemas.DocSummary.required).toEqual(['docId', 'title', 'subject', 'createdAt']);
    expect(spec.components.schemas.Job.properties.docIds).toBeDefined();
    expect(spec.components.schemas.Transcription.properties.suggestedSections.maxItems).toBe(6);
    const exp = spec.components.schemas.StudentExport.allOf[1].properties.cours;
    expect(exp.items.$ref).toBe('#/components/schemas/CoursMeta'); // l'export parent n'a PAS le texte du cours
    expect(spec.components.schemas.CoursMeta.properties.texts).toBeUndefined();
    expect(spec.paths['/family/export'].get.summary).toMatch(/SANS leur texte/);
    expect(spec.paths['/cours/{coursId}'].delete.summary).toMatch(/eleve seulement: 403 pour le parent/);
    expect(spec.paths['/cours/{coursId}'].delete.summary).toMatch(/sectionCount/);
    expect(spec.paths['/cours/{coursId}'].get.summary).toMatch(/parent a 403/);
    expect(zodSchemas.CoursSchema.safeParse(spec.paths['/cours/{coursId}'].get.responses['200'].content['application/json'].example).success).toBe(true);
  });
});

describe('contrat v1.4 (H1): historique des tests et vue parent', () => {
  const schemas = spec.components.schemas as Record<string, { properties?: Record<string, unknown>; allOf?: unknown[] }>;
  const BANNED = ['prompt', 'choices', 'choice', 'correctAnswer'];
  it("la vue parent et l'archive donnent le resultat par question mais ni texte, ni reponse donnee", () => {
    const names = ['StudentProgressView', 'TestSummary', 'TestQuestionStatus', 'TestParentDetail', 'DocProgress', 'ScanProgress'];
    const json = JSON.stringify(names.map((n) => schemas[n]));
    for (const banned of BANNED) expect(json).not.toContain(`"${banned}"`);
    expect(Object.keys(schemas.TestQuestionStatus.properties ?? {})).toEqual(expect.arrayContaining(['questionId', 'rank', 'correct']));
  });
  it("seul l'eleve lit la reponse donnee (TestQuestionResult.choice)", () => {
    expect(JSON.stringify(schemas.TestQuestionResult)).toContain('"choice"');
  });
  it('les passages portent une annee scolaire', () => {
    expect(schemas.TestSummary.properties).toHaveProperty('schoolYear');
    expect(zodSchemas.TestSummarySchema.safeParse({}).success).toBe(false);
  });
});

describe('contrat v1.5 (R1): relecture en blocs, figures, fiche en paragraphes', () => {
  const schemas = spec.components.schemas as Record<string, { required?: string[]; properties?: Record<string, unknown> }>;
  const tr = () => spec.paths['/jobs/{jobId}/transcription'].get.responses['200'].content['application/json'].example;
  it('additif: aucun champ requis nouveau, un client 1.4 reste valide', () => {
    expect(schemas.Transcription.required).toEqual(['jobId', 'docType', 'pages', 'photoUrls', 'photoUrlsExpireAt']);
    expect(schemas.ConfirmRequest.required).toEqual(['corrections']);
    expect(schemas.Sentence.required).toEqual(['id', 'text']);
    expect(zodSchemas.ConfirmRequestSchema.safeParse({ corrections: [] }).success).toBe(true);
    expect(zodSchemas.SentenceSchema.safeParse({ id: 'p1-s1', text: 'x' }).success).toBe(true);
    const old = structuredClone(tr());
    delete old.blocks;
    delete old.figures;
    expect(zodSchemas.TranscriptionSchema.safeParse(old).success).toBe(true);
  });
  it('blocs: types, niveaux et identifiants stricts', () => {
    const z = zodSchemas.BlockSchema;
    expect(z.safeParse({ id: 'b1', kind: 'titre', level: 1, sentenceIds: ['p1-s1'] }).success).toBe(true);
    expect(z.safeParse({ id: 'b2', kind: 'liste', ordered: true, sentenceIds: ['p1-s2', 'p1-s3'] }).success).toBe(true);
    expect(z.safeParse({ id: 'b3', kind: 'figure', figureId: 'f1' }).success).toBe(true);
    expect(z.safeParse({ id: 'b1', kind: 'tableau' }).success).toBe(false);
    expect(z.safeParse({ id: '1', kind: 'paragraphe' }).success).toBe(false);
    expect(z.safeParse({ id: 'b1', kind: 'titre', level: 4 }).success).toBe(false);
    expect(z.safeParse({ id: 'b1', kind: 'paragraphe', sentenceIds: ['p1-1'] }).success).toBe(false);
  });
  it('la couleur de lecture est une confiance de lecture, pas un verdict', () => {
    expect(zodSchemas.SentenceSchema.safeParse({ id: 'p1-s1', text: 'x', doubt: true }).success).toBe(true);
    expect(JSON.stringify(schemas.Sentence.properties!.doubt)).toMatch(/PAS un resultat de verification/);
    expect(tr().pages[0].sentences.some((x: { doubt?: boolean }) => x.doubt)).toBe(true);
  });
  it('figures: rien de conserve sans choix explicite, alt toujours present', () => {
    expect(schemas.Figure.required).toEqual(['figureId', 'page', 'kind', 'alt', 'url']); // une figure est toujours une image
    expect(schemas.ConfirmFigure.required).toEqual(['figureId', 'keep']);
    expect(JSON.stringify(schemas.ConfirmRequest.properties!.figures)).toMatch(/n'est PAS conservee/);
    expect(zodSchemas.FigureSchema.safeParse({ figureId: 'f1', page: 1, kind: 'schema', alt: '', url: 'https://example.invalid/f1.jpg' }).success).toBe(false);
    expect(zodSchemas.FigureSchema.safeParse({ figureId: 'f1', page: 1, kind: 'schema', alt: 'x' }).success).toBe(false); // pas de figure sans image
    expect(zodSchemas.FigureSchema.safeParse({ figureId: 'f1', page: 1, kind: 'schema', alt: 'x', url: 'https://example.invalid/f1.jpg' }).success).toBe(true); // page entiere: box absent
    expect(zodSchemas.ConfirmRequestSchema.safeParse({ corrections: [], figures: Array.from({ length: 9 }, (_, i) => ({ figureId: `f${i}`, keep: true })) }).success).toBe(false);
    expect(zodSchemas.ConfirmRequestSchema.safeParse({ corrections: [], figures: [{ figureId: 'f1', keep: true }], removed: ['p1-s2'] }).success).toBe(true);
  });
  it("le parent ne recoit jamais d'image: CoursMeta (export) n'a que figureCount", () => {
    expect(Object.keys(schemas.CoursMeta.properties!)).toContain('figureCount');
    expect(JSON.stringify(schemas.CoursMeta)).not.toContain('url');
  });
  it('fiche en paragraphes avec rappel, resume conserve pour les clients 1.4', () => {
    const ex = spec.paths['/docs/{docId}'].get.responses['200'].content['application/json'].example;
    expect(zodSchemas.DocSchema.safeParse(ex).success).toBe(true);
    expect(typeof ex.summary).toBe('string');
    expect(ex.recall[0].claimId).toBe(ex.claims[0].claimId);
    expect(zodSchemas.RecallItemSchema.safeParse({ kind: 'formule', text: 'E = mc2', claimId: '01', verified: false }).success).toBe(true);
    expect(zodSchemas.RecallItemSchema.safeParse({ kind: 'definition', text: 'x'.repeat(1000), claimId: '01', verified: true }).success).toBe(true); // copie d'une affirmation (Claim.text: 1000)
    expect(zodSchemas.RecallItemSchema.safeParse({ kind: 'dessin', text: 'x', claimId: '01', verified: true }).success).toBe(false);
  });
  it('cours: marques de verification par phrase, statut jamais "non_factuelle"', () => {
    const ex = spec.paths['/cours/{coursId}'].get.responses['200'].content['application/json'].example;
    expect(zodSchemas.CoursSchema.safeParse(ex).success).toBe(true);
    expect(zodSchemas.SentenceMarkSchema.safeParse({ sentenceId: 'p1-s1', status: 'non_factuelle', docId: 'd', claimId: 'c' }).success).toBe(false);
    expect(zodSchemas.ClaimSchema.safeParse({ claimId: '1', text: 't', status: 'verifiee', aRisque: false, sources: [], sentenceId: 'p1-s1' }).success).toBe(true);
  });
  it('formules en LaTeX: texte de phrase, bloc formule sans delimiteurs (P13)', () => {
    expect(JSON.stringify(schemas.Sentence.properties!.text)).toMatch(/LaTeX/);
    expect(JSON.stringify(schemas.Block.properties!.kind)).toMatch(/LaTeX SANS delimiteurs/);
    expect(zodSchemas.SentenceSchema.safeParse({ id: 'p1-s1', text: 'On a $E = mc^{2}$.' }).success).toBe(true);
    expect(zodSchemas.SentenceSchema.safeParse({ id: 'p1-s1', text: 'x'.repeat(2001) }).success).toBe(false);
  });
  it('LaTeX possible aussi dans Claim.text, RecallItem.text et les enonces de QCM', () => {
    const sch = spec.components.schemas as Record<string, { properties: Record<string, unknown> }>;
    for (const [n, f] of [['Claim', 'text'], ['RecallItem', 'text'], ['Question', 'prompt'], ['Question', 'choices']] as const) {
      expect(JSON.stringify(sch[n].properties[f])).toMatch(/LaTeX/);
    }
  });
  it("export de l'eleve (P14): l'archive peut annoncer cours et figures; l'export du parent reste sans contenu de cours", () => {
    expect(zodSchemas.ExportArchiveSchema.safeParse({ url: 'https://example.invalid/a.zip', expiresAt: '2026-12-01T10:10:00Z', format: 'zip', sizeBytes: 1, students: 1, tests: 0, truncated: false, courses: 6, figures: 9 }).success).toBe(true);
    expect(schemas.ExportArchive.required).toEqual(['url', 'expiresAt', 'format', 'sizeBytes', 'students', 'tests', 'truncated']);
    expect(spec.paths['/family/export/archive'].post.description).toMatch(/aucun texte de cours/);
    expect(JSON.stringify(spec.paths['/family/export'])).not.toMatch(/figures\//);
  });
});

describe('contrat v1.6 (F10): ajout de pages a un cours', () => {
  const schemas = spec.components.schemas as Record<string, { required?: string[]; properties?: Record<string, { maximum?: number; maxItems?: number; enum?: string[] }> }>;
  it('additif: aucun champ requis nouveau, un client 1.5 reste valide', () => {
    expect(schemas.ScanCreateRequest.required).toEqual(['pages', 'contentType']);
    expect(schemas.Transcription.required).toEqual(['jobId', 'docType', 'pages', 'photoUrls', 'photoUrlsExpireAt']);
    expect(zodSchemas.ScanCreateRequestSchema.safeParse({ pages: 1, contentType: 'image/jpeg' }).success).toBe(true);
    expect(zodSchemas.ScanCreateRequestSchema.safeParse({ pages: 1, contentType: 'image/jpeg', coursId: 'C1' }).success).toBe(true);
    expect(zodSchemas.ScanCreateRequestSchema.safeParse({ pages: 1, contentType: 'image/jpeg', coursId: '' }).success).toBe(false);
  });
  it('transcription d un ajout: pages a la suite du cours, contexte de 2 phrases au plus, continuesId', () => {
    const t = { jobId: 'J', docType: 'cours', pages: [{ page: 5, sentences: [{ id: 'p5-s1', text: 'suite', continuesId: 'p4-s9' }] }], context: [{ id: 'p4-s8', text: 'a' }, { id: 'p4-s9', text: 'b' }], photoUrls: ['https://example.invalid/0'], photoUrlsExpireAt: '2026-12-01T10:05:00Z' };
    expect(zodSchemas.TranscriptionSchema.safeParse(t).success).toBe(true);
    expect(zodSchemas.TranscriptionSchema.safeParse({ ...t, context: [...t.context, { id: 'p4-s7', text: 'c' }] }).success).toBe(false);
    expect(zodSchemas.SentenceSchema.safeParse({ id: 'p1-s1', text: 'x', continuesId: 'page' }).success).toBe(false);
  });
  it('limites du cours: 30 pages, 20 sections; limites d un scan inchangees (un ajout = un scan)', () => {
    const meta = { coursId: 'C', createdAt: '2026-12-01T10:00:00Z', pages: 30, sections: Array.from({ length: 20 }, (_, n) => ({ fromSentenceId: `p1-s${n + 1}`, subject: 'svt', status: 'fiche', docId: `D${n}` })) };
    expect(zodSchemas.CoursMetaSchema.safeParse(meta).success).toBe(true);
    expect(zodSchemas.CoursMetaSchema.safeParse({ ...meta, pages: 31 }).success).toBe(false);
    expect(zodSchemas.CoursMetaSchema.safeParse({ ...meta, sections: [...meta.sections, meta.sections[0]] }).success).toBe(false);
    expect(schemas.ScanCreateRequest.properties!.pages.maximum).toBe(10);
    expect(schemas.ScanSummary.properties!.sectionIndex.maximum).toBe(5);
    expect(schemas.ScanSummary.properties!.sectionCount.maximum).toBe(6);
    expect(schemas.ScanSummary.properties!.docIds.maxItems).toBe(6);
  });
  it('cours_plein (409) et 403/409 de POST /scans, 409 de DELETE /cours', () => {
    expect(schemas.Error.properties!.code.enum).toContain('cours_plein');
    const post = spec.paths['/scans'].post.responses;
    expect(Object.keys(post)).toEqual(expect.arrayContaining(['403', '404', '409', '429']));
    expect(Object.keys(post['409'].content['application/json'].examples)).toEqual(['plein', 'ouvert']);
    expect(zodSchemas.ErrorSchema.safeParse(post['409'].content['application/json'].examples.plein.value).success).toBe(true);
    expect(Object.keys(spec.paths['/cours/{coursId}'].delete.responses)).toContain('409');
  });
  it('contrat 1.8.0 (ID1): surnom et identifiant separes, activation en 200', () => {
    const act = spec.paths['/activation'].post.responses;
    expect(Object.keys(act)).toEqual(['200', '400', '404', '409']);
    expect(zodSchemas.ActivationResponseSchema.safeParse(act['200'].content['application/json'].example).success).toBe(true);
    const dn = spec.components.schemas.ActivationRequest.properties.displayName;
    expect([dn.minLength, dn.maxLength]).toEqual([2, 20]);
    expect(dn.pattern).toBeTruthy();
    expect(spec.components.schemas.ActivationRequest.required).toEqual(['token', 'password']);
    expect(zodSchemas.ActivationRequestSchema.safeParse({ token: 'x'.repeat(30), password: 'Un-mot-de-passe-long-1', displayName: 'Léa' }).success).toBe(true);
    for (const bad of ['а', 'Лила', 'a'.repeat(21), 'L\u200Bila', '1Lila', 'a@b.fr']) expect(zodSchemas.ActivationRequestSchema.safeParse({ token: 'x'.repeat(30), password: 'Un-mot-de-passe-long-1', displayName: bad }).success).toBe(false);
    expect(spec.components.schemas.Student.required).toEqual(expect.arrayContaining(['loginId', 'displayName']));
    expect(spec.components.schemas.Me.required).toEqual(['userId', 'role', 'familyId']);
    expect(zodSchemas.MeSchema.safeParse({ userId: 'u', role: 'parent', familyId: 'f' }).success).toBe(true);
    expect(zodSchemas.LoginIdResponseSchema.safeParse(spec.paths['/students/{sid}/login-id'].post.responses['200'].content['application/json'].example).success).toBe(true);
    expect(spec.components.schemas.Error.properties.code.enum).toEqual(expect.arrayContaining(['pseudo_refuse', 'pseudo_pris']));
    expect(Object.keys(spec.paths['/students/{sid}'].patch.responses)).toContain('409');
  });
});
