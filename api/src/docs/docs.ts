// Handlers HTTP des fiches (routes owner=pipeline): docs-read, docs-delete, docs-report. Assemble CLAIM# (L2a) et VERDICT# (L2b).
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ReportRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { deleteDocTree } from '../../../shared/delete-tree.js';
import { VerdictItemSchema, SignalementItemSchema } from '../../../shared/items.js';
import { keys } from '../../../shared/ddb/keys.js';
import { iso, type Ctx } from '../pipeline/ctx.js';
import { bodyOf, callerOf, fail, json, noContent, pathId, type Caller } from '../pipeline/http.js';
import { treeDbFrom, type Item } from '../pipeline/ports.js';
import { claimStatus } from '../pipeline/steps-doc.js';

type Res = Promise<APIGatewayProxyStructuredResultV2>;

const summary = (d: Item) => ({ docId: d.SK.slice('DOC#'.length), title: d.titre, subject: d.matiere, createdAt: d.createdAt });

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
  const { doc } = await findDoc(ctx, c, pathId(event, 'docId'));
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
        sources: ok ? ok.sources : [],
      };
    })
    .sort((a, b) => a.claimId.localeCompare(b.claimId));
  // Aucune cle de QCM ni mot attendu: ces elements ne sont jamais lus ici.
  return json(200, { ...summary(doc), summary: typeof doc.resume === 'string' ? doc.resume : '', claims });
}

export async function docsDelete(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const { sid, doc } = await findDoc(ctx, c, pathId(event, 'docId'));
  const n = await deleteDocTree(treeDbFrom(ctx.db), sid, pathId(event, 'docId'));
  if (n === 0) return fail('introuvable', 'Introuvable');
  // Le texte du cours (TEXT#, TTL 7 jours) part avec la fiche: une suppression demandee efface aussi la transcription.
  if (typeof doc.jobId === 'string') {
    const texts = (await ctx.db.query(`JOB#${doc.jobId}`, 'TEXT#')).map((t) => ({ PK: t.PK, SK: t.SK }));
    if (texts.length) await ctx.db.remove(texts);
  }
  return noContent();
}

export async function docsReport(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const c = await callerOf(ctx, event);
  const docId = pathId(event, 'docId');
  const parsed = ReportRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  await findDoc(ctx, c, docId);
  const { claimId, comment } = parsed.data;
  if (claimId !== undefined && !/^[0-9]{2}$/.test(claimId)) return fail('requete_invalide', 'Affirmation inconnue');
  if (claimId !== undefined && !(await ctx.db.get(keys.claim(docId, Number(claimId))))) return fail('requete_invalide', 'Affirmation inconnue');
  const reportId = ctx.newId();
  const item = SignalementItemSchema.parse({ ...keys.report(c.familyId, reportId), docId, ...(claimId ? { claimId } : {}), commentaire: comment.trim(), statut: 'ouvert', createdAt: iso(ctx) });
  await ctx.db.put({ ...item, reporterRole: c.role });
  return json(201, { reportId, docId, ...(claimId ? { claimId } : {}), status: 'ouvert' });
}
