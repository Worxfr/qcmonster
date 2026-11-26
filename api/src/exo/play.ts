// Parcours eleve des exercices (E1, role `play`): demande, liste, enonce, indices, solution. Le serveur ne renvoie JAMAIS le bareme, les attendus,
// la valeur finale, les indices non vus ni la solution avant la demande de l'eleve (champ absent du contrat).
import { keys } from '../../../shared/ddb/keys.js';
import {
  EXO_DOC_XP_CAP, GEN_STALE_MS, MAX_COPIES_PER_EXO, MAX_EXO_PER_DOC, MAX_GEN_PER_DAY, MIN_VERIFIED_CLAIMS, SOLUTION_WAIT_MS, XP_EXO_MAX, exoRef, parseExoRef,
} from '../../../shared/exo.js';
import type { Deps } from '../lib/deps.js';
import { HttpError, conflict, notFound, type StudentCtx } from '../lib/http.js';
import type { Item } from '../lib/store.js';
import { activeStudent } from '../game/access.js';
import { parisDate } from '../game/time.js';
import type { GenInvoker } from './ports.js';

const DAY_TTL_S = 2 * 86_400;
export const ttlIn = (deps: Deps, s: number): number => Math.floor(deps.now().getTime() / 1000) + s;
export const err409 = (code: HttpError['code'], message: string) => new HttpError(409, code, message);

export type ExoEtat = 'generation' | 'prete' | 'echec';
/** Etat vu de l'eleve: une generation commencee il y a plus de 3 minutes est comptee comme echouee (le Lambda a pu mourir). */
export function etatOf(p: Item, now: number): ExoEtat {
  const e = p.etat as ExoEtat;
  return e === 'generation' && now - Number(p.startedAt ?? 0) > GEN_STALE_MS ? 'echec' : e;
}

/** Progression et exercice d'une reference de chemin; 404 si la reference est mal formee ou n'est pas a l'eleve (indiscernable d'un inconnu). */
export async function loadExo(deps: Deps, ctx: StudentCtx, ref: string): Promise<{ docId: string; nn: number; p: Item; exo: Item | undefined }> {
  const r = parseExoRef(ref);
  if (!r) throw notFound();
  const p = await deps.store.get(keys.exop(ctx.studentId, r.docId, r.nn));
  if (!p) throw notFound();
  const exo = p.etat === 'prete' ? await deps.store.get(keys.exo(r.docId, r.nn)) : undefined;
  return { ...r, p, exo };
}

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);

