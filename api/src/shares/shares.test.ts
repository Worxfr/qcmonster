// Handlers du partage (S1 #34): creation, liste, revocation. Base en memoire; aucun appel reel. Voir aussi public.test.ts (ouverture, signalement).
import { describe, expect, it } from 'vitest';
import { keys } from '../../../shared/ddb/keys.js';
import { ShareItemSchema } from '../../../shared/items.js';
import { HttpError } from '../lib/http.js';
import { treeDbFrom, type Db } from '../pipeline/ports.js';
import { createShare } from './create.js';
import { hashToken } from './ctx.js';
import { deleteForParent, deleteMine, listForParent, listMine } from './manage.js';
import { openShare, reportShare } from './public.js';
import { shareable } from './shareable.js';
import { body, create, DOC, fails, make, otherFamilyParent, otherStudent, parent, snapshot, strangerStudent, student, untouchable, type Kit } from './testkit.js';

const SHARE_ONLY = /^SHARE#|SHAREREF|SHARESLOT|SHAREJ/;
const LINKS = /^SHARE#|SHAREREF|SHARESLOT/; // sans le compteur de creations du jour, qui ne se decremente pas
const five = (ids: string[]) => ids.slice(0, 5);

describe('shares-shareable', () => {
  it('seules les questions payees portent texte et cle; les autres disent a_jouer sans rien reveler', async () => {
    const { k, ids } = await make({ paid: 6 });
    const r = await shareable(k.ctx, student, DOC);
    expect(r.questions).toHaveLength(ids.length);
    const ok = r.questions.filter((q) => q.shareable);
    expect(ok).toHaveLength(6);
    expect(ok.every((q) => 'prompt' in q && (q.kind === 'gap' ? 'expected' in q : 'answer' in q))).toBe(true);
    const no = r.questions.filter((q) => !q.shareable);
    expect(no.every((q) => q.reason === 'a_jouer' && !('prompt' in q) && !('answer' in q) && !('expected' in q) && !('choices' in q))).toBe(true);
  });
  it("fiche pleine (50 points): tout est partageable; une question retiree ne l'est jamais", async () => {
    const { k } = await make({ paid: 0, docXp: 50 });
    await k.db.update(keys.qcm(DOC, 1), { set: { retiree: true } });
    const r = await shareable(k.ctx, student, DOC);
    expect(r.questions.find((q) => q.questionId === `${DOC}:qcm:01`)).toMatchObject({ shareable: false, reason: 'retiree' });
    expect(r.questions.filter((q) => q.shareable)).toHaveLength(r.questions.length - 1);
  });
  it('une question avec une donnee personnelle est ecartee (donnee_personnelle) sans son texte', async () => {
    const { k } = await make({ paid: 8 });
    await k.db.update(keys.qcm(DOC, 2), { set: { enonce: 'Ecris a lila@exemple.org' } });
    const q = (await shareable(k.ctx, student, DOC)).questions.find((x) => x.questionId === `${DOC}:qcm:02`)!;
    expect(q).toMatchObject({ shareable: false, reason: 'donnee_personnelle' });
    expect(JSON.stringify(q)).not.toContain('lila@');
  });
  it("fiche d'un autre eleve ou inconnue: 404; interrupteur ferme ou eleve suspendu: 403", async () => {
    const { k } = await make();
    await fails(shareable(k.ctx, strangerStudent, DOC), 404);
    await fails(shareable(k.ctx, student, 'inconnue'), 404);
    await fails(shareable(k.with({ publicEnabled: false }), student, DOC), 403);
    await k.db.update(keys.student('fam1', 'stu1'), { set: { statut: 'suspendu' } });
    await fails(shareable(k.ctx, student, DOC), 403);
  });
});

