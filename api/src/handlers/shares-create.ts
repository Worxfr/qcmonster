// Handler Lambda `shares-create` (S1 #34): POST /me/shares. Le jeton n'est renvoye qu'ici; ni lui, ni le titre, ni une question n'est journalise.
import { ShareCreateRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { authOf, json, parseBody, requireStudent, wrap } from '../lib/http.js';
import { createShare } from '../shares/create.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-create', async (e) => json(201, await createShare(shareCtx(), requireStudent(authOf(e)), parseBody(e, ShareCreateRequestSchema))));
