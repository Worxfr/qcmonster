// Handler Lambda `practice-post` (Q1): POST /practice/session, S'entrainer sur plusieurs fiches ou un dossier. Eleve seul; identite tiree du jeton.
import { PracticeRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { practiceSession } from '../game/session.js';
import { authOf, json, parseBody, requireStudent, wrap } from '../lib/http.js';
import { gameDeps } from './runtime.js';

export const handler = wrap('practice-post', async (e) => json(200, await practiceSession(gameDeps(), requireStudent(authOf(e)), parseBody(e, PracticeRequestSchema))));
