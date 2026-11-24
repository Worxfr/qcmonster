import { describe, expect, it } from 'vitest';
import { QuestionIdSchema, VerdictItemSchema, VerifyInputSchema, parseQuestionId, questionId } from './items.js';

describe('items partages', () => {
  it('questionId: unique entre fiches, aller-retour', () => {
    const a = questionId('doc1', 'qcm', 1);
    const b = questionId('doc2', 'qcm', 1);
    expect(a).not.toBe(b);
    expect(parseQuestionId(a)).toEqual({ docId: 'doc1', kind: 'qcm', nn: 1 });
    expect(QuestionIdSchema.safeParse('qcm-01').success).toBe(false);
    expect(() => parseQuestionId('x:y:01')).toThrow(RangeError);
  });
  it('interface verify-run: un budget restant, aucun texte', () => {
    expect(VerifyInputSchema.parse({ jobId: 'j', docId: 'd', budgetRestantCentimes: 25 })).toEqual({ jobId: 'j', docId: 'd', budgetRestantCentimes: 25 });
    expect(VerifyInputSchema.safeParse({ jobId: 'j', docId: 'd', budgetRestantCentimes: -1 }).success).toBe(false);
  });
  it('verdict: statut dans la liste du contrat', () => {
    const v = { PK: 'DOC#d', SK: 'VERDICT#01', statut: 'erreur', sources: [] };
    expect(VerdictItemSchema.safeParse(v).success).toBe(true);
    expect(VerdictItemSchema.safeParse({ ...v, statut: 'faux' }).success).toBe(false);
  });
});
