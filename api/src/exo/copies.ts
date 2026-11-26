// Copies (E1, roles `copieStart`, `play` et `copieDelete`): ouverture et envois signes, soumission, lecture avec credit des points, suppression.
// Le client n'envoie AUCUNE empreinte: `copie-correct` calcule lui-meme le SHA-256 des pages (design 8, anti-triche 1).
import { keys } from '../../../shared/ddb/keys.js';
import {
  MAX_COPIES_PER_EXO, MAX_COPIES_PER_DAY, MAX_ILLISIBLE_PER_EXO_DAY, MAX_PAGE_BYTES, MIN_COPIE_DELAY_MS, LOCK_STALE_MS, UPLOAD_EXPIRES_S, XP_EXO_MAX,
  bilanOf, capToDoc, exoLineId, exoXp, parseExoRef, type Etape, type Statut,
} from '../../../shared/exo.js';
import { copieQuotaDefaults } from '../../../shared/names.js';
import { costGateFor } from '../../../shared/cost.js';
import { isoSeconds, newTestId, schoolYearOf, MAX_TITLE, type TestLine } from '../../../shared/tests-history.js';
import type { Deps } from '../lib/deps.js';
import { HttpError, badRequest, conflict, notFound, type StudentCtx } from '../lib/http.js';
import type { Item, Write } from '../lib/store.js';
import { activeStudent } from '../game/access.js';
import { awardBadges, credit, mutate } from '../game/state.js';
import { parisDate, parisMonth, resetDate } from '../game/time.js';
import { err409, loadExo, ttlIn } from './play.js';
import { endWithoutCorrection, pageKeys, releaseLockWrite } from './fail.js';
import { pageKey, copiePrefix, type CopieFiles, type CopieStarter } from './ports.js';
import { newCopieId } from './ids.js';

const num = (x: unknown): number => (typeof x === 'number' && Number.isFinite(x) ? x : 0);
const DAY_TTL_S = 2 * 86_400;

async function quotaState(deps: Deps, ctx: StudentCtx, month: string) {
  const [s, f] = await Promise.all([deps.store.get(keys.copieQ(`STUDENT#${ctx.studentId}`, month)), deps.store.get(keys.copieQ(`FAMILY#${ctx.familyId}`, month))]);
  const lim = copieQuotaDefaults(deps.env);
  return { s, f, lim };
}
const quotaError = (deps: Deps) => new HttpError(409, 'quota_copies', 'Tu as utilisé toutes tes pages de copie ce mois-ci', resetDate(parisDate(deps.now())));

export interface CreateCopieResult {
  copieId: string;
  envois: { page: number; url: string; fields: Record<string, string> }[];
  expireA: string;
}