/** POST /docs/{docId}/exercices */
export async function createExo(deps: Deps, ctx: StudentCtx, docId: string, invoker: GenInvoker): Promise<{ exoId: string; etat: ExoEtat }> {
  await activeStudent(deps, ctx);
  const fiche = await deps.store.get(keys.doc(ctx.studentId, docId)); // seulement SES fiches
  if (!fiche) throw notFound();
  if (fiche.matiere !== 'maths' && fiche.matiere !== 'physique') throw err409('matiere_non_prevue', 'Les exercices existent pour les maths et la physique-chimie');
  const verdicts = await deps.store.query(`DOC#${docId}`, 'VERDICT#');
  if (verdicts.filter((v) => v.statut === 'verifiee').length < MIN_VERIFIED_CLAIMS) throw err409('fiche_trop_courte', "Cette fiche est trop courte pour fabriquer un exercice");
  for (let attempt = 0; attempt < 3; attempt++) {
    const now = deps.now().getTime();
    const day = parisDate(deps.now());
    const [rows, done, dayIt] = await Promise.all([
      deps.store.query(`STUDENT#${ctx.studentId}`, `EXOP#${docId}:`),
      deps.store.query(`DOC#${docId}`, 'EXO#'),
      deps.store.get(keys.copieJ(ctx.studentId, day)),
    ]);
    const live = rows.filter((r) => etatOf(r, now) !== 'echec');
    if (live.some((r) => etatOf(r, now) === 'generation')) throw err409('etat_invalide', 'Un exercice est déjà en préparation');
    if (live.length >= MAX_EXO_PER_DOC) throw err409('plafond_exercices', 'Cette fiche a déjà 5 exercices');
    const genDocs = (dayIt?.genDocs ?? {}) as Record<string, number>;
    if (num(genDocs[docId]) >= 1 || num(dayIt?.gen) >= MAX_GEN_PER_DAY) throw err409('plafond_exercices', "Tu as déjà demandé un exercice aujourd'hui pour cette fiche, reviens demain");
    // `nn` jamais reutilise: le plus grand vu parmi les progressions (meme echouees) et les exercices ecrits, plus 1.
    const seen = [...rows.map((r) => Number(String(r.SK).slice(-2))), ...done.map((d) => Number(String(d.SK).slice(-2)))].filter(Number.isFinite);
    const nn = (seen.length ? Math.max(...seen) : 0) + 1;
    if (nn > 99) throw err409('plafond_exercices', 'Cette fiche a déjà 5 exercices');
    const ok = await deps.store.commit([
      { item: { ...keys.exop(ctx.studentId, docId, nn), v: 0, etat: 'generation', startedAt: now, indicesVus: 0, nbCopies: 0, xpPaye: 0, meilleurMilli: 0, solutionVue: false, hashes: [], docId, nn }, when: 'absent' },
      { item: { ...keys.copieJ(ctx.studentId, day), gen: num(dayIt?.gen) + 1, genDocs: { ...genDocs, [docId]: 1 }, corr: num(dayIt?.corr), illisible: dayIt?.illisible ?? {}, ttl: ttlIn(deps, DAY_TTL_S) }, when: dayIt ? (dayIt.v ?? 'any') : 'absent' },
    ]);
    if (!ok) continue;
    try {
      await invoker.invoke({ sid: ctx.studentId, fid: ctx.familyId, docId, nn });
    } catch {
      const p = await deps.store.get(keys.exop(ctx.studentId, docId, nn));
      if (p) await deps.store.commit([{ item: { ...p, etat: 'echec' }, when: p.v ?? 'any' }]);
      return { exoId: exoRef(docId, nn), etat: 'echec' };
    }
    return { exoId: exoRef(docId, nn), etat: 'generation' };
  }
  throw conflict('Réessaie');
}

export interface ExerciceResume {
  exoId: string;
  titre?: string;
  etat: ExoEtat;
  points: 10;
  meilleurMilli?: number;
  xpPaye: number;
  solutionVue: boolean;
}
/** GET /docs/{docId}/exercices */
export async function listExo(deps: Deps, ctx: StudentCtx, docId: string): Promise<{ items: ExerciceResume[] }> {
  await activeStudent(deps, ctx);
  if (!(await deps.store.get(keys.doc(ctx.studentId, docId)))) throw notFound();
  const now = deps.now().getTime();
  const [rows, done] = await Promise.all([deps.store.query(`STUDENT#${ctx.studentId}`, `EXOP#${docId}:`), deps.store.query(`DOC#${docId}`, 'EXO#')]);
  const items = rows
    .map((p) => {
      const nn = Number(String(p.SK).slice(-2));
      const e = etatOf(p, now);
      const titre = e === 'prete' ? done.find((d) => d.SK === `EXO#${String(nn).padStart(2, '0')}`)?.titre : undefined;
      return { nn, e, r: { exoId: exoRef(docId, nn), ...(typeof titre === 'string' ? { titre } : {}), etat: e, points: XP_EXO_MAX, ...(num(p.meilleurMilli) > 0 ? { meilleurMilli: num(p.meilleurMilli) } : {}), xpPaye: num(p.xpPaye), solutionVue: p.solutionVue === true } as ExerciceResume };
    })
    .filter((x) => x.e !== 'echec') // un echec ne se range pas parmi les exercices (il ne compte pas dans les 5)
    .sort((a, b) => a.nn - b.nn)
    .map((x) => x.r);
  return { items };
}