describe('shares-create', () => {
  it("cree la copie, la reference, l'emplacement famille et le compteur; le jeton n'est stocke nulle part", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    expect(r.token).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(r.expiresAt).toBe('2026-12-08T10:00:00.000Z');
    const hash = hashToken(r.token);
    const meta = await k.db.get(keys.share(hash));
    expect(ShareItemSchema.safeParse(meta).success).toBe(true);
    expect(meta).toMatchObject({ shareId: r.shareId, title: 'La cellule', subject: 'svt', state: 'actif', reports: 0, docRev: 0 });
    expect(await k.db.get(keys.shareRef('stu1', 1))).toMatchObject({ hash, docId: DOC, count: 5, famSlot: 1, shareId: r.shareId });
    expect(await k.db.get(keys.shareSlot('fam1', 1))).toMatchObject({ sid: 'stu1' });
    expect(await k.db.get(keys.shareCreateDay('stu1', '2026-12-01'))).toMatchObject({ n: 1 });
    expect(JSON.stringify([...k.db.items.values()])).not.toContain(r.token);
  });
  it("LISTE BLANCHE: la copie n'a que les champs prevus, sans lien vers l'eleve, la famille, le cours, la fiche ni les questions", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, paidIds.slice(0, 6));
    const meta = (await k.db.get(keys.share(hashToken(r.token))))!;
    expect(Object.keys(meta).sort()).toEqual(['PK', 'SK', 'createdAt', 'docRev', 'expiresAt', 'questions', 'reports', 'shareId', 'state', 'subject', 'title', 'ttl']);
    for (const q of meta.questions as Record<string, unknown>[]) expect(Object.keys(q).sort()).toEqual(q.kind === 'qcm' ? ['answer', 'choices', 'kind', 'prompt'] : ['expected', 'kind', 'prompt']);
    const raw = JSON.stringify(meta);
    for (const forbidden of ['stu1', 'fam1', 'doc1', 'claimId', 'questionId', 'Lila', 'lila']) expect(raw, forbidden).not.toContain(forbidden);
  });
  it("un champ inattendu de la question source n'entre pas dans la copie", async () => {
    const { k, paidIds } = await make();
    await k.db.update(keys.qcm(DOC, 1), { set: { photoKey: 'scans/stu1/p1', figureId: 'fig1', secret: 'S3CR3T' } });
    const r = await create(k, five(paidIds));
    expect(JSON.stringify(await k.db.get(keys.share(hashToken(r.token))))).not.toMatch(/scans\/|fig1|S3CR3T/);
  });
  it('duree: 1, 7 (defaut) ou 30 jours; ttl = echeance + 2 jours', async () => {
    const { k, paidIds } = await make();
    const r30 = await create(k, five(paidIds), { ttlDays: 30 });
    expect(r30.expiresAt).toBe('2026-12-31T10:00:00.000Z');
    const meta = (await k.db.get(keys.share(hashToken(r30.token))))!;
    expect(meta.ttl).toBe(Math.floor(Date.parse('2026-12-31T10:00:00Z') / 1000) + 2 * 86_400);
    const rDef = await createShare(k.ctx, student, { docId: DOC, questionIds: five(paidIds), title: 'Autre titre' });
    expect(rDef.expiresAt).toBe('2026-12-08T10:00:00.000Z');
  });
  it("refus: partage coupe (403), interrupteur ferme (403 sans toucher la base), eleve suspendu (403); rien n'est ecrit", async () => {
    const { k, paidIds } = await make({ sharing: false });
    const before = snapshot(k, /.*/);
    await fails(create(k, five(paidIds)), 403);
    await fails(createShare({ ...k.ctx, db: untouchable(), publicEnabled: false }, student, body(five(paidIds)) as never), 403);
    expect(snapshot(k, /.*/)).toEqual(before);
    await k.db.update(keys.student('fam1', 'stu1'), { set: { sharing: true, statut: 'suspendu' } });
    await fails(create(k, five(paidIds)), 403);
  });
  it("titre refuse (donnee personnelle, pseudo du frere, forme): 400 titre_refuse, rien d'ecrit", async () => {
    const { k, paidIds } = await make();
    const before = snapshot(k, /.*/);
    for (const title of ['Appelle 06 12 34 56 78', 'Le QCM de Maxence', 'a@b.fr', 'ab']) await fails(create(k, five(paidIds), { title }), 400, 'titre_refuse');
    expect(snapshot(k, /.*/)).toEqual(before);
  });
  it("questions non partageables (a jouer, inconnue, retiree, donnee personnelle): 409 et rien d'ecrit", async () => {
    const { k, ids, paidIds } = await make({ paid: 8 });
    await fails(create(k, [...paidIds.slice(0, 4), ids[9]]), 409, 'questions_non_partageables');
    await fails(create(k, [...paidIds.slice(0, 4), 'doc1:qcm:77']), 409, 'questions_non_partageables');
    await k.db.update(keys.qcm(DOC, 1), { set: { retiree: true } });
    await fails(create(k, five(paidIds)), 409);
    await k.db.update(keys.qcm(DOC, 2), { set: { enonce: 'mail: x@y.fr' } });
    await fails(create(k, paidIds.slice(1, 6)), 409);
    expect(snapshot(k, SHARE_ONLY)).toEqual([]);
  });
  it("la fiche d'un autre eleve ou d'une autre famille est un 404", async () => {
    const { k, paidIds } = await make();
    await fails(createShare(k.ctx, otherStudent, body(five(paidIds)) as never), 404);
    await fails(createShare(k.ctx, strangerStudent, body(five(paidIds)) as never), 404);
    expect(snapshot(k, SHARE_ONLY)).toEqual([]);
  });

  describe('plafonds', () => {
    it('5 liens actifs par eleve: le sixieme est refuse (429); un lien echu libere son emplacement', async () => {
      const { k, paidIds } = await make();
      for (let i = 0; i < 5; i++) await create(k, five(paidIds), { title: `Titre ${'abcde'[i]}x` });
      await fails(create(k, five(paidIds)), 429, 'plafond_partages');
      expect((await k.db.query('STUDENT#stu1', 'SHAREREF#')).map((r) => r.SK).sort()).toEqual(['SHAREREF#1', 'SHAREREF#2', 'SHAREREF#3', 'SHAREREF#4', 'SHAREREF#5']);
      await k.db.update(keys.shareRef('stu1', 3), { set: { expiresAt: '2026-12-01T09:00:00.000Z' } });
      await k.db.update(keys.shareSlot('fam1', 3), { set: { expiresAt: '2026-12-01T09:00:00.000Z' } });
      const r = await create(k, five(paidIds));
      expect(await k.db.get(keys.shareRef('stu1', 3))).toMatchObject({ shareId: r.shareId });
    });
    it('10 liens actifs par famille', async () => {
      const { k, paidIds } = await make();
      for (let j = 1; j <= 9; j++) await k.db.put({ ...keys.shareSlot('fam1', j), sid: 'stu2', expiresAt: '2027-01-01T00:00:00.000Z', ttl: 1 });
      await create(k, five(paidIds));
      await fails(create(k, five(paidIds)), 429, 'plafond_partages');
      expect((await k.db.query('FAMILY#fam1', 'SHARESLOT#')).length).toBe(10);
    });
    it('10 creations par jour et par eleve, meme si les liens sont revoques', async () => {
      const { k, paidIds } = await make();
      for (let i = 0; i < 10; i++) await deleteMine(k.ctx, student, (await create(k, five(paidIds))).shareId);
      await fails(create(k, five(paidIds)), 429, 'plafond_partages');
      k.t.ms += 86_400_000;
      await create(k, five(paidIds));
    });
    it("creations simultanees: jamais plus de 5 liens pour un eleve (et pas d'orphelin)", async () => {
      const { k, paidIds } = await make();
      const rs = await Promise.allSettled(Array.from({ length: 9 }, (_, i) => create(k, five(paidIds), { title: `Titre ${i}x` })));
      const ok = rs.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBeGreaterThanOrEqual(3);
      expect(ok).toBeLessThanOrEqual(5);
      expect((await k.db.query('STUDENT#stu1', 'SHAREREF#')).length).toBe(ok);
      expect([...k.db.items.keys()].filter((id) => id.startsWith('SHARE#') && id.endsWith('|META')).length).toBe(ok);
      for (const r of rs) if (r.status === 'rejected') expect([409, 429]).toContain((r.reason as HttpError).status);
    });
    it('creations simultanees: jamais plus de 10 par famille', async () => {
      const { k, paidIds } = await make();
      for (let j = 1; j <= 8; j++) await k.db.put({ ...keys.shareSlot('fam1', j), sid: 'stu2', expiresAt: '2027-01-01T00:00:00.000Z', ttl: 1 });
      const rs = await Promise.allSettled(Array.from({ length: 6 }, (_, i) => create(k, five(paidIds), { title: `Titre ${i}y` })));
      const ok = rs.filter((r) => r.status === 'fulfilled').length;
      expect(ok).toBeLessThanOrEqual(2);
      expect((await k.db.query('FAMILY#fam1', 'SHARESLOT#')).length).toBe(8 + ok);
    });
  });

  describe("course avec une suppression ou un changement (la verification est DANS la transaction)", () => {
    /** Base qui, juste avant la premiere transaction, applique `change` (le parent ou l'eleve agit entre la lecture et l'ecriture). */
    const racing = (k: Kit, change: () => Promise<unknown>): Db => {
      let done = false;
      return new Proxy(k.db, {
        get: (t, p) =>
          p === 'transact'
            ? async (ops: never) => {
                if (!done) {
                  done = true;
                  await change();
                }
                return t.transact(ops);
              }
            : (t as never)[p],
      });
    };
    it('le parent coupe le partage pendant la creation: refus 403 et aucune copie orpheline', async () => {
      const { k, paidIds } = await make();
      const c = { ...k.ctx, db: racing(k, () => k.db.update(keys.student('fam1', 'stu1'), { set: { sharing: false } })) };
      await fails(createShare(c, student, body(five(paidIds)) as never), 403);
      expect(snapshot(k, SHARE_ONLY)).toEqual([]);
    });
    it('la fiche est supprimee pendant la creation: 404 et aucune copie', async () => {
      const { k, paidIds } = await make();
      const c = { ...k.ctx, db: racing(k, () => k.db.remove([keys.doc('stu1', DOC)])) };
      await fails(createShare(c, student, body(five(paidIds)) as never), 404);
      expect(snapshot(k, SHARE_ONLY)).toEqual([]);
    });
    it("l'eleve est supprime ou suspendu pendant la creation: refus et aucune copie", async () => {
      for (const change of [(k: Kit) => k.db.remove([keys.student('fam1', 'stu1')]), (k: Kit) => k.db.update(keys.student('fam1', 'stu1'), { set: { statut: 'suspendu' } })]) {
        const { k, paidIds } = await make();
        const c = { ...k.ctx, db: racing(k, () => change(k)) };
        await fails(createShare(c, student, body(five(paidIds)) as never), 403);
        expect(snapshot(k, SHARE_ONLY)).toEqual([]);
      }
    });
    it("un emplacement pris entre la lecture et l'ecriture: la creation reessaie avec un autre", async () => {
      const { k, paidIds } = await make();
      const taken = { ...keys.shareRef('stu1', 1), shareId: 'x', hash: 'f'.repeat(64), docId: DOC, title: 'xxx', count: 5, createdAt: 'x', expiresAt: '2027-01-01T00:00:00.000Z', famSlot: 9, ttl: 1 };
      const c = { ...k.ctx, db: racing(k, () => k.db.put(taken)) };
      await createShare(c, student, body(five(paidIds)) as never);
      expect(await k.db.get(keys.shareRef('stu1', 2))).toBeDefined();
    });
  });
});