/** POST /exercices/{exoId}/copies: ouvre une copie `a_envoyer` (une seule par eleve, la nouvelle remplace l'ancienne) et signe un envoi par page. */
export async function createCopie(deps: Deps, ctx: StudentCtx, ref: string, body: { pages: number; contentType: 'image/jpeg' | 'image/png' }, files: CopieFiles): Promise<CreateCopieResult> {
  await activeStudent(deps, ctx);
  const { docId, nn, p, exo } = await loadExo(deps, ctx, ref);
  if (!exo) throw err409('etat_invalide', "Cet exercice n'est pas prêt");
  if (num(p.nbCopies) >= MAX_COPIES_PER_EXO) throw err409('plafond_copies', 'Tu as déjà rendu cet exercice 3 fois');
  const now = deps.now();
  const q = await quotaState(deps, ctx, parisMonth(now));
  if (num(q.s?.pages) + body.pages > q.lim.studentPages || num(q.f?.pages) + body.pages > q.lim.familyPages) throw quotaError(deps);
  const copieId = newCopieId(now.getTime());
  const old = await deps.store.get(keys.copieOuv(ctx.studentId));
  for (let attempt = 0; attempt < 3; attempt++) {
    const ouv = attempt === 0 ? old : await deps.store.get(keys.copieOuv(ctx.studentId));
    const prev = ouv?.copieId ? await deps.store.get(keys.copie(ctx.studentId, String(ouv.copieId))) : undefined;
    if (prev?.etat === 'a_envoyer') {
      await files.deleteKeys(pageKeys(ctx.studentId, prev.SK.slice('COPIE#'.length), num(prev.pages))); // la nouvelle copie remplace l'ancienne: ses images partent
    }
    const ok = await deps.store.commit([
      // L'ancienne copie passe a `annulee` (pas de DeleteItem pour ce role); son `ttl` de 2 jours la supprime.
      ...(prev?.etat === 'a_envoyer' ? [{ item: { ...prev, etat: 'annulee' }, when: prev.v ?? ('any' as const) }] : []),
      { item: { ...keys.copie(ctx.studentId, copieId), etat: 'a_envoyer', docId, exoNn: nn, pages: body.pages, createdAt: now.toISOString(), ttl: ttlIn(deps, DAY_TTL_S) }, when: 'absent' },
      { item: { ...keys.copieOuv(ctx.studentId), copieId, depuis: now.getTime() }, when: ouv ? (ouv.v ?? 'any') : 'absent' },
    ]);
    if (ok) {
      const envois = await Promise.all(Array.from({ length: body.pages }, async (_, i) => ({ page: i + 1, ...(await files.presign(pageKey(ctx.studentId, copieId, i + 1), body.contentType, MAX_PAGE_BYTES, UPLOAD_EXPIRES_S)) })));
      return { copieId, envois, expireA: new Date(now.getTime() + UPLOAD_EXPIRES_S * 1000).toISOString() };
    }
  }
  throw conflict('Réessaie');
}

