// E1: tous les handlers du parcours refusent le parent (403) AVANT toute lecture de la base; contrat sans champ secret.
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { parse } from 'yaml';
import * as copieDelete from '../handlers/copie-delete.js';
import * as copieGet from '../handlers/copie-get.js';
import * as copiesCreate from '../handlers/copies-create.js';
import * as copiesSubmit from '../handlers/copies-submit.js';
import * as exoGet from '../handlers/exo-get.js';
import * as exoHint from '../handlers/exo-hint-post.js';
import * as exoList from '../handlers/exo-list.js';
import * as exoPost from '../handlers/exo-post.js';
import * as exoSolution from '../handlers/exo-solution-post.js';

Object.assign(process.env, { QCM_ENV: 'dev', TABLE_NAME: 't', SCANS_BUCKET: 'b', EXO_GEN_FUNCTION: 'f', COPIE_STATE_MACHINE_ARN: 'm', AWS_REGION: 'eu-west-3', AWS_ACCESS_KEY_ID: 'x', AWS_SECRET_ACCESS_KEY: 'x' });
const event = (groups: string[], path: Record<string, string>, body?: unknown) =>
  ({ pathParameters: path, body: body === undefined ? undefined : JSON.stringify(body), requestContext: { authorizer: { jwt: { claims: { sub: 's', 'cognito:groups': groups, 'cognito:username': 'stu1', 'custom:famille_id': 'fam1' } } } } }) as never;

const HANDLERS: [string, (e: never) => Promise<{ statusCode?: number }>, Record<string, string>, unknown?][] = [
  ['exo-post', exoPost.handler as never, { docId: 'd' }],
  ['exo-list', exoList.handler as never, { docId: 'd' }],
  ['exo-get', exoGet.handler as never, { exoId: 'd-01' }],
  ['exo-hint-post', exoHint.handler as never, { exoId: 'd-01' }],
  ['exo-solution-post', exoSolution.handler as never, { exoId: 'd-01' }],
  ['copies-create', copiesCreate.handler as never, { exoId: 'd-01' }, { pages: 1, contentType: 'image/jpeg' }],
  ['copies-submit', copiesSubmit.handler as never, { copieId: 'c' }],
  ['copie-get', copieGet.handler as never, { copieId: 'c' }],
  ['copie-delete', copieDelete.handler as never, { copieId: 'c' }],
];

describe('E1: le parent n\'a aucune route nouvelle', () => {
  it.each(HANDLERS)('%s: parent 403, jeton sans groupe 403', async (_n, h, path, body) => {
    expect((await h(event(['parent'], path, body))).statusCode).toBe(403);
    expect((await h(event([], path, body))).statusCode).toBe(403);
    expect((await h(event(['eleve', 'parent'], path, body))).statusCode).toBe(403); // compte incoherent
  });
});

describe('E1: contrat 1.9.0', () => {
  const spec = parse(readFileSync('shared/contract/openapi.yaml', 'utf8'));
  const S = spec.components.schemas;
  it('Exercice ne porte aucun champ pour le bareme, les attendus, la finale, les indices non vus ni la solution', () => {
    const names = Object.keys(S.Exercice.properties);
    for (const forbidden of ['etapes', 'attendu', 'finale', 'indices', 'solution', 'num', 'valeur']) expect(names).not.toContain(forbidden);
  });
  it('Copie ne renvoie ni `suspecte`, ni transcription, ni image, ni empreinte, ni cout', () => {
    const names = Object.keys(S.Copie.properties);
    for (const forbidden of ['suspecte', 'transcription', 'texte', 'image', 'hash', 'hashes', 'cout', 'coutMicros', 'lignes']) expect(names).not.toContain(forbidden);
  });
  it('submit n\'a aucun corps (aucune empreinte envoyee par le client)', () => {
    expect(spec.paths['/copies/{copieId}/submit'].post.requestBody).toBeUndefined();
  });
  it('kind des lignes de test: qcm, gap, exo', () => {
    for (const n of ['TestQuestionStatus']) expect(S[n].properties.kind.enum).toEqual(['qcm', 'gap', 'exo']);
  });
  it('envois: une page par envoi, 3 pages au plus, JPEG ou PNG', () => {
    expect(S.CopieCreateRequest.properties.pages.maximum).toBe(3);
    expect(S.CopieCreateRequest.properties.contentType.enum).toEqual(['image/jpeg', 'image/png']);
  });
});
