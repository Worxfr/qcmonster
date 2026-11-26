// Handlers HTTP du pipeline (routes owner=pipeline): scans-create, jobs-get, jobs-transcription, jobs-confirm, jobs-cancel.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ConfirmRequestSchema, ScanCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { costGateFor } from '../../../shared/cost.js';
import { keys, monthParis } from '../../../shared/ddb/keys.js';
import { cleanLabel, cleanTopic, MAX_COURS_BLOCKS, MAX_COURS_FIGURES, MAX_COURS_SECTIONS, planSections, statusOfJob, SUBJECTS, type SectionError } from '../../../shared/scans.js';
import { deleteCoursTree } from '../../../shared/delete-tree.js';
import { CoursBlocksItemSchema, CoursItemSchema, CoursTextItemSchema } from '../../../shared/items.js';
import { sanitizeLatex } from '../../../shared/latex.js';
import { releasePages, reservePages } from '../../../shared/quota.js';
import { log } from '../../../shared/log/index.js';
import { bodyOf, callerOf, fail, json, pathId, requireStudent, resetDate } from './http.js';
import { centsFromMicros, DAY_S, ID_RE, iso, jobKey, ttlIn, type Ctx } from './ctx.js';
import { appendBaseOf, baseOf, fits, lastSentences, MSG_APPEND, reclaimLock, releaseLock, restoreAfterFailedAppend, DELETING, type AppendBase } from './append.js';
import { endWithoutDoc, loadJob, scansPrefix, sentencesOf, sortedTexts, transition } from './job.js';
import { MIN_WORDS } from './steps.js';
import { renumber, type Block, type FigureMeta } from './blocks.js';
import { applyChanges, CHANGE_MESSAGES } from './changes.js';
import { coursFiguresPrefix, figureKey, FIGURE_URL_TTL_S, tempFigureKey } from './figures.js';
import { words } from './text.js';
import { quotaScope } from './quota-ops.js';
import { treeDbFrom, type Item } from './ports.js';

/** Limites d'envoi (design-v2 4.1 etape 1): 5 Mo par image. Les PDF ne sont pas pris en charge dans cette version (voir L2a-report.md). */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const UPLOAD_WINDOW_S = 15 * 60;
export const MESSAGES = { cancelled: "Annulé par l'élève" } as const;

type Res = Promise<APIGatewayProxyStructuredResultV2>;

/** Job au format du contrat (Job). Le cout vient du compteur en micro-euros, converti en centimes (arrondi au-dessus). */
export function jobView(j: Item, now: Date = new Date()) {
  const started = typeof j.confirmedAt === 'string' ? Date.parse(j.confirmedAt) : NaN;
  const ended = typeof j.finishedAt === 'string' ? Date.parse(j.finishedAt) : NaN;
  const micros = (j.coutMicros as number | undefined) ?? 0;
  return {
    jobId: j.SK.slice('JOB#'.length),
    state: j.state,
    pages: j.pages,
    createdAt: j.createdAt,
    ...(Number.isFinite(started) && Number.isFinite(ended) ? { durationSeconds: Math.max(0, Math.round((ended - started) / 1000)) } : {}),
    ...(micros > 0 ? { costCents: centsFromMicros(micros) } : {}),
    ...(typeof j.docId === 'string' ? { docId: j.docId } : {}),
    ...(typeof j.coursId === 'string' ? { coursId: j.coursId } : {}),
    ...(typeof j.message === 'string' ? { message: j.message } : {}),
    status: statusOfJob(j, now),
    ...(j.state === 'termine' && Array.isArray(j.docIds) && j.docIds.length ? { docIds: j.docIds } : {}),
  };
}

