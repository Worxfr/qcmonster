// Correction d'une copie (E1, Lambda `copie-correct`, role `copie-role`). Deux appels de modele: LECTURE (Sonnet, images, sans bareme) puis NOTATION
// (Haiku, texte seul). Le modele classe et cite; le CODE verifie les citations, lit les nombres, calcule la note (shared/exo.ts). Ne touche NI PROFILE NI TEST#.
import { z } from 'zod';
import { CostBlockedError, JobBudgetExceededError } from '../../../shared/bedrock.js';
import { toMicros } from '../../../shared/cost.js';
import { keys } from '../../../shared/ddb/keys.js';
import {
  GENERIC_HINT, GradeSchema, bilanOf, cleanHint, defangCopie, finalStatuts, finalVerdict, looksLikeInjection, parseExoRef, scoreMilli, stripHeader, vocabularyOf, type Etape, type Finale, type Statut,
} from '../../../shared/exo.js';
import { COPIE_COST_CAP_EUR } from '../../../shared/names.js';
import type { Deps } from '../lib/deps.js';
import type { Item, Write } from '../lib/store.js';
import { SYSTEM_GRADE, SYSTEM_READ, copieReadPrompt, gradePrompt } from '../pipeline/prompts-exo.js';
import { endWithoutCorrection, pageKeys, releaseLockWrite } from './fail.js';
import { ModelOutputError, modelCaller, parseJson, type ModelDeps } from './model.js';
import { pageKey, sha256Hex, type CopieFiles, type CopieInput, type Reencoder } from './ports.js';

export interface CorrectDeps extends Deps, ModelDeps {
  files: Pick<CopieFiles, 'getBytes' | 'deleteKeys'>; // jamais `list` ni `presign`: copie-role n'a pas ListBucket
  images: Reencoder;
}
const ReadSchema = z.object({ lisible: z.boolean(), pages: z.array(z.object({ lignes: z.array(z.string().max(400)).max(200) })).max(3).default([]), instructionsVues: z.boolean().default(false) });
const MAX_TRANSCRIPTION = 6000;

const DEFAULT_HINT: Record<Statut, string> = {
  ok: 'Bien joué !',
  partiel: 'Il manque un morceau, relis cette étape.',
  faux: GENERIC_HINT,
  absent: "Je n'ai pas trouvé cette étape sur ta copie.",
  reporte: 'Cohérent avec ton erreur plus haut.',
};

async function twice<T>(f: () => Promise<T>): Promise<T> {
  try {
    return await f();
  } catch (e) {
    if (!(e instanceof ModelOutputError)) throw e;
    return f(); // une seule reprise sur une sortie illisible; le cout de chaque appel est compte
  }
}

export type CorrectResult = 'corrigee' | 'illisible' | 'echec' | 'ignore';