export interface ExerciceView {
  exoId: string;
  docId: string;
  etat: ExoEtat;
  titre?: string;
  enonce?: string;
  points: 10;
  indicesVus: number;
  indicesTotal: 3;
  indicesDonnes: string[];
  nbCopies: number;
  copiesRestantes: number;
  solutionVue: boolean;
}
/** GET /exercices/{exoId}: note `ouvertA` au premier affichage de l'enonce (point de depart de la regle de 60 s). */
export async function getExo(deps: Deps, ctx: StudentCtx, ref: string): Promise<ExerciceView> {
  await activeStudent(deps, ctx);
  const { docId, p, exo } = await loadExo(deps, ctx, ref);
  const etat = etatOf(p, deps.now().getTime());
  let cur = p;
  if (etat === 'prete' && exo && p.ouvertA === undefined) {
    const w = { ...p, ouvertA: deps.now().getTime() };
    if (await deps.store.commit([{ item: w, when: p.v ?? 'any' }])) cur = w; // un conflit n'est pas grave: la prochaine lecture le pose
  }
  const vus = num(cur.indicesVus);
  const list = Array.isArray(exo?.indices) ? (exo!.indices as string[]) : [];
  return {
    exoId: ref,
    docId,
    etat: etat === 'prete' && !exo ? 'echec' : etat,
    ...(etat === 'prete' && exo ? { titre: String(exo.titre), enonce: String(exo.enonce) } : {}),
    points: XP_EXO_MAX,
    indicesVus: vus,
    indicesTotal: 3,
    indicesDonnes: list.slice(0, vus),
    nbCopies: num(cur.nbCopies),
    copiesRestantes: Math.max(0, MAX_COPIES_PER_EXO - num(cur.nbCopies)),
    solutionVue: cur.solutionVue === true,
  };
}

/** POST /exercices/{exoId}/indice: l'indice suivant; chaque indice retire 20 % de l'XP maximal. */
export async function nextHint(deps: Deps, ctx: StudentCtx, ref: string): Promise<{ rang: number; texte: string; indicesRestants: number }> {
  await activeStudent(deps, ctx);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { p, exo } = await loadExo(deps, ctx, ref);
    if (!exo || p.etat !== 'prete') throw err409('etat_invalide', "Cet exercice n'est pas prêt");
    const vus = num(p.indicesVus);
    const list = exo.indices as string[];
    if (vus >= 3 || vus >= list.length) throw err409('etat_invalide', "Il n'y a plus d'indice");
    if (await deps.store.commit([{ item: { ...p, indicesVus: vus + 1 }, when: p.v ?? 'any' }])) return { rang: vus + 1, texte: list[vus], indicesRestants: 2 - vus };
  }
  throw conflict('Réessaie');
}

/** POST /exercices/{exoId}/solution: apres au moins une correction, ou apres 3 indices et 10 minutes. Ferme les points. Redemander la rend a nouveau. */
export async function showSolution(deps: Deps, ctx: StudentCtx, ref: string): Promise<{ solution: string }> {
  await activeStudent(deps, ctx);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { p, exo } = await loadExo(deps, ctx, ref);
    if (!exo || p.etat !== 'prete') throw err409('etat_invalide', "Cet exercice n'est pas prêt");
    const now = deps.now().getTime();
    const waited = p.ouvertA !== undefined && now - Number(p.ouvertA) >= SOLUTION_WAIT_MS;
    if (num(p.nbCopies) < 1 && !(num(p.indicesVus) >= 3 && waited)) throw err409('pas_encore', "Essaie d'abord l'exercice");
    if (p.solutionVue === true) return { solution: String(exo.solution) };
    if (await deps.store.commit([{ item: { ...p, solutionVue: true, solutionA: now }, when: p.v ?? 'any' }])) return { solution: String(exo.solution) };
  }
  throw conflict('Réessaie');
}

export { EXO_DOC_XP_CAP };