export async function scansCreate(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const parsed = ScanCreateRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  const { pages, contentType, contentTypes, folderId, coursId: appendTo } = parsed.data;
  if (appendTo !== undefined && !ID_RE.test(appendTo)) return fail('requete_invalide', 'Demande invalide');
  if (contentType === 'application/pdf') return fail('requete_invalide', 'Les PDF ne sont pas encore pris en charge : envoie des photos');
  // Tout est controle AVANT la reservation des pages: un refus ne laisse rien a rendre.
  if (contentTypes && contentTypes.length !== pages) return fail('requete_invalide', 'Un type par page est attendu');
  if (folderId !== undefined && !(await ctx.db.get(keys.folder(sid, folderId)))) return fail('introuvable', 'Dossier introuvable');
  const typeOf = (n: number): string => contentTypes?.[n] ?? contentType;

  // Ajout de pages (F10): tout est controle AVANT la reservation. Cours inconnu ou d'un autre eleve: 404 uniforme (cle de l'appelant).
  let target: { head: Item; base: AppendBase } | undefined;
  if (appendTo !== undefined) {
    let head = (await ctx.db.get(keys.cours(sid, appendTo))) ?? fail('introuvable', 'Introuvable');
    if (!(await reclaimLock(ctx, sid, head))) fail('etat_invalide', head.appendJobId === DELETING ? MSG_APPEND.deleting : MSG_APPEND.open);
    head = (await ctx.db.get(keys.cours(sid, appendTo))) ?? fail('introuvable', 'Introuvable');
    const origin = typeof head.jobId === 'string' ? await ctx.db.get(jobKey(sid, head.jobId)) : undefined;
    if (origin && origin.state !== 'termine') fail('etat_invalide', MSG_APPEND.notFinished); // scan d'origine pas fini: l'en-tete a encore un autre ecrivain
    const refusal = fits(head, pages);
    if (refusal) fail(refusal.code, refusal.message);
    target = { head, base: await baseOf(ctx, sid, head) };
  }

  const totals = await ctx.costStore.read();
  if (costGateFor(ctx.env, totals) !== 'ok') return fail('budget_epuise', 'Le service est en pause pour le moment', { resetDate: resetDate(ctx.now()) });

  const month = monthParis(ctx.now());
  const scope = await quotaScope(ctx, caller.familyId, sid, month);
  const jobId = ctx.newId();
  const jobItem = {
        ...jobKey(sid, jobId),
        familyId: caller.familyId,
        studentId: sid,
        state: 'en_attente_envoi',
        pages,
        expectedFiles: pages,
        contentType,
        ...(contentTypes ? { contentTypes } : {}),
        ...(folderId ? { folderId } : {}),
        quotaMonth: month,
        quotaState: 'reserved',
        coutMicros: 0,
        coutCentimes: 0,
        createdAt: iso(ctx),
        ttl: ttlIn(ctx, 7 * DAY_S),
        ...(target ? { appendTo, coursId: appendTo, appendBase: target.base } : {}),
  };
  if (target) {
    // Le job et le verrou du cours naissent ensemble (une transaction): jamais de verrou sans job. La condition porte sur l'etat lu (pages, phrases): la base ne peut pas etre perimee.
    // Les pages sont reservees APRES: un refus de quota libere le verrou (aucune page a rendre).
    const created = await ctx.db.transact([
      { put: { ...jobItem, quotaState: 'pending' }, ifNotExists: true },
      { key: keys.cours(sid, appendTo!), spec: { set: { appendJobId: jobId }, addSet: { jobIds: [target.head.jobId as string, jobId] }, cond: { exists: true, absent: ['appendJobId'], eq: { pages: target.base.pagesBefore, nbPhrases: target.base.nbPhrasesBefore } } } },
    ]);
    if (!created) fail('etat_invalide', MSG_APPEND.open);
    // Une panne entre la transaction et le demarrage de la machine ne laisse jamais le verrou: le job est ferme et le cours libere.
    let reserved: boolean;
    try {
      reserved = await reservePages(ctx.quota, scope, pages);
    } catch (e) {
      await transition(ctx, sid, jobId, ['en_attente_envoi'], 'echec', { message: 'Creation impossible', finishedAt: iso(ctx), quotaState: 'none' });
      await releaseLock(ctx, sid, appendTo!, jobId);
      throw e;
    }
    if (!reserved) {
      await transition(ctx, sid, jobId, ['en_attente_envoi'], 'echec', { message: 'Quota de pages épuisé', finishedAt: iso(ctx), quotaState: 'none' });
      await releaseLock(ctx, sid, appendTo!, jobId);
      return fail('quota_epuise', 'Quota de pages épuisé', { resetDate: resetDate(ctx.now()) });
    }
    await ctx.db.update(jobKey(sid, jobId), { set: { quotaState: 'reserved' }, cond: { exists: true } });
  } else if (!(await reservePages(ctx.quota, scope, pages))) return fail('quota_epuise', 'Quota de pages épuisé', { resetDate: resetDate(ctx.now()) });

  try {
    if (!target) await ctx.db.put({ ...jobItem, quotaState: 'reserved' }, true);
    // Le workflow demarre tout de suite: s'il n'y a pas d'envoi dans les 15 min, il rend le quota (aucune reservation orpheline).
    await ctx.sfn.start(`job-${jobId}`, { jobId, sid });
    // Une URL pre-signee PAR page: cle exacte scans/<eleve>/<job>/<p-1>, type fige pour cette page.
    const uploads = [];
    for (let n = 0; n < pages; n++) {
      const post = await ctx.s3.presignPost({ prefix: scansPrefix(sid, jobId), firstKey: `${scansPrefix(sid, jobId)}${n}`, contentType: typeOf(n), maxBytes: MAX_IMAGE_BYTES, expiresSec: UPLOAD_WINDOW_S });
      uploads.push({ page: n + 1, ...post });
    }
    const upload = uploads[0];
    const q = await ctx.quota.get(keys.quota(caller.familyId, month, sid));
    return json(201, {
      jobId,
      upload: { url: upload.url, fields: upload.fields },
      uploads,
      expiresAt: new Date(ctx.now().getTime() + UPLOAD_WINDOW_S * 1000).toISOString(),
      pagesRemaining: typeof q?.restant === 'number' ? q.restant : 0,
    });
  } catch (e) {
    // Echec apres reservation: on rend les pages et on ferme le job s'il a ete cree.
    const job = await ctx.db.get(jobKey(sid, jobId));
    if (job) await endWithoutDoc(ctx, sid, jobId, ['en_attente_envoi'], 'echec', 'Creation impossible');
    else await releasePages(ctx.quota, scope, pages);
    throw e;
  }
}

