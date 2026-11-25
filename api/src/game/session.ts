// GET /docs/{docId}/session: les questions d'une fiche, SANS cle ni mot attendu (liste blanche de champs, jamais de spread).
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema } from '../../../shared/items.js';
import type { Deps } from '../lib/deps.js';
import { conflict, notFound, type StudentCtx } from '../lib/http.js';
import { activeStudent } from './access.js';
import { mutate, newSeries } from './state.js';

export interface QuestionView {
  questionId: string;
  kind: 'qcm' | 'gap';
  prompt: string;
  choices?: string[];
}

export async function getSession(deps: Deps, ctx: StudentCtx, docId: string): Promise<{ docId: string; questions: QuestionView[] }> {
  await activeStudent(deps, ctx);
  if (!(await deps.store.get(keys.doc(ctx.studentId, docId)))) throw notFound();
  const items = await deps.store.query(`DOC#${docId}`);
  const bySk = (a: { SK: string }, b: { SK: string }) => a.SK.localeCompare(b.SK);
  const qcms = items.filter((i) => i.SK.startsWith('QCM#')).sort(bySk);
  const gaps = items.filter((i) => i.SK.startsWith('GAP#')).sort(bySk);
  const questions: QuestionView[] = [];
  for (const i of qcms) {
    const r = QcmItemSchema.safeParse(i);
    if (r.success) questions.push({ questionId: r.data.questionId, kind: 'qcm', prompt: r.data.enonce, choices: [...r.data.choix] });
  }
  for (const i of gaps) {
    const r = GapItemSchema.safeParse(i);
    if (r.success) questions.push({ questionId: r.data.questionId, kind: 'gap', prompt: r.data.phrase });
  }
  // Les questions sont « affichees » maintenant: point de depart du temps minimum par reponse et de la serie de 10.
  await mutate(deps, ctx.familyId, ctx.studentId, (st) => {
    st.profile.tick = st.now;
    st.profile.series = newSeries(st.now);
    return { result: null };
  }, () => conflict('Réessaie'), ['profile']);
  return { docId, questions };
}