export async function correctCopie(deps: CorrectDeps, input: CopieInput): Promise<CorrectResult> {
  const c = await deps.store.get(keys.copie(input.sid, input.copieId));
  if (!c || c.etat !== 'en_correction') return 'ignore'; // rejeu: deja corrigee, ou echec
  const ref = parseExoRef(input.exoRef);
  const exo = ref ? await deps.store.get(keys.exo(ref.docId, ref.nn)) : undefined;
  const fail = async (motif: 'copie_deja_rendue' | 'budget' | 'technique' | 'plafond_cout', refundAttempt: boolean): Promise<CorrectResult> => {
    await endWithoutCorrection(deps, input, { etat: 'echec', motif, refundPages: true, refundAttempt, files: deps.files });
    return 'echec';
  };
  if (!ref || !exo) return fail('technique', true);
  const caller = modelCaller(deps, input.copieId, COPIE_COST_CAP_EUR);
  try {
    const p = await deps.store.get(keys.exop(input.sid, ref.docId, ref.nn));
    // Anti-rejeu: empreintes calculees ICI, sur les octets recus, AVANT le re-encodage (le client n'envoie rien qu'il puisse truquer).
    const raw: Uint8Array[] = [];
    const seen = new Set((p?.hashes ?? []) as string[]);
    const fresh: string[] = [];
    for (let n = 1; n <= input.pages; n++) {
      const bytes = await deps.files.getBytes(pageKey(input.sid, input.copieId, n));
      const h = sha256Hex(bytes);
      if (seen.has(h)) return await fail('copie_deja_rendue', false); // aucun appel de modele
      seen.add(h);
      fresh.push(h);
      raw.push(bytes);
    }
    const images = await Promise.all(raw.map(async (b) => ({ format: 'jpeg' as const, bytes: await deps.images.reencode(b) })));
    const read = await twice(async () => parseJson(await caller.call('sonnet', 'copie-lire', { system: SYSTEM_READ, prompt: copieReadPrompt(input.pages), maxTokens: 3000, images }), ReadSchema));
    const lines = read.pages.flatMap((pg, i) => (i === 0 ? stripHeader(pg.lignes) : pg.lignes)).map((l) => l.trim()).filter(Boolean);
    if (!read.lisible || lines.length === 0) {
      await endWithoutCorrection(deps, input, { etat: 'illisible', refundPages: false, refundAttempt: true, files: deps.files });
      return 'illisible';
    }
    const transcription = defangCopie(lines.join('\n')).slice(0, MAX_TRANSCRIPTION);
    const grade = await twice(async () =>
      parseJson(await caller.call('haiku', 'copie-noter', { system: SYSTEM_GRADE, prompt: gradePrompt({ enonce: String(exo.enonce), etapes: exo.etapes as Etape[], finale: exo.finale as Finale, transcription }), maxTokens: 1500 }), GradeSchema),
    );
    const etapes = exo.etapes as Etape[];
    const finale = exo.finale as Finale;
    const statuts = finalStatuts({ etapes }, grade, transcription);
    const fin = finalVerdict(finale, grade, transcription);
    const milli = scoreMilli({ etapes, finale }, statuts, fin);
    const vocab = vocabularyOf({ enonce: String(exo.enonce), titre: String(exo.titre), etapes, finale, indices: (exo.indices ?? []) as string[] });
    const out = etapes.map((e) => {
      const g = grade.etapes.find((x) => x.id === e.id);
      const statut = statuts[e.id];
      // Statut change par le code: le conseil du modele ne decrit plus la copie, on met le texte fixe.
      const indice = g && g.statut === statut ? cleanHint(g.indice, { transcription, finaleValue: finale.num.v, tolRel: finale.num.tolRel, vocab }) : DEFAULT_HINT[statut];
      return { id: e.id, statut, indice: indice === GENERIC_HINT && statut === 'ok' ? DEFAULT_HINT.ok : indice };
    });
    const bil = bilanOf(statuts, fin);
    const suspecte = read.instructionsVues || grade.instructionsVues || looksLikeInjection(transcription);
    // Images supprimees AVANT l'ecriture de l'etat `corrigee` (si la suppression echoue, l'etat reste `en_correction` et la tache est rejouee).
    await deps.files.deleteKeys(pageKeys(input.sid, input.copieId, input.pages));
    for (let attempt = 0; attempt < 4; attempt++) {
      const cur = await deps.store.get(keys.copie(input.sid, input.copieId));
      if (!cur || cur.etat !== 'en_correction') return 'ignore';
      const pp = await deps.store.get(keys.exop(input.sid, ref.docId, ref.nn));
      const writes: Write[] = [
        { item: { ...cur, etat: 'corrigee', etapes: out, finale: fin, milli, bilan: bil.text, suspecte, coutMicros: toMicros(caller.spentEur), retourAt: deps.now().toISOString(), credite: false, ttl: undefined }, when: cur.v ?? 'any' },
      ];
      if (pp) writes.push({ item: { ...pp, hashes: [...((pp.hashes ?? []) as string[]), ...fresh].slice(-9) }, when: pp.v ?? 'any' });
      const lock = await releaseLockWrite(deps, input.sid, input.copieId);
      if (lock) writes.push(lock);
      if (await deps.store.commit(writes)) return 'corrigee';
    }
    throw new Error('copie-correct: conflit persistant');
  } catch (e) {
    if (e instanceof JobBudgetExceededError) return fail('plafond_cout', true);
    if (e instanceof CostBlockedError) return fail('budget', true);
    throw e; // Step Functions: une reprise sur erreur de service, puis `copie-fail`
  }
}

export type { Item };
