// Handlers HTTP des fiches (routes owner=pipeline): docs-read, docs-delete, docs-report. Assemble CLAIM# (L2a) et VERDICT# (L2b).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { DocUpdateRequestSchema, ReportRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { deleteDocTree } from '../../../shared/delete-tree.js';
import { VerdictItemSchema, SignalementItemSchema } from '../../../shared/items.js';
import { keys } from '../../../shared/ddb/keys.js';
import { cleanTopic } from '../../../shared/scans.js';
import { ID_RE, iso, type Ctx } from '../pipeline/ctx.js';
import { bodyOf, callerOf, fail, json, noContent, pathId, requireStudent, type Caller } from '../pipeline/http.js';
import { treeDbFrom, type Item } from '../pipeline/ports.js';
import { claimStatus } from '../pipeline/steps-doc.js';
import { figuresOfSection, loadCoursBlocks, sectionRank, sentenceOrder, signFigures } from '../cours/view.js';
import { ALLOWED_HOSTS } from '../verify/fetch.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;

/** Une source n'est rendue que si son URL est en https sur un hote de la liste de verification (jamais javascript:, http:, ni un hote tiers). */
export const sourceAllowed = (url: unknown): boolean => {
  try {
    const u = new URL(String(url));
    return u.protocol === 'https:' && !u.username && !u.password && !u.port && ALLOWED_HOSTS.includes(u.hostname);
  } catch {
    return false;
  }
};

const str = (x: unknown): string | undefined => (typeof x === 'string' && x ? x : undefined);
/** Resume d'une fiche (contrat 1.3: sujet, dossier, cours d'origine et rang de section, seulement s'ils existent). */
const summary = (d: Item) => {
  const topic = cleanTopic(d.sujet);
  return {
    docId: d.SK.slice('DOC#'.length),
    title: d.titre,
    subject: d.matiere,
    createdAt: d.createdAt,
    ...(topic ? { topic } : {}),
    ...(str(d.dossierId) ? { folderId: str(d.dossierId) } : {}),
    ...(typeof d.nbQuestions === 'number' ? { questionCount: d.nbQuestions } : {}), // Q1: un nombre, jamais un contenu
    ...(str(d.coursId) ? { coursId: str(d.coursId) } : {}),
    ...(typeof d.sectionIndex === 'number' ? { sectionIndex: d.sectionIndex } : {}),
  };
};

/** Fiches visibles: celles de l'eleve, ou de toute la famille pour un parent (liste via GSI1, sans texte de cours). */
async function visibleDocs(ctx: Ctx, c: Caller): Promise<Item[]> {
  if (c.role === 'eleve') return ctx.db.query(`STUDENT#${c.studentId}`, 'DOC#');
  return ctx.db.queryGsi1(`FAMILY#${c.familyId}`, 'DOC#');
}

/** Fiche par identifiant, seulement si elle est visible par l'appelant (sinon 404 uniforme). */
async function findDoc(ctx: Ctx, c: Caller, docId: string): Promise<{ sid: string; doc: Item }> {
  const doc = (await visibleDocs(ctx, c)).find((d) => d.SK === `DOC#${docId}`);
  if (!doc) return fail('introuvable', 'Introuvable');
  return { sid: doc.PK.slice('STUDENT#'.length), doc };
}