async function ownJob(ctx: Ctx, event: APIGatewayProxyEventV2): Promise<{ sid: string; jobId: string; job: Item }> {
  const caller = await callerOf(ctx, event);
  const sid = requireStudent(caller);
  const jobId = pathId(event, 'jobId');
  const job = await ctx.db.get(jobKey(sid, jobId));
  if (!job) return fail('introuvable', 'Introuvable');
  return { sid, jobId, job };
}

export async function jobsGet(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { job } = await ownJob(ctx, event);
  return json(200, jobView(job, ctx.now()));
}

const PHOTO_URL_TTL_S = 300;

export async function jobsTranscription(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  if (job.state !== 'a_confirmer') return fail('etat_invalide', "Le job n'est pas à confirmer");
  const texts = await sortedTexts(ctx, jobId); // tri NUMERIQUE des pages
  // Seules les photos attendues (indices < nombre de pages): un envoi en trop sous le prefixe n'est jamais montre. Tri numerique: « 10 » apres « 2 ».
  const prefix = scansPrefix(sid, jobId);
  const keysList = (await ctx.s3.list(prefix))
    .filter((k) => /^\d{1,2}$/.test(k.slice(prefix.length)) && Number(k.slice(prefix.length)) < (job.expectedFiles as number))
    .sort((a, b) => Number(a.slice(prefix.length)) - Number(b.slice(prefix.length)));
  const photoUrls = await Promise.all(keysList.map((k) => ctx.s3.presignGet(k, PHOTO_URL_TTL_S)));
  // Figures (R1): seulement celles dont le recadrage existe; URL pre-signee de 5 minutes re-signee a chaque appel. Un bloc `figure` sans image disparait.
  const meta = await ctx.db.get(keys.jobBlocks(jobId));
  const have = new Set(await ctx.s3.list(`${prefix}fig/`));
  const figures = await Promise.all(
    ((meta?.figures as FigureMeta[] | undefined) ?? [])
      .filter((f) => have.has(tempFigureKey(sid, jobId, f.figureId)))
      .map(async (f) => ({ figureId: f.figureId, page: f.page, kind: f.kind, alt: f.alt, ...(f.caption ? { caption: f.caption } : {}), ...(f.box ? { box: f.box } : {}), url: await ctx.s3.presignGet(tempFigureKey(sid, jobId, f.figureId), FIGURE_URL_TTL_S), urlExpireAt: new Date(ctx.now().getTime() + FIGURE_URL_TTL_S * 1000).toISOString() })),
  );
  const shown = new Set(figures.map((f) => f.figureId));
  const blocks = (meta?.blocks as Block[] | undefined)?.filter((b) => b.kind !== 'figure' || (b.figureId !== undefined && shown.has(b.figureId)));
  // Ajout de pages: les deux dernieres phrases du cours, en lecture seule (texte seul).
  const base = appendBaseOf(job);
  const context = base ? await lastSentences(ctx, sid, job.appendTo as string, base.pagesBefore) : [];
  return json(200, {
    jobId,
    docType: job.docType ?? 'cours',
    pages: texts.map((t) => ({ page: t.page, sentences: t.sentences })),
    ...(context.length ? { context } : {}),
    ...(blocks ? { blocks } : {}),
    ...(figures.length ? { figures } : {}),
    ...(typeof job.suggestedSubject === 'string' ? { suggestedSubject: job.suggestedSubject } : {}),
    ...(typeof job.suggestedTopic === 'string' ? { suggestedTopic: job.suggestedTopic } : {}),
    ...(Array.isArray(job.suggestedSections) && job.suggestedSections.length ? { suggestedSections: job.suggestedSections } : {}),
    photoUrls,
    photoUrlsExpireAt: new Date(ctx.now().getTime() + PHOTO_URL_TTL_S * 1000).toISOString(),
  });
}

