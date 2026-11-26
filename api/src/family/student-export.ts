// Archive de l'ELEVE (R1 3.6, decision P14): tout ce qui est a lui, figures comprises, construite en ASYNCHRONE et ecrite en flux.
// POST /me/export/archive (demande), GET /me/export/archive/{exportId} (etat et lien), construction par une fonction propre (appel `Event`).
// Isolation: la partition lue est TOUJOURS celle du jeton (`sid`), les cles S3 sont construites avec lui; le parent n'a aucune route ici.
import { keys } from '../../../shared/ddb/keys.js';
import { retiredClaims } from '../../../shared/items.js';
import { figureKey } from '../pipeline/figures.js';
import { LINK_TTL_S, type ArchiveStore } from '../lib/archive-store.js';
import type { Deps } from '../lib/deps.js';
import { HttpError, notFound, type StudentCtx } from '../lib/http.js';
import type { Sink } from '../lib/multipart.js';
import type { Item } from '../lib/store.js';
import { ZipWriter } from '../lib/zip.js';
import { coursMeta } from '../cours/meta.js';

export const MAX_FIGURE_BYTES = 150 * 1024 * 1024;
/** 3 demandes par heure et par eleve (429 `quota_epuise`). */
export const MAX_EXPORTS_PER_HOUR = 3;
/** 1 jour, comme la regle d'expiration du bucket des scans (`expire-1-day`): l'etat ne survit pas au fichier. */
const EXPORT_TTL_S = 86_400;
export const studentExportKey = (sid: string, exportId: string): string => `exports/${sid}/${exportId}.zip`;

export interface FigureReader {
  /** Objets sous le prefixe avec leur taille. */
  list(prefix: string): Promise<{ key: string; size: number }[]>;
  /** Contenu d'un objet; undefined s'il n'existe plus. */
  get(key: string): Promise<Buffer | undefined>;
}
export interface StudentExportDeps extends Deps {
  archives: ArchiveStore;
  figures: FigureReader;
  openSink(key: string): Sink;
  /** Lance la construction en appel asynchrone (`Event`): la reponse HTTP n'attend pas. */
  launch(payload: { sid: string; exportId: string }): Promise<void>;
  /** Met a jour des attributs de l'element d'etat (la construction n'a pas le droit d'ecrire un element entier). */
  update(key: { PK: string; SK: string }, attrs: Record<string, unknown>): Promise<void>;
  /** Pour les tests; defaut MAX_FIGURE_BYTES. */
  maxFigureBytes?: number;
}

export interface ExportStatusView {
  exportId: string;
  state: 'en_cours' | 'pret' | 'echec';
  archive?: { url: string; expiresAt: string; format: 'zip'; sizeBytes: number; students: number; tests: number; truncated: boolean; courses: number; figures: number; omittedCourses: number };
}

export async function requestExport(deps: StudentExportDeps, ctx: StudentCtx): Promise<ExportStatusView> {
  const now = deps.now();
  const mine = await deps.store.query(`STUDENT#${ctx.studentId}`, 'EXPORT#');
  if (mine.filter((i) => now.getTime() - Date.parse(String(i.createdAt)) < 3_600_000).length >= MAX_EXPORTS_PER_HOUR) {
    throw new HttpError(429, 'quota_epuise', "Trop d'archives demandées, réessaie dans une heure");
  }
  const exportId = deps.newId();
  const key = keys.exportJob(ctx.studentId, exportId);
  const item: Item = { ...key, state: 'en_cours', createdAt: now.toISOString(), ttl: Math.floor(now.getTime() / 1000) + EXPORT_TTL_S };
  if (!(await deps.store.commit([{ item, when: 'absent' }]))) throw new HttpError(409, 'etat_invalide', 'Réessaie');
  try {
    await deps.launch({ sid: ctx.studentId, exportId });
  } catch (e) {
    await deps.store.commit([{ item: { ...item, state: 'echec' }, when: 'any' }]);
    throw e;
  }
  return { exportId, state: 'en_cours' };
}

export async function getExport(deps: StudentExportDeps, ctx: StudentCtx, exportId: string): Promise<ExportStatusView> {
  const it = await deps.store.get(keys.exportJob(ctx.studentId, exportId)); // la cle vient du jeton: l'exportId d'un autre eleve est introuvable
  const now = deps.now();
  if (!it || (typeof it.ttl === 'number' && it.ttl * 1000 <= now.getTime())) throw notFound();
  if (it.state !== 'pret') return { exportId, state: it.state === 'echec' ? 'echec' : 'en_cours' };
  const url = await deps.archives.signedUrl(studentExportKey(ctx.studentId, exportId)); // re-signe a chaque lecture
  return {
    exportId,
    state: 'pret',
    archive: {
      url,
      expiresAt: new Date(now.getTime() + LINK_TTL_S * 1000).toISOString(),
      format: 'zip',
      sizeBytes: Number(it.sizeBytes ?? 0),
      students: 1,
      tests: Number(it.tests ?? 0),
      truncated: it.truncated === true,
      courses: Number(it.courses ?? 0),
      figures: Number(it.figures ?? 0),
      omittedCourses: Number(it.omittedCourses ?? 0),
    },
  };
}

const strip = (i: Item, extra: string[] = []): Record<string, unknown> => {
  const o: Record<string, unknown> = { ...i };
  for (const k of ['PK', 'SK', 'v', 'ttl', 'GSI1PK', 'GSI1SK', ...extra]) delete o[k];
  return o;
};

