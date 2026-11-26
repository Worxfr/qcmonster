// Handler Lambda `activation-post` (L3). Identite tiree du jeton; aucun corps journalise.
import type { APIGatewayProxyEventV2, APIGatewayProxyStructuredResultV2 } from 'aws-lambda';
import { ActivationRequestSchema } from '../../../shared/contract/generated/schemas.js';
import { log } from '../../../shared/log/index.js';
import { activate } from '../family/activation.js';
import { HttpError, json, parseBody } from '../lib/http.js';
import { familyDeps } from './runtime.js';

/** POST /activation: route PUBLIQUE (sans JWT). Jeton inconnu, expire ou utilise: meme 404. */
export const handler = async (event: APIGatewayProxyEventV2): Promise<APIGatewayProxyStructuredResultV2> => {
  const t0 = Date.now();
  try {
    const d = familyDeps();
    const out = await activate(d, d.identity, parseBody(event, ActivationRequestSchema));
    log({ step: 'activation-post', status: 'ok', durationMs: Date.now() - t0 });
    return json(200, out);
  } catch (e) {
    if (e instanceof HttpError) {
      log({ step: 'activation-post', status: 'rejected', durationMs: Date.now() - t0 });
      return json(e.status, { code: e.code, message: e.message });
    }
    log({ step: 'activation-post', status: 'error', durationMs: Date.now() - t0 });
    throw e;
  }
};
