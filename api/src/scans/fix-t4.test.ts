import { describe, expect, it } from 'vitest';
import { coursApi } from '../cours/cours.js';
import { guarded } from '../pipeline/http.js';
import { body, ev, putDoc, putJob, world } from './kit.js';
import { scansList } from './list.js';

const list = async (t: Awaited<ReturnType<typeof world>>) => body(await guarded(scansList)(t.ctx, ev('s1', 'GET /scans'))).items as Record<string, unknown>[];

describe('FIX-T4 (liste des scans)', () => {
  it('B2: apres « garder mes fiches », aucune fiche ne reste groupee ni liee a un cours supprime', async () => {
    const t = await world();
    await putJob(t, 's1', 'J1', { state: 'termine', coursId: 'J1', docIds: ['D1', 'D2'], pages: 3 });
    await putDoc(t, 's1', 'D1', { coursId: 'J1', sectionIndex: 0, sectionCount: 2 });
    await putDoc(t, 's1', 'D2', { coursId: 'J1', sectionIndex: 1, sectionCount: 2 });
    await t.db.put({ PK: 'STUDENT#s1', SK: 'COURS#J1', jobId: 'J1', pages: 3, createdAt: 'x', nbPhrases: 1, sections: [{ docId: 'D1' }, { docId: 'D2' }] });
    expect((await list(t)).every((i) => i.sectionCount === 2 && i.coursId === 'J1')).toBe(true);
    const r = await guarded(coursApi)(t.ctx, ev('s1', 'DELETE /cours/{coursId}', { params: { coursId: 'J1' }, query: { fiches: 'garder' } }));
    expect(r.statusCode).toBe(204);
    for (const i of await list(t)) {
      expect(i.coursId).toBeUndefined();
      expect(i.sectionCount).toBeUndefined();
      expect(i.sectionIndex).toBeUndefined();
    }
  });
  it('B1: un scan annule n\'apparait plus dans la liste; un echec reste visible avec accents', async () => {
    const t = await world();
    await putJob(t, 's1', 'JA', { state: 'rejete', message: "Annulé par l'élève" });
    await putJob(t, 's1', 'JE', { state: 'echec' });
    const items = await list(t);
    expect(items.map((i) => i.scanId)).toEqual(['JE']);
    expect((items[0]!.status as { message: string }).message).toBe('Le traitement a échoué, réessaie');
  });
});
