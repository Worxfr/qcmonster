// Questions d'une fiche que l'eleve peut partager (S1 #34, design 9). Lit l'eleve, la fiche, ses questions (CLES DE REPONSE) et les lignes ATT#. N'ecrit rien.
// Le texte et la cle d'une question ne sortent QUE si elle est partageable (deja payee, ou fiche pleine) ET sans donnee personnelle.
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema } from '../../../shared/items.js';
import { questionClean, shareableReason, type ShareableReason } from '../../../shared/share-rules.js';
import { DOC_XP_CAP, paidXp } from '../game/rules.js';
import { forbidden, notFound, type StudentCtx } from '../lib/http.js';
import type { Item } from '../pipeline/ports.js';
import { activeStudentOf, familyNames, type ShareCtx } from './ctx.js';

/** Question de la copie: LISTE BLANCHE de champs (jamais `claimId`, `questionId`, `docId`). */
export interface CopyQuestion {
  kind: 'qcm' | 'gap';
  prompt: string;
  choices?: string[];
  answer?: number;
  expected?: string;
}
export interface ShareableRow {
  questionId: string;
  kind: 'qcm' | 'gap';
  shareable: boolean;
  reason?: ShareableReason | 'donnee_personnelle';
  copy?: CopyQuestion;
}
export interface ShareableDoc {
  student: Item;
  doc: Item;
  rows: ShareableRow[];
}

/** Interrupteur: ferme, ni choix ni creation (403). Les routes de liste et de revocation restent ouvertes pour pouvoir toujours revoquer. */
export function requireOpen(c: ShareCtx): void {
  if (!c.publicEnabled) throw forbidden('Partage indisponible');
}

export async function loadShareable(c: ShareCtx, s: StudentCtx, docId: string, student?: Item): Promise<ShareableDoc> {
  const st = student ?? (await activeStudentOf(c, s));
  const doc = await c.db.get(keys.doc(s.studentId, docId));
  if (!doc) throw notFound();
  const [qcms, gaps, att, names] = await Promise.all([c.db.query(`DOC#${docId}`, 'QCM#'), c.db.query(`DOC#${docId}`, 'GAP#'), c.db.query(`STUDENT#${s.studentId}`, `ATT#${docId}:`), familyNames(c, s.familyId)]);
  const rewarded = new Set(att.filter((a) => a.rewarded === true).map((a) => a.SK.slice('ATT#'.length, a.SK.lastIndexOf('#'))));
  const docFull = paidXp(att) >= DOC_XP_CAP;
  const filter = { names };
  const rows: ShareableRow[] = [];
  const add = (kind: 'qcm' | 'gap', questionId: string, retiree: boolean | undefined, copy: CopyQuestion) => {
    const why = shareableReason({ retiree }, rewarded.has(questionId), docFull);
    if (why) return void rows.push({ questionId, kind, shareable: false, reason: why });
    if (!questionClean(copy, filter)) return void rows.push({ questionId, kind, shareable: false, reason: 'donnee_personnelle' });
    rows.push({ questionId, kind, shareable: true, copy });
  };
  for (const i of qcms as Item[]) {
    const r = QcmItemSchema.safeParse(i);
    if (r.success) add('qcm', r.data.questionId, r.data.retiree, { kind: 'qcm', prompt: r.data.enonce, choices: [...r.data.choix], answer: r.data.cle });
  }
  for (const i of gaps as Item[]) {
    const r = GapItemSchema.safeParse(i);
    if (r.success) add('gap', r.data.questionId, r.data.retiree, { kind: 'gap', prompt: r.data.phrase, expected: r.data.attendu });
  }
  return { student: st, doc, rows };
}

/** Reponse de `GET /docs/{docId}/shareable`: `prompt`, choix et reponse seulement pour une question partageable. */
export async function shareable(c: ShareCtx, s: StudentCtx, docId: string) {
  requireOpen(c);
  const { rows } = await loadShareable(c, s, docId);
  return {
    questions: rows.slice(0, 200).map((r) => ({
      questionId: r.questionId,
      kind: r.kind,
      shareable: r.shareable,
      ...(r.copy ? { ...r.copy } : {}),
      ...(r.reason ? { reason: r.reason } : {}),
    })),
  };
}
