// Routes publiques du partage (S1 #34): ouverture et signalement. Base en memoire; aucun appel reel.
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import type { HttpError } from '../lib/http.js';
import { hashToken } from './ctx.js';
import { deleteMine, listForParent } from './manage.js';
import { openShare, reportShare, ReportBodySchema } from './public.js';
import { create, fails, make, parent, snapshot, student, untouchable } from './testkit.js';

const five = (ids: string[]) => ids.slice(0, 5);

describe('shares-open', () => {
  it("rend la copie figee et rien d'autre; compte une lecture; ne touche ni PROFILE, ni ATT, ni DAY de jeu", async () => {
    const { k, paidIds } = await make();
    const nonShare = () => snapshot(k, /^(STUDENT#|FAMILY#|DOC#)/).filter((l) => !/SHAREREF|SHARESLOT|SHAREJ/.test(l));
    const before = nonShare();
    const r = await create(k, five(paidIds));
    const q = await openShare(k.ctx, r.token);
    expect(Object.keys(q).sort()).toEqual(['expiresAt', 'questions', 'subject', 'title']);
    expect(q.questions).toHaveLength(5);
    for (const x of q.questions as Record<string, unknown>[]) expect(Object.keys(x).sort()).toEqual(x.kind === 'qcm' ? ['answer', 'choices', 'kind', 'prompt'] : ['expected', 'kind', 'prompt']);
    expect(await k.db.get(keys.shareDay(hashToken(r.token), '2026-12-01'))).toMatchObject({ n: 1 });
    expect(nonShare()).toEqual(before);
  });
  it('un lien inutilisable repond le MEME 404 (statut, code, message): mal forme, inconnu, revoque, suspendu, plafond, expire, interrupteur ferme', async () => {
    const { k, paidIds } = await make();
    const live = await create(k, five(paidIds), { ttlDays: 1 });
    const gone = await create(k, five(paidIds), { title: 'Titre deux' });
    await deleteMine(k.ctx, student, gone.shareId);
    const susp = await create(k, five(paidIds), { title: 'Titre trois' });
    for (let i = 0; i < 3; i++) await reportShare(k.ctx, susp.token, 'inapproprie');
    const capped = await create(k, five(paidIds), { title: 'Titre quatre' });
    await k.db.put({ ...keys.shareDay(hashToken(capped.token), '2026-12-01'), n: 1000, ttl: 1 });
    const errors: HttpError[] = [];
    for (const token of ['court', `${'A'.repeat(21)}+`, 'B'.repeat(22), gone.token, susp.token, capped.token]) errors.push(await fails(openShare(k.ctx, token), 404, 'lien_indisponible'));
    errors.push(await fails(openShare(k.with({ publicEnabled: false }), live.token), 404, 'lien_indisponible'));
    k.t.ms += 2 * 86_400_000;
    errors.push(await fails(openShare(k.ctx, live.token), 404, 'lien_indisponible'));
    expect(new Set(errors.map((e) => `${e.status}|${e.code}|${e.message}`)).size).toBe(1);
  });
  it('jeton mal forme ou interrupteur ferme: AUCUN acces a la base', async () => {
    const { k } = await make();
    await fails(openShare({ ...k.ctx, db: untouchable() }, 'trop court'), 404);
    await fails(openShare({ ...k.ctx, db: untouchable() }, `=${'A'.repeat(21)}`), 404);
    await fails(openShare({ ...k.ctx, db: untouchable(), publicEnabled: false }, 'A'.repeat(22)), 404);
    await fails(reportShare({ ...k.ctx, db: untouchable(), publicEnabled: false }, 'A'.repeat(22), 'autre'), 404);
    await fails(reportShare({ ...k.ctx, db: untouchable() }, 'court', 'autre'), 404);
  });
  it("un jeton inconnu n'ecrit RIEN (ni DAY#, ni REPORT#)", async () => {
    const { k } = await make();
    const before = snapshot(k, /.*/);
    await fails(openShare(k.ctx, 'Z'.repeat(22)), 404);
    await fails(reportShare(k.ctx, 'Z'.repeat(22), 'autre'), 404);
    expect(snapshot(k, /.*/)).toEqual(before);
  });
  it('plafond de 1 000 lectures par lien et par jour (la 1 001e repond 404), repart le lendemain', async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    await k.db.put({ ...keys.shareDay(hashToken(r.token), '2026-12-01'), n: 999, ttl: 1 });
    await openShare(k.ctx, r.token);
    await fails(openShare(k.ctx, r.token), 404);
    expect(await k.db.get(keys.shareDay(hashToken(r.token), '2026-12-01'))).toMatchObject({ n: 1000 });
    k.t.ms += 86_400_000;
    await openShare(k.ctx, r.token);
  });
  it("la copie lue suit la liste blanche meme si l'element stocke porte un champ en trop", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    const m = (await k.db.get(keys.share(hashToken(r.token))))!;
    await k.db.put({ ...m, questions: (m.questions as object[]).map((q) => ({ ...q, claimId: '01', sid: 'stu1' })), sid: 'stu1' });
    expect(JSON.stringify(await openShare(k.ctx, r.token))).not.toMatch(/claimId|stu1/);
  });
});

describe('shares-report', () => {
  it('3 signalements suspendent le lien (404 ensuite); le parent le voit suspendu; aucun texte libre, aucune adresse', async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    await reportShare(k.ctx, r.token, 'donnees_perso');
    await reportShare(k.ctx, r.token, 'autre');
    await openShare(k.ctx, r.token); // encore ouvert a 2
    await reportShare(k.ctx, r.token, 'inapproprie');
    expect(await k.db.get(keys.share(hashToken(r.token)))).toMatchObject({ state: 'suspendu', reports: 3 });
    await fails(openShare(k.ctx, r.token), 404);
    await fails(reportShare(k.ctx, r.token, 'autre'), 404);
    expect((await listForParent(k.ctx, parent, 'stu1')).shares[0]).toMatchObject({ state: 'suspendu', reports: 3 });
    const reps = await k.db.query(`SHARE#${hashToken(r.token)}`, 'REPORT#');
    expect(reps).toHaveLength(3);
    for (const x of reps) expect(Object.keys(x).sort()).toEqual(['PK', 'SK', 'at', 'reason', 'ttl']);
  });
  it('la suspension garde la copie (visible pour le parent); elle disparait a la revocation', async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    for (let i = 0; i < 3; i++) await reportShare(k.ctx, r.token, 'autre');
    expect(await k.db.get(keys.share(hashToken(r.token)))).toBeDefined();
    await deleteMine(k.ctx, student, r.shareId);
    expect(snapshot(k, /^SHARE#/)).toEqual([]);
  });
  it('motif hors liste ou corps sans motif: refuse par le schema (400)', () => {
    expect(ReportBodySchema.safeParse({ token: 'x', reason: 'spam' }).success).toBe(false);
    expect(ReportBodySchema.safeParse({ token: 'x' }).success).toBe(false);
    expect(ReportBodySchema.safeParse({ token: 'x', reason: 'autre', comment: 'texte libre' }).success).toBe(true); // champ inconnu ignore, jamais enregistre (test ci-dessus)
  });
});
