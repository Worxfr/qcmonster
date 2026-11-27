// Handler Lambda `shares-report` (S1 #34): POST /shares/report, route PUBLIQUE. Motif d'une liste fermee, aucun texte libre.
import { noContent, parseBody, wrap } from '../lib/http.js';
import { ReportBodySchema, reportShare } from '../shares/public.js';
import { shareCtx } from './shares-runtime.js';

export const handler = wrap('shares-report', async (e) => {
  const b = parseBody(e, ReportBodySchema);
  await reportShare(shareCtx(), b.token, b.reason);
  return noContent();
});
