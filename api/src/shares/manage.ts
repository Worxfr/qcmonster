// Liste, revocation et purge des liens (S1 #34, design 3, 4 et 8). Role `shareManage`: JAMAIS la fiche ni ses questions (`DOC#`), jamais une cle de reponse.
// Revoquer = supprimer: la copie publique D'ABORD, puis la reference de l'eleve et l'emplacement famille (une reference sans copie se supprime au rejeu).
import { keys } from '../../../shared/ddb/keys.js';
import { deleteSharesOf } from '../../../shared/delete-tree.js';
import { notFound, type ParentCtx, type StudentCtx } from '../lib/http.js';
import { treeDbFrom, type Item } from '../pipeline/ports.js';
import { activeStudentOf, isExpired, refsOf, studentOfFamily, type ShareCtx } from './ctx.js';

/** Lectures = somme des compteurs `DAY#` (au plus 31); signalements et etat viennent de `META`. */
async function summary(c: ShareCtx, ref: Item) {
  const els = await c.db.query(`SHARE#${String(ref.hash)}`);
  const meta = els.find((e) => e.SK === 'META');
  const reads = els.filter((e) => e.SK.startsWith('DAY#')).reduce((n, e) => n + Number(e.n ?? 0), 0);
  return {
    meta,
    view: {
      shareId: String(ref.shareId),
      title: String(ref.title),
      count: Number(ref.count),
      createdAt: String(ref.createdAt),
      expiresAt: String(ref.expiresAt),
      state: meta?.state === 'suspendu' ? ('suspendu' as const) : ('actif' as const),
      reads,
      reports: Number(meta?.reports ?? 0),
    },
  };
}

/** `GET /me/shares`. `outdated`: la fiche a une `rev` differente de celle de la copie (la copie reste figee). Liens echus: non montres. */
export async function listMine(c: ShareCtx, s: StudentCtx) {
  await activeStudentOf(c, s);
  const out = [];
  for (const ref of (await refsOf(c, s.studentId)).filter((r) => !isExpired(r, c))) {
    const { meta, view } = await summary(c, ref);
    const doc = typeof ref.docId === 'string' ? await c.db.get(keys.doc(s.studentId, ref.docId)) : undefined;
    out.push({ ...view, outdated: !!doc && !!meta && Number(doc.rev ?? 0) !== Number(meta.docRev ?? 0) });
  }
  return { shares: out };
}

/** `GET /students/{sid}/shares` (parent): jamais de question ni de lien. `purgePending`: partage coupe et des references restent. */
export async function listForParent(c: ShareCtx, p: ParentCtx, sid: string) {
  const st = await studentOfFamily(c, p.familyId, sid);
  const refs = await refsOf(c, sid);
  const shares = [];
  for (const ref of refs.filter((r) => !isExpired(r, c))) shares.push((await summary(c, ref)).view);
  return { shares, purgePending: st.sharing !== true && refs.length > 0 };
}

/** Un lien: copie, puis reference, puis emplacement famille (seulement s'il est encore a cet eleve). */
async function revoke(c: ShareCtx, fid: string, sid: string, ref: Item): Promise<void> {
  const hash = String(ref.hash);
  if (/^[0-9a-f]{64}$/.test(hash)) {
    const els = await c.db.query(`SHARE#${hash}`);
    if (els.length) await c.db.remove(els.map(({ PK, SK }) => ({ PK, SK })));
  }
  const slotKey = typeof ref.famSlot === 'number' ? keys.shareSlot(fid, ref.famSlot) : undefined;
  const slot = slotKey ? await c.db.get(slotKey) : undefined;
  await c.db.remove([{ PK: ref.PK, SK: ref.SK }, ...(slotKey && slot?.sid === sid ? [slotKey] : [])]);
}

/** `DELETE /me/shares/{shareId}`: un lien d'un autre eleve est indiscernable d'un lien inconnu (404). */
export async function deleteMine(c: ShareCtx, s: StudentCtx, shareId: string): Promise<void> {
  await activeStudentOf(c, s);
  const ref = (await refsOf(c, s.studentId)).find((r) => r.shareId === shareId);
  if (!ref) throw notFound();
  await revoke(c, s.familyId, s.studentId, ref);
}

/** `DELETE /students/{sid}/shares[/{shareId}]` (parent). Sans `shareId`: tout, idempotent et rejouable (`deleteSharesOf`). Avec: un lien, 404 s'il n'est pas a cet eleve. */
export async function deleteForParent(c: ShareCtx, p: ParentCtx, sid: string, shareId?: string): Promise<void> {
  await studentOfFamily(c, p.familyId, sid);
  if (shareId === undefined) {
    await deleteSharesOf(treeDbFrom(c.db), p.familyId, sid);
    return;
  }
  const ref = (await refsOf(c, sid)).find((r) => r.shareId === shareId);
  if (!ref) throw notFound();
  await revoke(c, p.familyId, sid, ref);
}
