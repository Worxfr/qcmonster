// Figures (R1, docs/R1-design.md 3): cadres corriges par un modele plus gros, rognage `sharp`, bucket des figures. Aucun texte de cours dans les journaux.
import { JobBudgetExceededError } from '../../../shared/bedrock.js';
import { keys } from '../../../shared/ddb/keys.js';
import { log } from '../../../shared/log/index.js';
import { z } from 'zod';
import { validBox, type FigureMeta } from './blocks.js';
import { callModel, jobKey, mapLimit, type Ctx } from './ctx.js';
import { scansPrefix } from './job.js';
import type { CropPort, FigureStore } from './ports.js';
import { ModelOutputError, parseModelJson } from './text.js';
import { SYSTEM_JSON } from './prompts.js';

/** Cle S3 du recadrage temporaire (dans le prefixe de la photo: il part avec elle). */
export const tempFigureKey = (sid: string, jobId: string, figureId: string): string => `${scansPrefix(sid, jobId)}fig/${figureId}.jpg`;
/** Cle S3 d'une figure conservee. Toujours construite avec l'`sid` du jeton, jamais avec un identifiant de la requete. */
export const figureKey = (sid: string, coursId: string, figureId: string): string => `figures/${sid}/${coursId}/${figureId}.jpg`;
export const coursFiguresPrefix = (sid: string, coursId: string): string => `figures/${sid}/${coursId}/`;
export const studentFiguresPrefix = (sid: string): string => `figures/${sid}/`;
export const FIGURE_URL_TTL_S = 300;

const isPng = (b: Uint8Array) => b[0] === 0x89 && b[1] === 0x50;

// ---------------------------------------------------------------- cadres: reprise par un modele plus gros (3.5)
const BoxOut = z.object({ figures: z.array(z.object({ n: z.number().int().optional(), box: z.array(z.number()).optional() })).max(20) });

export const figureBoxPrompt = (page: number) =>
  `Image jointe = page ${page} d'un cours. Repere chaque figure de cette page (schema, graphique, tableau, carte, photo), dans l'ordre de lecture, ` +
  `et donne son cadre serre autour de la figure et de sa legende: "box":[x,y,largeur,hauteur] en fractions de la page (entre 0 et 1, origine en haut a gauche). ` +
  `Format: {"figures":[{"n":1,"box":[0.1,0.4,0.8,0.35]}]}`;

export interface BoxState {
  /** Le plafond du job a ete atteint: plus aucune reprise, les figures restantes passent en page entiere. */
  budgetHit: boolean;
}

/**
 * Cadres des figures d'une page par le modele plus gros. Mode `sonnet` d'abord: on reprend toutes les figures de la page; sinon seulement
 * celles dont le cadre est invalide. Cadre toujours faux, plafond atteint ou sortie illisible: page entiere (`box` absent), jamais d'echec du scan.
 */
export async function resolveBoxes(ctx: Ctx, i: { sid: string; jobId: string }, state: BoxState, page: number, image: Uint8Array, figs: FigureMeta[]): Promise<FigureMeta[]> {
  const first = ctx.cfg?.figureBoxModel === 'sonnet';
  const need = figs.some((f) => f.boxInvalid) || (first && figs.length > 0);
  let boxes: (number[] | undefined)[] = [];
  if (need && !state.budgetHit) {
    try {
      const raw = await callModel(ctx, i, 'figure-cadres', 'sonnet', { system: SYSTEM_JSON, prompt: figureBoxPrompt(page), maxTokens: 800, images: [{ format: isPng(image) ? 'png' : 'jpeg', bytes: image }] });
      boxes = parseModelJson(raw, BoxOut).figures.map((f) => f.box);
      log({ jobId: i.jobId, step: 'figure-crop', status: 'ok', fallback: 'retry' });
    } catch (e) {
      if (e instanceof JobBudgetExceededError) state.budgetHit = true;
      else if (!(e instanceof ModelOutputError)) throw e;
    }
  }
  return figs.map((f, k) => {
    const retried = validBox(boxes[k]);
    const box = first || f.boxInvalid ? (retried ?? (f.boxInvalid ? undefined : f.box)) : f.box;
    const { boxInvalid: _drop, ...rest } = f;
    void _drop;
    if (!box) log({ jobId: i.jobId, step: 'figure-crop', status: 'ok', fallback: 'page' });
    return { ...rest, ...(box ? { box } : {}) };
  });
}

// ---------------------------------------------------------------- etape cropFigures (3.4)
export interface CropInput {
  jobId: string;
  sid: string;
}

/**
 * Etape `cropFigures` (entre `transcribe` et `awaitConfirm`): ecrit un recadrage par figure sous la photo. Aucun appel de modele, idempotente
 * (une figure deja ecrite est sautee): la machine peut la rejouer. Une erreur persistante echoue le scan (quota rendu par `fail`), jamais de figure en texte seul.
 */