export async function docsRead(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const docId = event.pathParameters?.docId;
  if (docId === undefined) {
    const docs = (await visibleDocs(ctx, c)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
    return json(200, { items: docs.map(summary) });
  }
  const { sid, doc } = await findDoc(ctx, c, pathId(event, 'docId'));
  const part = await ctx.db.query(`DOC#${docId}`);
  const verdicts = new Map(part.filter((x) => x.SK.startsWith('VERDICT#')).map((x) => [x.SK.slice('VERDICT#'.length), x]));
  const claims = part
    .filter((x) => x.SK.startsWith('CLAIM#'))
    .map((cl) => {
      const nn = cl.SK.slice('CLAIM#'.length);
      const v = verdicts.get(nn);
      const parsed = v ? VerdictItemSchema.safeParse(v) : undefined;
      // Verdict illisible: on l'ignore (non verifiable, sans source) plutot que d'afficher une source douteuse.
      const ok = parsed?.success ? parsed.data : undefined;
      return {
        claimId: nn,
        text: cl.texte,
        status: claimStatus(cl, ok ? v : undefined),
        aRisque: cl.aRisque === true,
        ...(c.role === 'eleve' && typeof doc.coursId === 'string' && typeof (cl.origine as { phraseId?: unknown } | undefined)?.phraseId === 'string' ? { sentenceId: (cl.origine as { phraseId: string }).phraseId } : {}),
        sources: ok ? ok.sources.filter((src) => sourceAllowed(src.url)) : [],
      };
    })
    .sort((a, b) => a.claimId.localeCompare(b.claimId));
  // Aucune cle de QCM ni mot attendu: ces elements ne sont jamais lus ici.
  // R1, ELEVE SEULEMENT: le parent ne recoit ni paragraphes, ni rappel, ni figures (il ne lit pas le texte du cours).
  const mine = c.role === 'eleve' && c.studentId === sid;
  let figures: Awaited<ReturnType<typeof signFigures>> = [];
  const coursId = typeof doc.coursId === 'string' && ID_RE.test(doc.coursId) ? doc.coursId : undefined;
  if (mine && coursId && typeof doc.sectionIndex === 'number') {
    const head = await ctx.db.get(keys.cours(sid, coursId));
    const cb = head ? await loadCoursBlocks(ctx, sid, coursId) : undefined;
    if (head && cb) {
      const texts = (await ctx.db.query(`STUDENT#${sid}`, `COURS#${coursId}#T`)).filter((t) => t.SK.startsWith(`COURS#${coursId}#T`));
      figures = await signFigures(ctx, sid, coursId, figuresOfSection(head, sentenceOrder(texts), cb.blocks, cb.figures, sectionRank(head, docId, doc.sectionIndex)));
    }
  }
  return json(200, {
    ...summary(doc),
    summary: typeof doc.resume === 'string' ? doc.resume : '',
    claims,
    ...(mine && Array.isArray(doc.body) && doc.body.length ? { body: doc.body } : {}),
    ...(mine && Array.isArray(doc.recall) && doc.recall.length ? { recall: doc.recall } : {}),
    ...(figures.length ? { figures } : {}),
  });
}

export async function docsDelete(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const { sid, doc } = await findDoc(ctx, c, pathId(event, 'docId'));
  const n = await deleteDocTree(treeDbFrom(ctx.db), sid, pathId(event, 'docId'));
  if (n === 0) return fail('introuvable', 'Introuvable');
  // Le texte du cours (TEXT#, TTL 7 jours) part avec la fiche: une suppression demandee efface aussi la transcription.
  if (typeof doc.jobId === 'string') {
    const texts = (await ctx.db.query(`JOB#${doc.jobId}`)).filter((t) => t.SK.startsWith('TEXT#') || t.SK === 'BLOCKS').map((t) => ({ PK: t.PK, SK: t.SK }));
    if (texts.length) await ctx.db.remove(texts);
  }
  // N6: le commentaire libre d'un signalement ne survit pas a sa fiche (les signalements sont sous la famille, avec le docId).
  const reports = (await ctx.db.query(`FAMILY#${c.familyId}`, 'REPORT#')).filter((r) => r.docId === pathId(event, 'docId')).map((r) => ({ PK: r.PK, SK: r.SK }));
  if (reports.length) await ctx.db.remove(reports);
  return noContent();
}

export async function docsReport(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const docId = pathId(event, 'docId');
  const parsed = ReportRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  const { sid } = await findDoc(ctx, c, docId);
  const { claimId, comment } = parsed.data;
  if (claimId !== undefined && !/^[0-9]{2}$/.test(claimId)) return fail('requete_invalide', 'Affirmation inconnue');
  if (claimId !== undefined && !(await ctx.db.get(keys.claim(docId, Number(claimId))))) return fail('requete_invalide', 'Affirmation inconnue');
  const reportId = ctx.newId();
  const item = SignalementItemSchema.parse({ ...keys.report(c.familyId, reportId), docId, studentId: sid, ...(claimId ? { claimId } : {}), commentaire: comment.trim(), statut: 'ouvert', createdAt: iso(ctx) });
  await ctx.db.put({ ...item, reporterRole: c.role });
  return json(201, { reportId, docId, ...(claimId ? { claimId } : {}), status: 'ouvert' });
}

/** PATCH /docs/{docId}: l'eleve change la matiere et/ou le sujet de sa fiche. Le parent est refuse (403) avant toute recherche de la fiche. */
export async function docsPatch(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const sid = requireStudent(c);
  const docId = pathId(event, 'docId');
  const parsed = DocUpdateRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success || (parsed.data.subject === undefined && parsed.data.topic === undefined)) return fail('requete_invalide', 'Demande invalide');
  const { subject, topic } = parsed.data;
  const set: Record<string, unknown> = {};
  const remove: string[] = [];
  if (subject !== undefined) set.matiere = subject;
  if (topic === null) remove.push('sujet');
  else if (topic !== undefined) {
    const clean = cleanTopic(topic);
    if (!clean) return fail('requete_invalide', 'Demande invalide'); // vide apres nettoyage (espaces, chevrons, caracteres invisibles)
    set.sujet = clean;
  }
  // Mise a jour conditionnelle sur la fiche DE L'ELEVE: une fiche absente ou d'un autre eleve n'est jamais creee ni modifiee.
  const doc = await ctx.db.update(keys.doc(sid, docId), { set, remove, cond: { exists: true } });
  if (!doc) return fail('introuvable', 'Introuvable');
  return json(200, summary(doc));
}