/**
 * Construction (fonction propre, 15 minutes, 512 Mo): le zip est ecrit en flux, une seule image en memoire a la fois. Figures: 150 Mo au plus,
 * les cours les PLUS ANCIENS perdent leurs images au-dela (le texte est toujours complet), `truncated` et `omittedCourses` le disent.
 */
export async function buildStudentExport(deps: StudentExportDeps, i: { sid: string; exportId: string }): Promise<void> {
  const { sid, exportId } = i;
  const jobKey = keys.exportJob(sid, exportId);
  const job = await deps.store.get(jobKey);
  if (!job || job.state !== 'en_cours') return; // demande inconnue ou deja traitee: rien a faire (rejeu sans effet)
  const sink = deps.openSink(studentExportKey(sid, exportId));
  try {
    const now = deps.now();
    const part = await deps.store.query(`STUDENT#${sid}`);
    const profile = strip(part.find((x) => x.SK === 'PROFILE') ?? ({} as Item), ['currentTest']);
    const docItems = part.filter((x) => x.SK.startsWith('DOC#'));
    const existing = new Set(docItems.map((d) => d.SK.slice('DOC#'.length)));
    const heads = part.filter((x) => /^COURS#[^#]+$/.test(x.SK)).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt))); // recents d'abord

    // Figures: seulement celles ecrites dans `COURS#<id>#B` de CET eleve, comptees avec leur taille reelle.
    const sizes = new Map((await deps.figures.list(`figures/${sid}/`)).map((o) => [o.key, o.size]));
    const limit = deps.maxFigureBytes ?? MAX_FIGURE_BYTES;
    let used = 0;
    let cut = false;
    let omittedCourses = 0;
    const figureFiles: { name: string; key: string }[] = [];
    const cours = heads.map((h) => {
      const coursId = h.SK.slice('COURS#'.length);
      const b = part.find((x) => x.SK === `COURS#${coursId}#B`);
      const figs = ((b?.figures as { figureId: string }[] | undefined) ?? []).map((f) => ({ id: f.figureId, key: figureKey(sid, coursId, f.figureId) })).filter((f) => sizes.has(f.key));
      const bytes = figs.reduce((n, f) => n + (sizes.get(f.key) ?? 0), 0);
      if (figs.length) {
        if (!cut && used + bytes <= limit) {
          used += bytes;
          for (const f of figs) figureFiles.push({ name: `figures/${coursId}/${f.id}.jpg`, key: f.key });
        } else {
          cut = true;
          omittedCourses++;
        }
      }
      const texts = part.filter((x) => x.SK.startsWith(`COURS#${coursId}#T`)).map((t) => ({ page: t.page, sentences: (t.sentences as { added?: boolean }[] | undefined)?.map(({ added: _added, ...rest }) => rest) })).sort((p, q) => Number(p.page) - Number(q.page));
      return { ...coursMeta(h, existing), texts, ...(b ? { blocks: b.blocks, figures: b.figures } : {}) };
    });

    const docs = [];
    for (const d of docItems) {
      const docId = d.SK.slice('DOC#'.length);
      const rows = await deps.store.query(`DOC#${docId}`);
      const verdicts = new Map(rows.filter((r) => r.SK.startsWith('VERDICT#')).map((r) => [r.SK.slice('VERDICT#'.length), r]));
      const gone = retiredClaims(d); // M1 #90: affirmations retirees par une modification: pas dans l'archive (les tests gardent leur historique)
      docs.push({
        ...strip(d, ['empreinteMinHash', 'familyId', 'studentId']),
        docId,
        claims: rows.filter((r) => r.SK.startsWith('CLAIM#') && !gone.has(Number(r.SK.slice('CLAIM#'.length)))).map((c) => ({ claimId: c.SK.slice('CLAIM#'.length), text: c.texte, status: verdicts.get(c.SK.slice('CLAIM#'.length))?.statut ?? 'non_verifiable', sources: verdicts.get(c.SK.slice('CLAIM#'.length))?.sources ?? [] })),
      });
    }
    const folders = part.filter((x) => x.SK.startsWith('FOLDER#')).map((f) => ({ folderId: f.SK.slice('FOLDER#'.length), name: f.nom, createdAt: f.createdAt }));
    const tests = part.filter((x) => x.SK.startsWith('TEST#')).sort((a, b) => a.SK.localeCompare(b.SK)); // avec les reponses donnees (`choice`): ce sont les siennes
    const truncated = cut;

    const zw = new ZipWriter(now);
    await sink.write(zw.add('export.json', Buffer.from(JSON.stringify({ exportedAt: now.toISOString(), student: profile, folders, cours, docs, truncated, omittedCourses }, null, 1), 'utf8')));
    await sink.write(zw.add(`tests/${sid}.jsonl`, Buffer.from(tests.map((t) => JSON.stringify(strip(t))).join('\n') + (tests.length ? '\n' : ''), 'utf8')));
    let figures = 0;
    for (const f of figureFiles) {
      const bytes = await deps.figures.get(f.key); // une image a la fois, jamais plus
      if (!bytes) continue; // supprimee entre-temps
      await sink.write(zw.add(f.name, bytes, 'store'));
      figures++;
    }
    await sink.write(zw.end());
    const sizeBytes = await sink.finish();
    await deps.update(jobKey, { state: 'pret', sizeBytes, tests: tests.length, courses: cours.length, figures, truncated, omittedCourses });
  } catch (e) {
    await sink.abort().catch(() => undefined);
    await deps.update(jobKey, { state: 'echec' }).catch(() => undefined);
    throw e;
  }
}
