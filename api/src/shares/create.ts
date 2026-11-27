// Creation d'un lien de partage (S1 #34, design 4, 6 et 9). UNE transaction de six elements: copie publique, reference de l'eleve (emplacement 1 a 5), emplacement famille (1 a 10),
// compteur du jour, et deux verifications (l'eleve est toujours actif ET le partage toujours ouvert; la fiche existe toujours). Un echec ne laisse ni copie ni compteur.
import { keys } from '../../../shared/ddb/keys.js';
import { SUBJECTS } from '../../../shared/scans.js';
import {
  SHARE_CREATES_PER_DAY,
  SHARE_DEFAULT_TTL_DAYS,
  SHARE_PER_FAMILY,
  SHARE_PER_STUDENT,
  SHARE_TTL_GRACE_S,
  checkTitle,
} from '../../../shared/share-rules.js';
import { conflict, forbidden, notFound, type StudentCtx } from '../lib/http.js';
import type { Item, TxOp } from '../pipeline/ports.js';
import { activeStudentOf, familyNames, hashToken, isExpired, iso, nonPartageables, plafondPartages, titreRefuse, epochS, dayOf, refsOf, type ShareCtx } from './ctx.js';
import { loadShareable, requireOpen, type CopyQuestion } from './shareable.js';

export interface CreateBody {
  docId: string;
  questionIds: string[];
  title: string;
  ttlDays?: number;
}

/** Premier emplacement de 1 a `max` libre: absent, ou echu (`expiresAt` atteint). */
const freeSlot = (rows: Item[], prefix: string, max: number, c: ShareCtx): number | undefined => {
  for (let k = 1; k <= max; k++) {
    const row = rows.find((r) => r.SK === `${prefix}${k}`);
    if (!row || isExpired(row, c)) return k;
  }
  return undefined;
};

/** Copie figee: champs ECRITS UN PAR UN (liste blanche). Aucun `sid`, `fid`, `docId`, `questionId`, `claimId` n'y entre jamais. */
const copyOf = (q: CopyQuestion): CopyQuestion =>
  q.kind === 'qcm' ? { kind: 'qcm', prompt: q.prompt, choices: [...(q.choices ?? [])], answer: q.answer as number } : { kind: 'gap', prompt: q.prompt, expected: q.expected as string };

export async function createShare(c: ShareCtx, s: StudentCtx, body: CreateBody): Promise<{ shareId: string; token: string; expiresAt: string }> {
  requireOpen(c);
  let student = await activeStudentOf(c, s);
  if (student.sharing !== true) throw forbidden('Partage désactivé par le parent');
  const title = checkTitle(body.title, { names: await familyNames(c, s.familyId) });
  if (!title.ok) throw titreRefuse();
  const ttlDays = body.ttlDays ?? SHARE_DEFAULT_TTL_DAYS;

  for (let attempt = 0; attempt < 4; attempt++) {
    // Relecture complete a chaque essai: un echec de la transaction peut venir d'une course (autre creation, partage coupe, fiche ou eleve supprime).
    if (attempt > 0) {
      student = await activeStudentOf(c, s);
      if (student.sharing !== true) throw forbidden('Partage désactivé par le parent');
    }
    const { doc, rows } = await loadShareable(c, s, body.docId, student);
    const byId = new Map(rows.map((r) => [r.questionId, r]));
    const picked = body.questionIds.map((id) => byId.get(id));
    if (picked.some((r) => !r?.shareable || !r.copy)) throw nonPartageables();

    const [refs, slots, day] = await Promise.all([refsOf(c, s.studentId), c.db.query(`FAMILY#${s.familyId}`, 'SHARESLOT#'), c.db.get(keys.shareCreateDay(s.studentId, dayOf(c)))]);
    const k = freeSlot(refs, 'SHAREREF#', SHARE_PER_STUDENT, c);
    const j = freeSlot(slots, 'SHARESLOT#', SHARE_PER_FAMILY, c);
    if (k === undefined || j === undefined || Number(day?.n ?? 0) >= SHARE_CREATES_PER_DAY) throw plafondPartages();

    const token = c.newToken();
    const hash = hashToken(token);
    const shareId = c.newId();
    const now = iso(c);
    const expiresAt = new Date(c.now().getTime() + ttlDays * 86_400_000).toISOString();
    const ttl = Math.floor(new Date(expiresAt).getTime() / 1000) + SHARE_TTL_GRACE_S;
    const subject = typeof doc.matiere === 'string' && (SUBJECTS as readonly string[]).includes(doc.matiere) ? doc.matiere : undefined;
    const ops: TxOp[] = [
      { put: { ...keys.share(hash), shareId, title: title.value, ...(subject ? { subject } : {}), questions: picked.map((r) => copyOf(r!.copy!)), createdAt: now, expiresAt, state: 'actif', reports: 0, docRev: Number(doc.rev ?? 0), ttl }, ifNotExists: true },
      { put: { ...keys.shareRef(s.studentId, k), shareId, hash, docId: body.docId, title: title.value, count: picked.length, createdAt: now, expiresAt, famSlot: j, ttl }, ifFreeAt: now },
      { put: { ...keys.shareSlot(s.familyId, j), sid: s.studentId, expiresAt, ttl }, ifFreeAt: now },
      { key: keys.shareCreateDay(s.studentId, dayOf(c)), spec: { add: { n: 1 }, set: { ttl: epochS(c) + SHARE_TTL_GRACE_S }, cond: { lt: { n: SHARE_CREATES_PER_DAY } } } },
      { check: keys.student(s.familyId, s.studentId), cond: { exists: true, eq: { sharing: true, statut: 'actif' } } },
      { check: keys.doc(s.studentId, body.docId), cond: { exists: true } },
    ];
    if (await c.db.transact(ops)) return { shareId, token, expiresAt };
  }
  // Course persistante: on distingue une suppression d'une simple concurrence.
  if (!(await c.db.get(keys.doc(s.studentId, body.docId)))) throw notFound();
  throw conflict('Réessaie');
}