describe('suppression de l\'eleve en cours (relecture #111 m2)', () => {
  it("apres closeSharing (port treeDbFrom), une creation est refusee (403) et n'ecrit rien", async () => {
    const { k, paidIds } = await make();
    await treeDbFrom(k.db).closeSharing!(keys.student('fam1', 'stu1'));
    expect(await k.db.get(keys.student('fam1', 'stu1'))).toMatchObject({ sharing: false });
    await fails(create(k, five(paidIds)), 403);
    expect(snapshot(k, SHARE_ONLY)).toEqual([]);
  });
  it('closeSharing de treeDbFrom ne cree pas un eleve absent', async () => {
    const { k } = await make();
    await treeDbFrom(k.db).closeSharing!(keys.student('fam1', 'inconnu'));
    expect(await k.db.get(keys.student('fam1', 'inconnu'))).toBeUndefined();
  });
});

describe('shares-list et shares-parent-list', () => {
  it("l'eleve voit titre, dates, lectures, signalements, etat et outdated; jamais le lien ni les questions", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    await openShare(k.ctx, r.token);
    await openShare(k.ctx, r.token);
    await reportShare(k.ctx, r.token, 'autre');
    const l = await listMine(k.ctx, student);
    expect(l.shares).toEqual([{ shareId: r.shareId, title: 'La cellule', count: 5, createdAt: '2026-12-01T10:00:00.000Z', expiresAt: '2026-12-08T10:00:00.000Z', state: 'actif', reads: 2, reports: 1, outdated: false }]);
    expect(JSON.stringify(l)).not.toContain(r.token);
    await k.db.update(keys.doc('stu1', DOC), { set: { rev: 1 } });
    expect((await listMine(k.ctx, student)).shares[0].outdated).toBe(true);
  });
  it("un frere ne voit pas les liens de l'autre; un lien echu n'est plus montre", async () => {
    const { k, paidIds } = await make();
    await create(k, five(paidIds));
    expect((await listMine(k.ctx, otherStudent)).shares).toEqual([]);
    k.t.ms += 8 * 86_400_000;
    expect((await listMine(k.ctx, student)).shares).toEqual([]);
  });
  it('le parent voit la liste sans question; purgePending si le partage est coupe et des liens restent; autre famille: 404', async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    const l = await listForParent(k.ctx, parent, 'stu1');
    expect(l).toMatchObject({ purgePending: false });
    expect(Object.keys(l.shares[0]).sort()).toEqual(['count', 'createdAt', 'expiresAt', 'reads', 'reports', 'shareId', 'state', 'title']);
    expect(JSON.stringify(l)).not.toMatch(/Question|choices|answer|expected/);
    expect(JSON.stringify(l)).not.toContain(r.token);
    await k.db.update(keys.student('fam1', 'stu1'), { set: { sharing: false } });
    expect(await listForParent(k.ctx, parent, 'stu1')).toMatchObject({ purgePending: true });
    await fails(listForParent(k.ctx, otherFamilyParent, 'stu1'), 404);
    await deleteForParent(k.ctx, parent, 'stu1');
    expect(await listForParent(k.ctx, parent, 'stu1')).toEqual({ shares: [], purgePending: false });
  });
});