/** POST /copies/{copieId}/submit: toutes les gardes, puis UNE transaction (copie, verrou, compteurs, quota), puis la machine d'etats. */
export async function submitCopie(deps: Deps, ctx: StudentCtx, copieId: string, starter: CopieStarter, files: Pick<CopieFiles, 'list'>): Promise<{ etat: 'en_correction' }> {
  await activeStudent(deps, ctx);
  for (let attempt = 0; attempt < 3; attempt++) {
    const c = await deps.store.get(keys.copie(ctx.studentId, copieId));
    if (!c) throw notFound();
    if (c.etat === 'en_correction') return { etat: 'en_correction' }; // double clic: la meme execution (nommee par copieId)
    if (c.etat !== 'a_envoyer') throw conflict('Cette copie ne peut plus être envoyée');
    const ref = `${String(c.docId)}-${String(num(c.exoNn)).padStart(2, '0')}`;
    if ((await deps.store.get(keys.exo(String(c.docId), num(c.exoNn))))?.retiree === true) throw err409('etat_invalide', 'Cet exercice a été retiré après une correction du cours, ta copie ne peut plus être envoyée');
    const { p, exo } = await loadExo(deps, ctx, ref);
    if (!exo) throw err409('etat_invalide', "Cet exercice n'est pas prêt");
    const nowD = deps.now();
    const now = nowD.getTime();
    if (num(p.nbCopies) >= MAX_COPIES_PER_EXO) throw err409('plafond_copies', 'Tu as déjà rendu cet exercice 3 fois');
    if (p.ouvertA === undefined || now - num(p.ouvertA) < MIN_COPIE_DELAY_MS) throw err409('trop_tot', "Prends le temps de faire l'exercice sur ta feuille");
    const day = parisDate(nowD);
    const dayIt = await deps.store.get(keys.copieJ(ctx.studentId, day));
    if (num(dayIt?.corr) >= MAX_COPIES_PER_DAY || num((dayIt?.illisible as Record<string, number> | undefined)?.[ref]) >= MAX_ILLISIBLE_PER_EXO_DAY) throw err409('plafond_copies', "Tu as déjà fait assez de corrections aujourd'hui, reviens demain");
    const lock = await deps.store.get(keys.copieActive(ctx.studentId));
    if (lock?.copieId && lock.copieId !== copieId && now - num(lock.depuis) < LOCK_STALE_MS) throw err409('deja_en_cours', 'Une correction est déjà en cours');
    const pages = num(c.pages);
    const present = new Set(await files.list(copiePrefix(ctx.studentId, copieId)));
    for (let i = 1; i <= pages; i++) if (!present.has(pageKey(ctx.studentId, copieId, i))) throw badRequest('Il manque une photo');
    const month = parisMonth(nowD);
    const q = await quotaState(deps, ctx, month);
    if (num(q.s?.pages) + pages > q.lim.studentPages || num(q.f?.pages) + pages > q.lim.familyPages) throw quotaError(deps);
    const [cm, ct] = await Promise.all([deps.store.get(keys.cost(deps.env, month)), deps.store.get(keys.costTotal(deps.env))]);
    if (costGateFor(deps.env, { monthEur: num(cm?.micros) / 1e6, totalEur: num(ct?.micros) / 1e6 }) !== 'ok') throw new HttpError(429, 'budget_epuise', 'Le service est en pause pour le moment', resetDate(day));
    const ttl = ttlIn(deps, 40 * 86_400);
    const writes: Write[] = [
      { item: { ...c, etat: 'en_correction', submittedAt: now }, when: c.v ?? 'any' },
      { item: { ...keys.copieActive(ctx.studentId), copieId, depuis: now }, when: lock ? (lock.v ?? 'any') : 'absent' },
      { item: { ...keys.copieQ(`STUDENT#${ctx.studentId}`, month), pages: num(q.s?.pages) + pages, ttl }, when: q.s ? (q.s.v ?? 'any') : 'absent' },
      { item: { ...keys.copieQ(`FAMILY#${ctx.familyId}`, month), pages: num(q.f?.pages) + pages, ttl }, when: q.f ? (q.f.v ?? 'any') : 'absent' },
      { item: { ...keys.copieJ(ctx.studentId, day), gen: num(dayIt?.gen), genDocs: dayIt?.genDocs ?? {}, illisible: dayIt?.illisible ?? {}, corr: num(dayIt?.corr) + 1, ttl: ttlIn(deps, DAY_TTL_S) }, when: dayIt ? (dayIt.v ?? 'any') : 'absent' },
      { item: { ...p, nbCopies: num(p.nbCopies) + 1 }, when: p.v ?? 'any' },
      { item: { ...keys.copieOuv(ctx.studentId), copieId: '', depuis: 0 }, when: 'any' },
    ];
    if (!(await deps.store.commit(writes))) continue;
    const input = { copieId, sid: ctx.studentId, fid: ctx.familyId, exoRef: ref, pages };
    try {
      await starter.start(copieId, input);
    } catch {
      await endWithoutCorrection(deps, input, { etat: 'echec', motif: 'technique', refundPages: true, refundAttempt: true });
      throw new HttpError(503, 'etat_invalide', 'Je ne peux pas corriger pour le moment, réessaie');
    }
    return { etat: 'en_correction' };
  }
  throw conflict('Réessaie');
}

export interface CopieView {
  copieId: string;
  exoId: string;
  etat: string;
  motif?: string;
  etapes?: { id: string; libelle: string; statut: Statut; indice: string }[];
  finale?: { libelle: string; statut: 'juste' | 'fausse' | 'absente' };
  scoreMilli?: number;
  bilan?: string;
  xpGagne?: number;
  solutionVue: boolean;
  badges?: string[];
}

/**
 * GET /copies/{copieId}: lecture, et CREDIT des points a la premiere lecture d'une copie corrigee (idempotent). Le role qui parle a Bedrock n'ecrit
 * ni PROFILE ni TEST#: le credit est fait ICI, dans la transaction de `mutate` (version de PROFILE: deux credits paralleles ne depassent pas le plafond).
 */
