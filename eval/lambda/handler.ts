// Lambda `eval-run` (dev seulement, stack eval-stack). Deux actions: `cost` (compteurs de cout) et `run` (une page synthetique du jeu public).
// Appelable par le seul role QCMonster-Eval-dev (lambda:InvokeFunction). Aucun contenu de cours dans les journaux.
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { costStoreFromDynamo, realModelPort } from '../../shared/bedrock.js';
import { log } from '../../shared/log/index.js';
import { createSearchTool } from '../../api/src/verify/search.js';
import { sharedLimiter } from '../../api/src/verify/limits.js';
import { bytesFromBase64, PAGE_ID, runPage, type PageResult } from './run-page.js';

const Event = z.discriminatedUnion('action', [
  z.object({ action: z.literal('cost') }),
  z.object({ action: z.literal('run'), pageId: z.string().regex(PAGE_ID), image: z.string().min(1) }),
]);

const need = (name: string): string => {
  const v = process.env[name];
  if (!v) throw new Error(`variable ${name} absente`);
  return v;
};

export async function handler(event: unknown): Promise<PageResult | { costBefore: unknown }> {
  if (process.env.QCM_ENV !== 'dev') throw new Error('eval-run: dev seulement');
  const e = Event.parse(event);
  const client = DynamoDBDocumentClient.from(new DynamoDBClient({}));
  const costStore = costStoreFromDynamo(client, need('TABLE_NAME'));
  if (e.action === 'cost') return { costBefore: await costStore.read() };
  const t0 = Date.now();
  const res = await runPage(
    { models: { haiku: need('QCM_MODEL_HAIKU'), sonnet: need('QCM_MODEL_SONNET') }, port: await realModelPort(), costStore, search: createSearchTool({ beforeRequest: sharedLimiter }) },
    { pageId: e.pageId, image: bytesFromBase64(e.image) },
  );
  log({ step: 'eval-run', status: res.errorClass ? 'error' : 'ok', durationMs: Date.now() - t0, costEur: res.costEur, ...(res.errorClass ? { errorCode: res.errorClass } : {}) });
  return res;
}