/** Messages des refus de decoupage: des constantes, jamais le texte d'une phrase. */
const SECTION_MESSAGES: Record<SectionError, string> = {
  inconnu: 'Phrase de départ inconnue',
  ordre: 'Les sections doivent suivre l\'ordre du texte',
  debut: 'La première section commence à la première phrase',
  trop: 'Trop de sections pour ce scan',
  aucune_fiche: 'Garde au moins une section',
  vide: 'Une section est vide',
  trop_court: 'Il faut au moins 40 mots dans les parties gardees',
};

interface Chosen {
  fromSentenceId: string;
  subject: string;
  topic?: string;
  title?: string;
  folderId?: string;
  ignore: boolean;
}

export async function jobsConfirm(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  const parsed = ConfirmRequestSchema.safeParse(bodyOf(event));
  if (!parsed.success) return fail('requete_invalide', 'Demande invalide');
  if (job.state !== 'a_confirmer') return fail('etat_invalide', "Le job n'est pas à confirmer");
  const req = parsed.data;

  // Retraits, corrections et phrases ajoutees (M1 #89): une fonction pure, tout est valide AVANT la moindre ecriture (400: rien n'est modifie).
  const texts = await sortedTexts(ctx, jobId);
  // Les blocs du texte lu: sans eux (ancien job), un ajout n'entre que dans la liste des phrases.
  const meta = await ctx.db.get(keys.jobBlocks(jobId));
  const removed = new Set(req.removed ?? []);
  const applied = applyChanges(texts, meta?.blocks as Block[] | undefined, { removed: req.removed, corrections: req.corrections, ...(req.added ? { added: req.added } : {}) });
  if (!applied.ok) return fail('requete_invalide', CHANGE_MESSAGES[applied.error]);
  const changed = new Map(applied.changed.map((t) => [t.SK, t]));
  const finalTexts = applied.texts;
  const jobBlocks = applied.blocks;
  // Une cle d'ajout (`n3`) devient l'identifiant definitif partout ou le client peut la citer.
  const resolved = (id: string): string => applied.ids.get(id) ?? id;
  const all = sentencesOf(finalTexts);

  // Choix de l'eleve, valides AVANT toute ecriture (400 et 404 ne laissent rien derriere eux).
  const jobFolder = typeof job.folderId === 'string' ? job.folderId : undefined;
  const fallbackSubject = SUBJECTS.find((x) => x === job.suggestedSubject) ?? SUBJECTS.find((x) => x === job.draftSubject) ?? 'autre';
  const folderExists = async (id: string | undefined) => id === undefined || !!(await ctx.db.get(keys.folder(sid, id)));
  let chosen: Chosen[];
  let single: { subjectChoice?: string; topicChoice?: string; folderId?: string } | undefined;
  if (req.sections) {
    if (req.subject !== undefined || req.topic !== undefined || req.folderId !== undefined) return fail('requete_invalide', 'Choisis soit des sections, soit une matière pour tout le cours');
    chosen = [];
    for (const s of req.sections) {
      const topic = s.topic === undefined ? undefined : cleanTopic(s.topic);
      const title = s.title === undefined ? undefined : cleanLabel(s.title, 200);
      if (s.topic !== undefined && !topic) return fail('requete_invalide', 'Sujet vide');
      if (s.title !== undefined && !title) return fail('requete_invalide', 'Titre vide');
      if (!(await folderExists(s.folderId))) return fail('introuvable', 'Dossier introuvable');
      chosen.push({ fromSentenceId: resolved(s.fromSentenceId), subject: s.subject, ...(topic ? { topic } : {}), ...(title ? { title } : {}), ...(s.folderId ?? jobFolder ? { folderId: s.folderId ?? jobFolder } : {}), ignore: s.ignore === true });
    }
  } else {
    const topic = req.topic === undefined ? undefined : cleanTopic(req.topic);
    if (req.topic !== undefined && !topic) return fail('requete_invalide', 'Sujet vide'); // « <> » ou des espaces: le schema les laisse passer
    if (!(await folderExists(req.folderId))) return fail('introuvable', 'Dossier introuvable');
    const folderId = req.folderId ?? jobFolder;
    single = { ...(req.subject ? { subjectChoice: req.subject } : {}), ...(topic ? { topicChoice: topic } : {}), ...(folderId ? { folderId } : {}) };
    chosen = [{ fromSentenceId: all[0]?.id ?? '', subject: req.subject ?? fallbackSubject, ...(topic ?? (job.suggestedTopic as string | undefined) ? { topic: topic ?? (job.suggestedTopic as string) } : {}), ...(folderId ? { folderId } : {}), ignore: false }];
  }
  const base = appendBaseOf(job);
  const plan = planSections(all.map((s) => s.id), chosen, { wordCounts: all.map((s) => words(s.text).length), minWords: MIN_WORDS, pages: job.pages as number, ...(base ? { room: MAX_COURS_SECTIONS - base.sectionsBefore } : {}) });
  if (!plan.ok) return fail('requete_invalide', SECTION_MESSAGES[plan.error]);

  // Figures (R1): le choix de l'eleve est valide AVANT toute ecriture; une figure absente de la liste n'est pas conservee.
  const jobFigures = (meta?.figures as FigureMeta[] | undefined) ?? [];
  const choice = new Map<string, { keep: boolean; alt?: string }>();
  for (const f of req.figures ?? []) {
    if (!jobFigures.some((x) => x.figureId === f.figureId)) return fail('requete_invalide', 'Figure inconnue');
    const alt = f.alt === undefined ? undefined : cleanLabel(f.alt, 300);
    if (f.alt !== undefined && !alt) return fail('requete_invalide', 'Description vide');
    choice.set(f.figureId, { keep: f.keep, ...(alt ? { alt: sanitizeLatex(alt) } : {}) });
  }

  // Ajout de pages: les plafonds de la couche de mise en forme du cours (24 figures, 1200 blocs) sont controles AVANT toute ecriture,
  // sinon le schema leverait apres la copie des figures et l'ecriture de l'en-tete (500 repete, verrou tenu jusqu'a l'expiration).
  if (base?.hasBlocks) {
    const old = await ctx.db.get(keys.coursBlocks(sid, job.appendTo as string));
    const oldFigures = ((old?.figures as FigureMeta[] | undefined) ?? []).filter((f) => Number(f.figureId.slice(1)) <= base.figureMax).length;
    const oldBlocks = ((old?.blocks as Block[] | undefined) ?? []).filter((b) => Number(b.id.slice(1)) <= base.blockMax).length;
    const keepN = jobFigures.filter((f) => choice.get(f.figureId)?.keep).length;
    if (oldFigures + keepN > MAX_COURS_FIGURES) return fail('requete_invalide', `Tu as déjà gardé le maximum d'images pour ce cours (${MAX_COURS_FIGURES}). Décoche des images pour continuer.`);
    const newBlocks = (jobBlocks ?? []).filter((b) => (b.kind === 'figure' ? choice.get(b.figureId ?? '')?.keep === true : (b.sentenceIds ?? []).some((id) => !removed.has(id)))).length;
    if (oldBlocks + newBlocks > MAX_COURS_BLOCKS) return fail('requete_invalide', 'Ce cours a atteint la limite de mise en forme : scanne ces pages comme un nouveau cours.');
  }
  // Ajout de pages: de ce point, la restauration complete (cours, textes, figures) est due si la confirmation n'aboutit pas.
  if (base && !(await ctx.db.update(jobKey(sid, jobId), { set: { confirmStartedAt: iso(ctx) }, cond: { exists: true, eq: { state: 'a_confirmer' } } }))) return fail('etat_invalide', "Le job n'est plus à confirmer");
  // (a) identifiants: un docId par section non ignoree; le cours porte l'identifiant du job (deterministe: une relance ne laisse pas d'orphelin).
  // Ajout de pages (F10): le cours est celui du job (`appendTo`), ses identifiants de blocs et de figures continuent ceux du cours (P15).
  const coursId = base ? (job.appendTo as string) : jobId;
  const offFig = base?.figureMax ?? 0;
  const newFigId = (id: string): string => (base ? `f${offFig + Number(id.slice(1))}` : id);
  // Copie des figures gardees AVANT la transition (la photo existe encore): idempotente (meme cle), une erreur S3 est reessayable et ne change pas l'etat du job.
  // Un cours ancien sans couche de blocs ne recoit ni blocs ni figures pour un ajout (l'ecran affiche les phrases).
  const withBlocks = !base || base.hasBlocks;
  const kept: FigureMeta[] = [];
  try {
    for (const f of withBlocks ? jobFigures : []) {
      const c = choice.get(f.figureId);
      if (!c?.keep) continue;
      if (await ctx.figures.copyFromScans(tempFigureKey(sid, jobId, f.figureId), figureKey(sid, coursId, newFigId(f.figureId)))) kept.push({ ...f, ...(c.alt ? { alt: c.alt } : {}) });
    }
  } catch {
    // Jamais le prefixe du cours entier pour un ajout: seules les figures de ce job sont supprimees.
    if (base) for (const f of jobFigures) await ctx.figures.deleteAll(figureKey(sid, coursId, newFigId(f.figureId))).catch(() => undefined);
    else await ctx.figures.deleteAll(coursFiguresPrefix(sid, coursId)).catch(() => undefined);
    return fail('indisponible', 'Service momentanément indisponible, réessaie');
  }
  const sections = chosen.map((c) => ({ ...c, ...(c.ignore ? {} : { docId: ctx.newId() }) }));
  const docIds = sections.flatMap((s) => (s.docId ? [s.docId] : []));
  // (b) cours durable (sans TTL), corrections appliquees, section ignoree conservee. Une ecriture identique rejouee est sans effet.
  const createdAt = iso(ctx);
  const newSections = sections.map((s) => ({ ...s, statut: s.ignore ? 'ignoree' : 'fiche' }));
  if (base) {
    // En-tete d'abord et sous verrou (condition `appendJobId = ce job`, cours existant): calcule depuis la base, jamais depuis l'etat courant (rejouable sans doublon).
    const head = await ctx.db.get(keys.cours(sid, coursId));
    if (!head || head.appendJobId !== jobId) return fail('etat_invalide', "Le job n'est plus à confirmer");
    const merged = CoursItemSchema.parse({ ...head, pages: base.pagesBefore + (job.pages as number), nbPhrases: base.nbPhrasesBefore + all.length, sections: [...(head.sections as unknown[]).slice(0, base.sectionsBefore), ...newSections] });
    const ok = await ctx.db.update(keys.cours(sid, coursId), { set: { pages: merged.pages, nbPhrases: merged.nbPhrases, sections: merged.sections }, cond: { exists: true, eq: { appendJobId: jobId } } });
    if (!ok) return fail('etat_invalide', "Le job n'est plus à confirmer");
  } else {
    await ctx.db.put(CoursItemSchema.parse({ ...keys.cours(sid, coursId), jobId, jobIds: [jobId], pages: job.pages, createdAt, nbPhrases: all.length, sections: newSections }));
  }
  for (const t of finalTexts) await ctx.db.put(CoursTextItemSchema.parse({ ...keys.coursText(sid, coursId, t.page as number), page: t.page, sentences: t.sentences }));
  if (jobBlocks && withBlocks) {
    // Blocs du cours: sans les phrases retirees, sans bloc vide, sans bloc de figure non gardee. Pas de `doubt`. Identifiants renumerotes par `renumber` seulement pour un ajout de pages (F10).
    const keptIds = new Set(kept.map((f) => f.figureId));
    const blocks = (jobBlocks ?? [])
      .map((b) => (b.sentenceIds ? { ...b, sentenceIds: b.sentenceIds.filter((id) => !removed.has(id)) } : b))
      .filter((b) => (b.kind === 'figure' ? b.figureId !== undefined && keptIds.has(b.figureId) : (b.sentenceIds?.length ?? 0) > 0));
    if (base) {
      // Ajout: les blocs et figures de la base, puis les nouveaux renumerotes a la suite (recalcule depuis la base: un rejeu ne duplique rien).
      const old = await ctx.db.get(keys.coursBlocks(sid, coursId));
      const oldBlocks = ((old?.blocks as Block[] | undefined) ?? []).filter((b) => Number(b.id.slice(1)) <= base.blockMax);
      const oldFigures = ((old?.figures as FigureMeta[] | undefined) ?? []).filter((f) => Number(f.figureId.slice(1)) <= base.figureMax);
      const rn = renumber(blocks, kept, { block: base.blockMax, figure: base.figureMax });
      await ctx.db.put(CoursBlocksItemSchema.parse({ ...keys.coursBlocks(sid, coursId), blocks: [...oldBlocks, ...rn.blocks], figures: [...oldFigures, ...rn.figures] }));
    } else {
      await ctx.db.put(CoursBlocksItemSchema.parse({ ...keys.coursBlocks(sid, coursId), blocks, figures: kept }));
    }
  }
  // (c) le plan sur le job et la transition, en une seule ecriture conditionnelle: le premier qui change l'etat gagne la course
  // contre une annulation ou l'expiration.
  const moved = await transition(ctx, sid, jobId, ['a_confirmer'], 'verification', { confirmedAt: iso(ctx), coursId, docIds, sections, ...(single ?? {}) });
  if (!moved) {
    // Course perdue contre l'annulation ou l'expiration: le cours durable ecrit en (b) n'a plus de raison d'etre. On ne le supprime que si le job
    // est bien termine (jamais si une autre confirmation a gagne: meme `coursId`).
    const now = await ctx.db.get(jobKey(sid, jobId));
    if (now && ['rejete', 'expire', 'echec'].includes(now.state as string)) {
      // Ajout: le cours existait avant ce job, il est RESTAURE depuis la base (jamais supprime).
      if (base) await restoreAfterFailedAppend(ctx, sid, now);
      else {
        await ctx.figures.deleteAll(coursFiguresPrefix(sid, coursId)); // S3 avant DynamoDB
        await deleteCoursTree(treeDbFrom(ctx.db), sid, coursId, { jobId });
      }
    }
    return fail('etat_invalide', "Le job n'est plus à confirmer");
  }
  const token = typeof moved.confirmToken === 'string' ? moved.confirmToken : undefined;
  try {
    // (d) copie de travail corrigee, puis (e) reprise de la machine.
    for (const item of changed.values()) await ctx.db.put(item);
    if (token) await ctx.sfn.taskSuccess(token);
  } catch (e) {
    // Etat deja change: on libere la machine par un echec (job `echec`, quota rendu, cours supprime par `fail`): ce handler ne supprime rien.
    if (token) await ctx.sfn.taskFailure(token, 'ConfirmFailed');
    throw e;
  }
  // La reprise est deja partie: un echec de suppression ne la bloque pas (le cycle de vie S3 efface la photo au plus tard sous 1 jour).
  try {
    await ctx.s3.deleteAll(scansPrefix(sid, jobId));
  } catch {
    log({ jobId, step: 'photo-suppression', status: 'error' });
  }
  return json(200, jobView(moved, ctx.now()));
}

export async function jobsCancel(ctx: Ctx, event: APIGatewayProxyEventV2): Res {
  const { sid, jobId, job } = await ownJob(ctx, event);
  if (job.state !== 'en_attente_envoi' && job.state !== 'a_confirmer') return fail('etat_invalide', 'Ce traitement ne peut plus être annulé');
  if (job.confirmStartedAt !== undefined) return fail('etat_invalide', 'La confirmation est en cours, réessaie dans un instant'); // ajout: la restauration complete releve de l'expiration
  const won = await endWithoutDoc(ctx, sid, jobId, ['en_attente_envoi', 'a_confirmer'], 'rejete', MESSAGES.cancelled);
  if (!won) return fail('etat_invalide', 'Ce traitement ne peut plus être annulé');
  const after = await loadJob(ctx, sid, jobId);
  // Libere l'attente du workflow (envoi ou confirmation); un jeton deja termine est ignore par l'adaptateur Step Functions.
  for (const token of [after.confirmToken, after.uploadToken]) if (typeof token === 'string') await ctx.sfn.taskFailure(token, 'Cancelled');
  return json(200, jobView(after, ctx.now()));
}