export async function getCopie(deps: Deps, ctx: StudentCtx, copieId: string): Promise<CopieView> {
  await activeStudent(deps, ctx);
  const c0 = await deps.store.get(keys.copie(ctx.studentId, copieId));
  if (!c0) throw notFound();
  const ref = `${String(c0.docId)}-${String(num(c0.exoNn)).padStart(2, '0')}`;
  const view = async (c: Item, p: Item | undefined, extra: { badges?: string[] } = {}): Promise<CopieView> => {
    const base: CopieView = { copieId, exoId: ref, etat: String(c.etat), solutionVue: p?.solutionVue === true };
    if (c.etat === 'echec' && typeof c.motif === 'string') base.motif = c.motif;
    if (c.etat !== 'corrigee') return base;
    const exo = await deps.store.get(keys.exo(String(c.docId), num(c.exoNn)));
    const labels = new Map(((exo?.etapes ?? []) as Etape[]).map((e) => [e.id, e.libelle]));
    const fin = c.finale as 'juste' | 'fausse' | 'absente';
    return {
      ...base,
      etapes: ((c.etapes ?? []) as { id: string; statut: Statut; indice: string }[]).map((e) => ({ id: e.id, libelle: labels.get(e.id) ?? '', statut: e.statut, indice: e.indice })),
      finale: { libelle: String((exo?.finale as { libelle?: string } | undefined)?.libelle ?? ''), statut: fin },
      scoreMilli: num(c.milli),
      bilan: String(c.bilan ?? ''),
      xpGagne: num(c.xp),
      ...(extra.badges?.length ? { badges: extra.badges } : {}),
    };
  };
  const p0 = parseExoRef(ref) ? await deps.store.get(keys.exop(ctx.studentId, String(c0.docId), num(c0.exoNn))) : undefined;
  if (c0.etat !== 'corrigee' || c0.credite === true) return view(c0, p0);

  type Credited = { done: boolean; gained: number; badges: string[] };
  const { result } = await mutate<Credited>(
    deps,
    ctx.familyId,
    ctx.studentId,
    async (s) => {
      const c = (await deps.store.get(keys.copie(ctx.studentId, copieId))) as Item;
      if (c.credite === true) return { result: { done: true as const, gained: 0, badges: [] as string[] } };
      const docId = String(c.docId);
      const nn = num(c.exoNn);
      const p = (await deps.store.get(keys.exop(ctx.studentId, docId, nn))) as Item;
      const exo = (await deps.store.get(keys.exo(docId, nn))) as Item;
      const fiche = await deps.store.get(keys.doc(ctx.studentId, docId));
      const rows = await deps.store.query(`STUDENT#${ctx.studentId}`, `EXOP#${docId}:`);
      const paidDoc = rows.reduce((n, r) => n + num(r.xpPaye), 0);
      // `solutionVue` est lu ICI (et jamais remis a faux): voir la solution avant l'envoi ou entre l'envoi et la lecture du retour donne 0 XP.
      const raw = exoXp({ scoreMilli: num(c.milli), indicesVus: num(p.indicesVus), xpPaye: num(p.xpPaye), solutionVue: p.solutionVue === true });
      const amount = capToDoc(raw, paidDoc);
      const cr = credit(s, amount, String(fiche?.matiere ?? 'autre'));
      const badges = awardBadges(s) as string[];
      const etapes = (c.etapes ?? []) as { id: string; statut: Statut }[];
      const fin = c.finale as 'juste' | 'fausse' | 'absente';
      const first = num(p.creditees) === 0;
      const at = new Date(s.now).toISOString();
      const lines: TestLine[] = [
        ...etapes.map((e, i) => ({ q: exoLineId(docId, nn, e.id), r: i + 1, k: 'exo' as const, ok: e.statut === 'ok' || e.statut === 'reporte', n: 1, f: first && (e.statut === 'ok' || e.statut === 'reporte'), xp: 0, at, c: '' })),
        { q: exoLineId(docId, nn, 'f'), r: etapes.length + 1, k: 'exo' as const, ok: fin === 'juste', n: 1, f: first && fin === 'juste', xp: 0, at, c: '' },
      ];
      const bil = bilanOf(Object.fromEntries(etapes.map((e) => [e.id, e.statut])), fin);
      const startedAt = isoSeconds(s.now);
      const testId = newTestId(s.now);
      const testKey = keys.test(ctx.studentId, startedAt, testId);
      const year = schoolYearOf(new Date(s.now));
      const years = new Set(((s.profile as unknown as { anneesScolaires?: string[] }).anneesScolaires ?? []) as string[]);
      years.add(year);
      (s.profile as unknown as { anneesScolaires: string[] }).anneesScolaires = [...years].sort().reverse();
      const test = {
        ...testKey, docId, titre: String(fiche?.titre ?? '').slice(0, MAX_TITLE), matiere: String(fiche?.matiere ?? 'autre'), mode: 'exercice', anneeScolaire: year, startedAt, endedAt: at,
        total: lines.length, answered: lines.length, correct: bil.correct, firstTry: lines.filter((l) => l.f).length, xpGained: cr.gained, items: lines, exoNn: nn, copieId,
      };
      const extra: Write[] = [
        { item: { ...c, credite: true, xp: cr.gained, retourAt: at, testSk: testKey.SK }, when: c.v ?? 'any' },
        { item: { ...p, xpPaye: num(p.xpPaye) + cr.gained, meilleurMilli: Math.max(num(p.meilleurMilli), num(c.milli)), creditees: num(p.creditees) + 1 }, when: p.v ?? 'any' },
        { item: test as unknown as Item, when: 'absent' },
      ];
      void exo;
      return { extra, result: { done: false as const, gained: cr.gained, badges } };
    },
    () => conflict('Réessaie'),
  );
  const c1 = (await deps.store.get(keys.copie(ctx.studentId, copieId))) as Item;
  const p1 = await deps.store.get(keys.exop(ctx.studentId, String(c1.docId), num(c1.exoNn)));
  return view(c1, p1, { badges: result.badges });
}