export async function cropFigures(ctx: Ctx, i: CropInput): Promise<{ ok: boolean }> {
  const job = await ctx.db.get(jobKey(i.sid, i.jobId));
  if (!job || job.state !== 'transcription') return { ok: false };
  if (ctx.cfg?.figuresEnabled === false) return { ok: true };
  const meta = await ctx.db.get(keys.jobBlocks(i.jobId));
  const figs = (meta?.figures as FigureMeta[] | undefined) ?? [];
  if (figs.length === 0) return { ok: true }; // aucun `sharp` charge
  const prefix = scansPrefix(i.sid, i.jobId);
  const done = new Set(await ctx.s3.list(`${prefix}fig/`));
  const pages = new Map<number, Uint8Array>();
  try {
    await mapLimit(figs, 2, async (f) => {
      const key = tempFigureKey(i.sid, i.jobId, f.figureId);
      if (done.has(key)) return;
      let img = pages.get(f.page);
      if (!img) {
        img = await ctx.s3.getBytes(`${prefix}${f.page - 1}`);
        pages.set(f.page, img);
      }
      await ctx.s3.put(key, await ctx.crop.crop(img, f.box), 'image/jpeg');
    });
  } catch (e) {
    log({ jobId: i.jobId, step: 'figure-crop', status: 'error', errorCode: (e as { name?: string })?.name });
    throw e;
  }
  // Course avec une annulation: la photo a pu etre supprimee pendant le rognage; un recadrage ecrit apres ne doit pas survivre.
  if ((await ctx.db.get(jobKey(i.sid, i.jobId)))?.state !== 'transcription') await ctx.s3.deleteAll(`${prefix}fig/`);
  log({ jobId: i.jobId, step: 'figure-crop', status: 'ok' });
  return { ok: true };
}

// ---------------------------------------------------------------- adaptateurs AWS (charges a la demande)
/** Rognage avec `sharp` (couche Lambda arm64 du lot B, jamais dans le paquet commun): import dynamique par nom pour que le paquet ne l'embarque pas. */
export function sharpCrop(): CropPort {
  const MAX_SIDE = 1200;
  const MARGIN = 0.04;
  return {
    async crop(image, box) {
      const name = 'sharp';
      const sharp = (await import(name)).default as (input: Uint8Array) => any; // eslint-disable-line @typescript-eslint/no-explicit-any
      const upright = await sharp(image).rotate().toBuffer(); // applique l'orientation EXIF, puis la sortie n'en porte aucune (ni GPS)
      let img = sharp(upright);
      if (box) {
        const meta = await img.metadata();
        const W = meta.width as number;
        const H = meta.height as number;
        const left = Math.max(0, Math.floor((box.x - MARGIN) * W));
        const top = Math.max(0, Math.floor((box.y - MARGIN) * H));
        const width = Math.min(W - left, Math.ceil((box.w + 2 * MARGIN) * W));
        const height = Math.min(H - top, Math.ceil((box.h + 2 * MARGIN) * H));
        if (width < 1 || height < 1) throw new RangeError('rognage vide');
        img = img.extract({ left, top, width, height });
      }
      return new Uint8Array(await img.resize({ width: MAX_SIDE, height: MAX_SIDE, fit: 'inside', withoutEnlargement: true }).jpeg({ quality: 80 }).toBuffer());
    },
  };
}

export async function s3Figures(figuresBucket: string, scansBucket: string): Promise<FigureStore> {
  const { S3Client, CopyObjectCommand, ListObjectsV2Command, DeleteObjectsCommand, GetObjectCommand } = await import('@aws-sdk/client-s3');
  const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
  const s3 = new S3Client({});
  const list = async (prefix: string): Promise<string[]> => {
    const out: string[] = [];
    let token: string | undefined;
    do {
      const r = await s3.send(new ListObjectsV2Command({ Bucket: figuresBucket, Prefix: prefix, ContinuationToken: token }));
      out.push(...(r.Contents ?? []).flatMap((o) => (o.Key ? [o.Key] : [])));
      token = r.NextContinuationToken;
    } while (token);
    return out.sort();
  };
  return {
    async copyFromScans(src, dest) {
      try {
        await s3.send(new CopyObjectCommand({ Bucket: figuresBucket, Key: dest, CopySource: `${scansBucket}/${src}`, MetadataDirective: 'REPLACE', ContentType: 'image/jpeg' }));
        return true;
      } catch (e) {
        if (['NoSuchKey', 'NotFound'].includes((e as { name?: string }).name ?? '')) return false;
        throw e;
      }
    },
    presignGet: (key, expiresSec) => getSignedUrl(s3, new GetObjectCommand({ Bucket: figuresBucket, Key: key }), { expiresIn: expiresSec }),
    list,
    async deleteAll(prefix) {
      for (let ks = await list(prefix); ks.length; ks = await list(prefix)) {
        const d = await s3.send(new DeleteObjectsCommand({ Bucket: figuresBucket, Delete: { Objects: ks.slice(0, 1000).map((Key) => ({ Key })), Quiet: true } }));
        if (d.Errors?.length) throw new Error('suppression de figures incomplete');
      }
    },
  };
}
