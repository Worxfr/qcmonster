// POST /answers. Le client envoie la question et le texte du choix; le serveur juge, accorde l'XP et applique l'anti-triche
// (docs/game-rules.md section 7). La bonne reponse n'est revelee qu'une fois la question « terminee » pour ce jour.
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema, parseQuestionId } from '../../../shared/items.js';
import type { Deps } from '../lib/deps.js';
import { badRequest, conflict, notFound, type StudentCtx } from '../lib/http.js';
import { activeStudent } from './access.js';
import { grantStreakBonus } from './bonus.js';
import { BURST_MAX_CORRECT, BURST_WINDOW_MS, MIN_ANSWER_MS, MIN_SERIES_MS, SERIES_LENGTH, XP, normalizeGap } from './rules.js';
import { awardBadges, credit, mutate, newSeries, progressOf, type Progress } from './state.js';

export interface AnswerResult {
  correct: boolean;
  correctAnswer?: string;
  xpGained: number;
  badges: string[];
  progress: Progress;
}

interface Attempt {
  attempts: number;
  /** Plus de recompense possible aujourd'hui pour cette question: juste, ou essais epuises (QCM: 2, texte a trous: 1). */
  done: boolean;
}

export async function postAnswer(deps: Deps, ctx: StudentCtx, body: { questionId: string; choice: string }): Promise<AnswerResult> {
  let q;
  try {
    q = parseQuestionId(body.questionId);
  } catch {
    throw badRequest();
  }
  const student = await activeStudent(deps, ctx);
  const fiche = await deps.store.get(keys.doc(ctx.studentId, q.docId)); // seulement SES fiches
  if (!fiche) throw notFound();
  const raw = await deps.store.get(q.kind === 'qcm' ? keys.qcm(q.docId, q.nn) : keys.gap(q.docId, q.nn));
  const parsed = q.kind === 'qcm' ? QcmItemSchema.safeParse(raw) : GapItemSchema.safeParse(raw);
  if (!parsed.success) throw notFound();
  const expected = 'cle' in parsed.data ? parsed.data.choix[parsed.data.cle] : parsed.data.attendu;
  const claimId = parsed.data.claimId;
  const correct = q.kind === 'qcm' ? body.choice === expected : normalizeGap(body.choice) === normalizeGap(expected);

  // Une affirmation sans verdict « verifiee » (ou « non_factuelle ») empeche le bonus de serie parfaite (anti-triche 5).
  const claimNo = /^[0-9]{1,3}$/.test(claimId) ? Number(claimId) : NaN;
  const verdict = Number.isNaN(claimNo) ? undefined : await deps.store.get(keys.verdict(q.docId, claimNo));
  const risky = !(verdict && (verdict.statut === 'verifiee' || verdict.statut === 'non_factuelle'));
  const subject = String(fiche.matiere ?? 'autre');

  const { st, result } = await mutate(
    deps,
    ctx.familyId,
    ctx.studentId,
    async (s) => {
      const attKey = keys.attempt(ctx.studentId, body.questionId, s.today);
      const attIt = await deps.store.get(attKey);
      const att: Attempt = { attempts: Number(attIt?.attempts ?? 0), done: attIt?.done === true };
      const p = s.profile;
      const previousTick = p.tick;
      p.tick = s.now;
      // Reponse trop rapide: jugee, mais ni recompense, ni essai compte, ni reponse revelee.
      if (previousTick !== undefined && s.now - previousTick < MIN_ANSWER_MS) return { result: { gained: 0, newBadges: [] as string[], streakBonus: false, reveal: false } };

      const wasDone = att.done;
      att.attempts += 1;
      let amount = 0;
      if (!wasDone) {
        if (correct) {
          amount += q.kind === 'gap' ? XP.gap : att.attempts === 1 ? XP.qcmFirst : XP.qcmSecond;
          att.done = true;
        } else if (q.kind === 'gap' || att.attempts >= 2) att.done = true;
      }
      if (att.attempts === 1) {
        // Serie de 10 questions: seule la premiere tentative du jour d'une question compte (rejouer ne fabrique pas de series).
        p.series.startedAt ??= previousTick ?? s.now;
        p.series.n += 1;
        p.series.perfect &&= correct;
        p.series.risky ||= risky;
        if (p.series.n >= SERIES_LENGTH) {
          if (s.now - p.series.startedAt >= MIN_SERIES_MS) {
            amount += XP.seriesDone;
            if (p.series.perfect && !p.series.risky) {
              amount += XP.seriesPerfect;
              p.perfectSeries += 1;
            }
          }
          p.series = newSeries(s.now);
        }
      }
      if (correct && !wasDone) {
        p.correct += 1;
        p.recent = [...p.recent.filter((t) => s.now - t <= BURST_WINDOW_MS), s.now];
        if (p.recent.length > BURST_MAX_CORRECT) {
          p.quarantineDay = s.today; // plus de 100 bonnes reponses en 10 min: gains en quarantaine pour la journee
          p.recent = [];
        }
      }
      const c = credit(s, amount, subject);
      const newBadges = awardBadges(s);
      return {
        extra: [{ item: { ...attKey, attempts: att.attempts, done: att.done }, when: attIt ? (attIt.v ?? 'any') : 'absent' }],
        result: { gained: c.gained, newBadges, streakBonus: c.streakBonus, reveal: att.done },
      };
    },
    () => conflict('Reessayez'),
  );
  if (result.streakBonus) await grantStreakBonus(deps, ctx.familyId, ctx.studentId, st.month);
  return {
    correct,
    ...(result.reveal ? { correctAnswer: expected } : {}),
    xpGained: result.gained,
    badges: result.newBadges,
    progress: await progressOf(deps, ctx.familyId, ctx.studentId, st.profile, Number(student.quotaPages), st.today),
  };
}