describe('revocation', () => {
  it("l'eleve revoque: copie, reference et emplacement disparaissent; le lien repond 404 tout de suite", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    await openShare(k.ctx, r.token);
    await deleteMine(k.ctx, student, r.shareId);
    expect(snapshot(k, LINKS)).toEqual([]);
    await fails(openShare(k.ctx, r.token), 404, 'lien_indisponible');
  });
  it("le lien d'un autre eleve ou d'une autre famille: 404 indiscernable d'un lien inconnu; rien n'est supprime", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    const before = snapshot(k, /.*/);
    const a = await fails(deleteMine(k.ctx, otherStudent, r.shareId), 404);
    const b = await fails(deleteMine(k.ctx, strangerStudent, r.shareId), 404);
    const c = await fails(deleteMine(k.ctx, student, 'inconnu'), 404);
    expect([a.code, b.code].every((x) => x === c.code)).toBe(true);
    await fails(deleteForParent(k.ctx, otherFamilyParent, 'stu1', r.shareId), 404);
    await fails(deleteForParent(k.ctx, otherFamilyParent, 'stu1'), 404);
    await fails(deleteForParent(k.ctx, parent, 'stu2', r.shareId), 404);
    expect(snapshot(k, /.*/)).toEqual(before);
  });
  it("un emplacement famille reutilise par un frere n'est pas libere par la revocation d'un ancien lien", async () => {
    const { k, paidIds } = await make();
    const r = await create(k, five(paidIds));
    await k.db.put({ ...keys.shareSlot('fam1', 1), sid: 'stu2', expiresAt: '2027-01-01T00:00:00.000Z', ttl: 1 });
    await deleteMine(k.ctx, student, r.shareId);
    expect(await k.db.get(keys.shareSlot('fam1', 1))).toMatchObject({ sid: 'stu2' });
  });
  it('le parent revoque un lien puis tous; la purge est idempotente et rejouable apres un echec au milieu', async () => {
    const { k, paidIds } = await make();
    const a = await create(k, five(paidIds));
    await create(k, five(paidIds), { title: 'Titre deux' });
    await create(k, five(paidIds), { title: 'Titre trois' });
    await deleteForParent(k.ctx, parent, 'stu1', a.shareId);
    expect((await listForParent(k.ctx, parent, 'stu1')).shares).toHaveLength(2);
    let boom = true;
    const flaky = new Proxy(k.db, {
      get: (t, p) =>
        p === 'remove'
          ? async (ks: { PK: string; SK: string }[]) => {
              if (boom && ks.some((x) => x.PK.startsWith('STUDENT#'))) {
                boom = false;
                throw new Error('panne');
              }
              return t.remove(ks);
            }
          : (t as never)[p],
    });
    await expect(deleteForParent({ ...k.ctx, db: flaky }, parent, 'stu1')).rejects.toThrow('panne');
    await deleteForParent(k.ctx, parent, 'stu1');
    await deleteForParent(k.ctx, parent, 'stu1');
    expect(snapshot(k, LINKS)).toEqual([]);
  });
});
