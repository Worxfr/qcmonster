// Handler Lambda `answers-post` (L3). Identite tiree du jeton; aucun corps journalise.
import { AnswerRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { postAnswer } from '../game/answers.js';
import { authOf, json, parseBody, requireStudent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('answers-post', async (e) => json(200, await postAnswer(gameDeps(), requireStudent(authOf(e)), parseBody(e, AnswerRequestSchema))));