/**
 * DELETE /copies/{copieId}: 409 `en_correction` pendant la correction (la machine supprime elle-meme les images a la fin). Sinon images (cles exactes
 * deduites de `pages`), puis l'element. Les lignes `TEST#` gardent leur score.
 */
export async function deleteCopie(deps: Deps, ctx: StudentCtx, copieId: string, files: Pick<CopieFiles, 'deleteKeys'>): Promise<void> {
  await activeStudent(deps, ctx);
  const c = await deps.store.get(keys.copie(ctx.studentId, copieId));
  if (!c) throw notFound();
  if (c.etat === 'en_correction') throw new HttpError(409, 'en_correction', 'La correction est en cours');
  if (c.etat === 'a_envoyer') await files.deleteKeys(pageKeys(ctx.studentId, copieId, num(c.pages)));
  // Revue #100 M4: suppression CONDITIONNELLE a la version lue. Un `submit` passe entre la lecture et la suppression (copie devenue `en_correction`) gagne: 409.
  if (!(await deps.store.removeAt({ PK: c.PK, SK: c.SK }, typeof c.v === 'number' ? c.v : 'absent-v'))) throw new HttpError(409, 'en_correction', 'La correction est en cours');
  const ouv = await deps.store.get(keys.copieOuv(ctx.studentId));
  if (ouv?.copieId === copieId) await deps.store.remove({ PK: ouv.PK, SK: ouv.SK });
}

export { XP_EXO_MAX, releaseLockWrite };
