// POST /answers. Le client envoie la question et le texte du choix; le serveur juge, accorde l'XP et applique l'anti-triche
// (docs/game-rules.md section 7). La bonne reponse n'est revelee qu'une fois la question « terminee » pour ce jour.
import { keys } from '../../../shared/ddb/keys.js';
import { GapItemSchema, QcmItemSchema, parseQuestionId } from '../../../shared/items.js';
import type { Deps } from '../lib/deps.js';
import { HttpError, badRequest, conflict, notFound, type StudentCtx } from '../lib/http.js';
import { activeStudent } from './access.js';
import { grantStreakBonus } from './bonus.js';
import { BURST_MAX_CORRECT, BURST_WINDOW_MS, MIN_ANSWER_MS, MIN_SERIES_MS, SERIES_LENGTH, XP, normalizeGap } from './rules.js';
import { awardBadges, credit, mutate, newSeries, progressOf, type Progress } from './state.js';
import { parisDate } from './time.js';

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
  /** Cette tentative a fait gagner la recompense unique de la question (une fois pour toutes, quelle que soit la fiche). */
  rewarded: boolean;
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
      const att: Attempt = { attempts: Number(attIt?.attempts ?? 0), done: attIt?.done === true, rewarded: attIt?.rewarded === true };
      const p = s.profile;
      const previousTick = p.tick;
      // Reponse trop rapide: rien du tout, pas meme la justesse (sinon 0,5 s par proposition suffirait a trouver la bonne reponse).
      // Le temps de reference n'est pas remis a zero: une rafale reste refusee jusqu'a 1 s apres la derniere reponse acceptee.
      if (previousTick !== undefined && s.now - previousTick < MIN_ANSWER_MS) throw new HttpError(429, 'etat_invalide', 'Trop rapide, reessayez dans une seconde');
      p.tick = s.now;

      // Une recompense par question POUR TOUJOURS (game-rules 1 et 7.2): une tentative payee un autre jour ferme la question.
      const before = await deps.store.query(`STUDENT#${ctx.studentId}`, `ATT#${body.questionId}#`);
      const paidBefore = before.some((i) => i.SK !== attKey.SK && i.rewarded === true);

      const wasDone = att.done;
      att.attempts += 1;
      let amount = 0;
      if (!wasDone) {
        if (correct) {
          att.done = true;
          if (!paidBefore) {
            att.rewarded = true;
            amount += q.kind === 'gap' ? XP.gap : att.attempts === 1 ? XP.qcmFirst : XP.qcmSecond;
          }
        } else if (q.kind === 'gap' || att.attempts >= 2) att.done = true;
      }
      // Serie de 10: elle se mesure depuis l'ouverture de la session du jour (`startedAt`). Sans session ouverte aujourd'hui, la reponse
      // ne compte pas pour la serie. Seule la premiere tentative du jour d'une question jamais payee compte (rejouer ne fabrique rien).
      const sessionToday = p.series.startedAt !== undefined && parisDate(new Date(p.series.startedAt)) === s.today;
      if (att.attempts === 1 && !paidBefore && sessionToday) {
        p.series.n += 1;
        p.series.perfect &&= correct;
        p.series.risky ||= risky;
        if (p.series.n >= SERIES_LENGTH) {
          if (s.now - (p.series.startedAt as number) >= MIN_SERIES_MS) {
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
        if (att.rewarded) p.correct += 1; // « bonnes reponses »: premieres reussites seulement
        p.recent = [...p.recent.filter((t) => s.now - t <= BURST_WINDOW_MS), s.now];
        if (p.recent.length > BURST_MAX_CORRECT) {
          p.quarantineDay = s.today; // plus de 100 bonnes reponses en 10 min: gains en quarantaine pour la journee
          p.recent = [];
        }
      }
      const c = credit(s, amount, subject);
      const newBadges = awardBadges(s);
      return {
        extra: [{ item: { ...attKey, attempts: att.attempts, done: att.done, rewarded: att.rewarded }, when: attIt ? (attIt.v ?? 'any') : 'absent' }],
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
