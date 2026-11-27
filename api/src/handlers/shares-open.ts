// Handler Lambda `shares-open` (S1 #34): POST /shares/open, route PUBLIQUE (aucun jeton de connexion lu). Le jeton du lien est dans le corps, jamais journalise.
import { json, parseBody, wrap } from '../lib/http.js';
import { OpenBodySchema, openShare } from '../shares/public.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-open', async (e) => json(200, await openShare(shareCtx(), parseBody(e, OpenBodySchema).token)));
