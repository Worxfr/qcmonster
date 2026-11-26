// Appels de modele des Lambda E1: garde de cout AVANT chaque appel, plafond de l'operation (`jobSpentEur` obligatoire), cout compte des la reponse.
// Aucun contenu (enonce, copie, transcription) n'est journalise: seuls les champs techniques de `invokeModel` le sont.
import { invokeModel, type CostStore, type ModelPort, type ModelRequest } from '../../../shared/bedrock.js';
import type { z } from 'zod';
import { ModelOutputError, parseModelJson } from '../pipeline/text.js';
import { SYSTEM_EXO } from '../pipeline/prompts-exo.js';

/** Sortie JSON d'un modele validee par un schema Zod; type = SORTIE du schema (valeurs par defaut appliquees). */
export const parseJson = <S extends z.ZodTypeAny>(raw: string, schema: S): z.output<S> => parseModelJson(raw, schema as z.ZodType<z.output<S>>);
export { ModelOutputError };

export interface ModelDeps {
  port: ModelPort;
  costStore: CostStore;
  /** ARN des profils d'application (SSM, injectes par CDK). `exo-role` n'a le droit que de Haiku. */
  models: { haiku: string; sonnet: string };
  /** Pauses entre les essais d'ecriture du compteur; `[0, 0, 0]` dans les tests. */
  retryDelaysMs?: number[];
}

/** Une operation (une generation ou une correction) avec son plafond en euros. */
export function modelCaller(d: ModelDeps, id: string, capEur: number) {
  let spent = 0;
  return {
    get spentEur(): number {
      return spent;
    },
    async call(model: 'haiku' | 'sonnet', step: string, req: Omit<ModelRequest, 'modelArn'>): Promise<string> {
      const r = await invokeModel({
        model: model === 'haiku' ? 'haiku-5.5' : 'sonnet-5.5',
        jobId: id,
        step,
        request: { modelArn: d.models[model], system: SYSTEM_EXO, ...req },
        store: d.costStore,
        port: d.port,
        jobSpentEur: spent,
        jobCapEur: capEur,
        retryDelaysMs: d.retryDelaysMs,
      });
      spent += r.costEur;
      return r.text;
    },
  };
}
