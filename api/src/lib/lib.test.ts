import { readdirSync, readFileSync } from 'node:fs';
import type { APIGatewayProxyEventV2WithJWTAuthorizer } from 'aws-lambda';
import { describe, expect, it, vi } from 'vitest';
import { z } from 'zod';
import { badRequest, authOf, HttpError, json, parseBody, parseGroups, pathId, requireParent, requireStudent, wrap } from './http.js';
import { realRandom } from './deps.js';
import { cognitoIdentity, InvalidPasswordError, AliasTakenError, UserGoneError } from './identity.js';
import { memoryPhotos, s3Photos } from './photos.js';
import { dynamoStore, memoryStore } from './store.js';

const ev = (claims: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
  ({ requestContext: { authorizer: { jwt: { claims } } }, ...extra }) as unknown as APIGatewayProxyEventV2WithJWTAuthorizer;

describe('identite du jeton', () => {
  it('groupes: tableau ou chaine API Gateway', () => {
    expect(parseGroups(['parent'])).toEqual(['parent']);
    expect(parseGroups('[parent eleve]')).toEqual(['parent', 'eleve']);
    expect(parseGroups('parent')).toEqual(['parent']);
    expect(parseGroups(undefined)).toEqual([]);
  });
  it('role, famille et nom d\'utilisateur viennent du jeton', () => {
    expect(authOf(ev({ sub: 's', 'cognito:groups': '[parent]', 'custom:famille_id': 'fam1', 'cognito:username': 'u1' }))).toEqual({ sub: 's', username: 'u1', role: 'parent', familyId: 'fam1' });
    expect(authOf(ev({ sub: 's', 'cognito:groups': ['eleve'], 'custom:famille_id': 'fam1', username: 'u2' }))).toMatchObject({ role: 'eleve', username: 'u2' });
    expect(authOf(ev({ sub: 's' }))).toEqual({ sub: 's', username: '', role: undefined, familyId: undefined });
    expect(authOf(ev({ sub: 's', 'cognito:groups': ['parent', 'eleve'] })).role).toBeUndefined(); // deux groupes: aucun role
    expect(authOf(ev({ sub: 's', 'custom:famille_id': 'a#b' })).familyId).toBeUndefined(); // identifiant a la forme invalide
    expect(() => authOf(ev({}))).toThrow(HttpError);
    expect(() => authOf({ requestContext: {} } as unknown as APIGatewayProxyEventV2WithJWTAuthorizer)).toThrow(HttpError);
  });
  it('requireParent / requireStudent: role et famille obligatoires', () => {
    expect(requireParent({ sub: 's', username: 'u', role: 'parent', familyId: 'f' })).toEqual({ sub: 's', username: 'u', familyId: 'f' });
    expect(() => requireParent({ sub: 's', username: 'u', role: 'eleve', familyId: 'f' })).toThrow('Réservé au parent');
    expect(() => requireParent({ sub: 's', username: 'u', role: 'parent' })).toThrow(HttpError);
    expect(requireStudent({ sub: 's', username: 'u', role: 'eleve', familyId: 'f' })).toEqual({ sub: 's', studentId: 'u', familyId: 'f' });
    expect(() => requireStudent({ sub: 's', username: 'u', role: 'parent', familyId: 'f' })).toThrow(HttpError);
    expect(() => requireStudent({ sub: 's', username: 'u', role: 'eleve' })).toThrow(HttpError);
    expect(() => requireStudent({ sub: 's', username: 'a#b', role: 'eleve', familyId: 'f' })).toThrow(HttpError);
  });
  it('parametres de chemin et corps', () => {
    expect(pathId({ pathParameters: { sid: 'ok-1_x' } }, 'sid')).toBe('ok-1_x');
    for (const bad of [undefined, '', 'a#b', 'x'.repeat(65), '../x']) expect(() => pathId({ pathParameters: { sid: bad } }, 'sid')).toThrow(HttpError);
    const S = z.object({ a: z.number() });
    expect(parseBody({ body: '{"a":1}' }, S)).toEqual({ a: 1 });
    expect(parseBody({ body: Buffer.from('{"a":2}').toString('base64'), isBase64Encoded: true }, S)).toEqual({ a: 2 });
    for (const body of [undefined, '', '{', '{"a":"x"}', 'x'.repeat(5000)]) expect(() => parseBody({ body }, S)).toThrow(HttpError);
    try {
      parseBody({ body: '{"a":"secret-123"}' }, S);
    } catch (e) {
      expect((e as Error).message).not.toContain('secret'); // le contenu n'est jamais repris dans l'erreur
    }
  });
});

describe('wrap', () => {
  it('HttpError -> reponse du contrat; autre erreur: 500 generique sans relance, seul le nom de la classe d erreur est journalise', async () => {
    const out: string[] = [];
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((s) => (out.push(String(s)), true));
    try {
      const ok = await wrap('t', async () => json(200, { a: 1 }))(ev({ sub: 's' }, { body: '{"password":"MotDePasse-Secret-1"}' }));
      expect(ok.statusCode).toBe(200);
      const ko = await wrap('t', async () => { throw badRequest(); })(ev({ sub: 's' }));
      expect(ko).toMatchObject({ statusCode: 400 });
      expect(JSON.parse(ko.body as string)).toEqual({ code: 'requete_invalide', message: 'Requête invalide' });
      const boom = await wrap('t', async () => { throw new Error('boom MotDePasse-Secret-1'); })(ev({ sub: 's' }));
      expect(boom).toMatchObject({ statusCode: 500 });
      expect(boom.body).not.toContain('boom');
    } finally {
      spy.mockRestore();
    }
    expect(out.join('')).not.toContain('Secret');
    expect(out.every((l) => Object.keys(JSON.parse(l)).every((k) => ['ts', 'step', 'status', 'durationMs', 'errorCode'].includes(k)))).toBe(true);
  });
});

describe('aleatoire', () => {
  it('jeton de 43 caracteres (256 bits), suffixe de 4, identifiants au format du contrat', () => {
    expect(realRandom.newToken()).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(realRandom.suffix()).toMatch(/^[a-z0-9]{4}$/);
    expect(realRandom.newId()).toMatch(/^[A-Za-z0-9_-]{1,64}$/);
    expect(realRandom.newToken()).not.toBe(realRandom.newToken());
  });
});

describe('garde: chaque handler verifie l\'identite du jeton', () => {
  const dir = new URL('../handlers/', import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts') && f !== 'runtime.ts');
  it('17 handlers, tous relies a authOf ou requireAdmin (sauf l\'activation publique)', () => {
    expect(files).toHaveLength(17);
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      if (f === 'activation-post.ts') expect(src).not.toMatch(/authOf/); // route sans JWT
      else if (f === 'admin-invitations.ts') expect(src).toMatch(/requireAdmin\(/); // groupe `admin` du jeton
      else expect(src, f).toMatch(/authOf\(/);
    }
  });
  it('aucun handler ne lit la famille ou l\'eleve ailleurs que dans le jeton (ni requete, ni corps brut)', () => {
    for (const f of files) {
      const src = readFileSync(new URL(f, dir), 'utf8');
      // tests-read (H1-A) lit des FILTRES de liste (fiche, annee, curseur, limite) dans la requete; l'eleve et la famille viennent du jeton seul.
      if (f === 'tests-read.ts') {
        expect(src, f).not.toMatch(/rawQueryString|\be\.body\b|event\.body\b|headers|familyId|studentId|\bsid\b/);
        expect(src, f).toMatch(/requireStudent\(authOf\(e\)\)/);
      } else if (f === 'family-progress.ts') {
        // H1-B: le parent vient du jeton; `sid` du chemin est verifie en base (lien FAMILY#<fid>/STUDENT#<sid>), les filtres de liste viennent de la requete.
        expect(src, f).not.toMatch(/rawQueryString|\be\.body\b|event\.body\b|headers|familyId/);
        expect(src, f).toMatch(/requireParent\(authOf\(e\)\)/);
      } else expect(src, f).not.toMatch(/queryStringParameters|rawQueryString|\be\.body\b|event\.body\b|headers/);
    }
  });
});

describe('adaptateur Cognito', () => {
  const sent: { name: string; input: Record<string, unknown> }[] = [];
  const make = (fail?: (name: string) => string | undefined, attrs: { Name: string; Value?: string }[] = [{ Name: 'sub', Value: 'sub-1' }], userAttrs: { Name: string; Value?: string }[] = []) => {
    sent.length = 0;
    const client = {
      send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        sent.push({ name: c.constructor.name, input: c.input });
        const err = fail?.(c.constructor.name);
        if (err) throw Object.assign(new Error(err), { name: err });
        return { User: { Attributes: attrs }, UserAttributes: userAttrs };
      },
    };
    return cognitoIdentity('pool-1', client as never);
  };
  it('creation: sans message, groupe eleve, e-mail factice, famille dans le jeton', async () => {
    const id = make();
    expect(await id.createStudent({ studentId: 'sid1', familyId: 'fam1', alias: 'Pseudo-ab12' })).toEqual({ sub: 'sub-1' });
    expect(sent.map((s) => s.name)).toEqual(['AdminCreateUserCommand', 'AdminAddUserToGroupCommand']);
    expect(sent[0].input).toMatchObject({ UserPoolId: 'pool-1', Username: 'sid1', MessageAction: 'SUPPRESS' });
    expect(JSON.stringify(sent[0].input)).toContain('custom:famille_id');
    expect(sent[1].input).toMatchObject({ GroupName: 'eleve' });
    await expect(make(undefined, []).createStudent({ studentId: 's', familyId: 'f', alias: 'a' })).rejects.toThrow('sub absent');
    await expect(make((n) => (n === 'AdminCreateUserCommand' ? 'AliasExistsException' : undefined)).createStudent({ studentId: 's', familyId: 'f', alias: 'a' })).rejects.toBeInstanceOf(AliasTakenError);
    await expect(make(() => 'InternalErrorException').createStudent({ studentId: 's', familyId: 'f', alias: 'a' })).rejects.toThrow('InternalErrorException');
  });
  it('mot de passe permanent; politique refusee = InvalidPasswordError', async () => {
    await make().setPassword('u', 'pw');
    expect(sent[0].input).toMatchObject({ Permanent: true, Username: 'u' });
    await expect(make(() => 'InvalidPasswordException').setPassword('u', 'pw')).rejects.toBeInstanceOf(InvalidPasswordError);
    await expect(make(() => 'TooManyRequestsException').setPassword('u', 'pw')).rejects.toThrow('TooManyRequestsException');
    await expect(make(() => 'UserNotFoundException').setPassword('u', 'pw')).rejects.toBeInstanceOf(UserGoneError);
  });
  it('famille du parent: groupe + attribut, une seule fois', async () => {
    const id = make(undefined, [], [{ Name: 'email', Value: 'x' }]);
    expect(await id.attachFamily('p', 'fam1')).toBe(true);
    expect(sent.map((s) => s.name)).toEqual(['AdminGetUserCommand', 'AdminUpdateUserAttributesCommand', 'AdminAddUserToGroupCommand']);
    expect(sent[2].input).toMatchObject({ GroupName: 'parent' });
    // famille_id deja egal (reprise apres un echec d'ajout au groupe): le groupe est ajoute quand meme
    const same = make(undefined, [], [{ Name: 'custom:famille_id', Value: 'fam1' }]);
    expect(await same.attachFamily('p', 'fam1')).toBe(true);
    expect(sent.map((s) => s.name)).toEqual(['AdminGetUserCommand', 'AdminAddUserToGroupCommand']);
    // une AUTRE famille: refus, rien n'est ecrit
    const had = make(undefined, [], [{ Name: 'custom:famille_id', Value: 'f' }]);
    expect(await had.attachFamily('p', 'fam1')).toBe(false);
    expect(sent.map((s) => s.name)).toEqual(['AdminGetUserCommand']);
    // l'ajout au groupe echoue apres l'ecriture de famille_id: l'erreur remonte
    await expect(make((n) => (n === 'AdminAddUserToGroupCommand' ? 'ThrottlingException' : undefined), [], []).attachFamily('p', 'fam1')).rejects.toThrow('ThrottlingException');
    const none = make(undefined, [], []);
    expect(await none.attachFamily('p', 'fam1')).toBe(true);
  });
  it('suspension: desactive et revoque les jetons; reactivation; suppression idempotente', async () => {
    const id = make();
    await id.setEnabled('u', false);
    expect(sent.map((s) => s.name)).toEqual(['AdminDisableUserCommand', 'AdminUserGlobalSignOutCommand']);
    await id.setEnabled('u', true);
    expect(sent.slice(2).map((s) => s.name)).toEqual(['AdminEnableUserCommand']);
    await make((n) => (n === 'AdminDeleteUserCommand' ? 'UserNotFoundException' : undefined)).deleteUser('u');
    await expect(make(() => 'InternalErrorException').deleteUser('u')).rejects.toThrow();
  });
});

describe('adaptateur DynamoDB', () => {
  const fake = (handler: (name: string, input: Record<string, unknown>) => unknown) => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    return {
      calls,
      client: {
        send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
          calls.push({ name: c.constructor.name, input: c.input });
          return handler(c.constructor.name, c.input);
        },
      } as never,
    };
  };
  it('ecriture conditionnelle a la version lue, version incrementee; transaction pour plusieurs elements', async () => {
    const f = fake(() => ({}));
    const s = dynamoStore(f.client, 'qcm-dev');
    expect(await s.commit([{ item: { PK: 'A', SK: 'B', x: 1 }, when: 3 }])).toBe(true);
    expect(f.calls[0].name).toBe('PutCommand');
    expect(f.calls[0].input).toMatchObject({ Item: { v: 4 }, ConditionExpression: 'v = :ev', ExpressionAttributeValues: { ':ev': 3 } });
    await s.commit([{ item: { PK: 'A', SK: 'B' }, when: 'absent' }, { item: { PK: 'A', SK: 'C', v: 5 }, when: 'any' }]);
    const tx = f.calls[1].input.TransactItems as { Put: Record<string, unknown> }[];
    expect(tx[0].Put).toMatchObject({ ConditionExpression: 'attribute_not_exists(PK)', Item: { v: 1 } });
    expect(tx[1].Put.ConditionExpression).toBeUndefined();
    expect((tx[1].Put.Item as { v: number }).v).toBe(6);
  });
  it('un conflit de condition renvoie false, toute autre erreur est relancee', async () => {
    const conflict = (e: object) => dynamoStore(fake(() => { throw Object.assign(new Error('x'), e); }).client, 't');
    expect(await conflict({ name: 'ConditionalCheckFailedException' }).commit([{ item: { PK: 'A', SK: 'B' }, when: 1 }])).toBe(false);
    expect(await conflict({ name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'None' }, { Code: 'ConditionalCheckFailed' }] }).commit([{ item: { PK: 'A', SK: 'B' }, when: 1 }, { item: { PK: 'A', SK: 'C' }, when: 'any' }])).toBe(false);
    await expect(conflict({ name: 'TransactionCanceledException', CancellationReasons: [{ Code: 'ThrottlingError' }] }).commit([{ item: { PK: 'A', SK: 'B' }, when: 1 }])).rejects.toThrow();
    await expect(conflict({ name: 'TransactionCanceledException' }).commit([{ item: { PK: 'A', SK: 'B' }, when: 1 }])).rejects.toThrow();
    await expect(conflict({ name: 'ProvisionedThroughputExceededException' }).commit([{ item: { PK: 'A', SK: 'B' }, when: 1 }])).rejects.toThrow();
  });
  it('lectures coherentes, pagination, index GSI1', async () => {
    let page = 0;
    const f = fake((name) => (name === 'QueryCommand' ? (page++ === 0 ? { Items: [{ PK: 'p', SK: 'a' }], LastEvaluatedKey: { PK: 'p', SK: 'a' } } : { Items: [{ PK: 'p', SK: 'b' }] }) : { Item: { PK: 'p', SK: 'a' } }));
    const s = dynamoStore(f.client, 't');
    expect(await s.get({ PK: 'p', SK: 'a' })).toBeDefined();
    expect(f.calls[0].input.ConsistentRead).toBe(true);
    expect((await s.query('p', 'x')).map((i) => i.SK)).toEqual(['a', 'b']);
    expect(f.calls[1].input).toMatchObject({ KeyConditionExpression: 'PK = :p AND begins_with(SK, :s)', ConsistentRead: true });
    await s.query('p');
    expect(f.calls[3].input.KeyConditionExpression).toBe('PK = :p');
    const g = fake(() => ({}));
    await dynamoStore(g.client, 't').query('FAMILY#f', 'DOC#', true);
    expect(g.calls[0].input).toMatchObject({ IndexName: 'GSI1', KeyConditionExpression: 'GSI1PK = :p AND begins_with(GSI1SK, :s)' });
    expect(g.calls[0].input.ConsistentRead).toBeUndefined();
    await dynamoStore(g.client, 't').remove({ PK: 'a', SK: 'b' });
    expect(g.calls[1].name).toBe('DeleteCommand');
  });
  it('memoire: memes conditions', async () => {
    const m = memoryStore();
    expect(await m.commit([{ item: { PK: 'a', SK: 'b' }, when: 'absent' }])).toBe(true);
    expect(await m.commit([{ item: { PK: 'a', SK: 'b' }, when: 'absent' }])).toBe(false);
    expect(await m.commit([{ item: { PK: 'a', SK: 'b' }, when: 7 }])).toBe(false);
    expect(await m.commit([{ item: { PK: 'a', SK: 'b' }, when: 1 }])).toBe(true);
    expect((await m.get({ PK: 'a', SK: 'b' }))?.v).toBe(2);
    expect(await m.get({ PK: 'a', SK: 'zz' })).toBeUndefined();
  });
});

describe('photos', () => {
  it('liste puis supprime par prefixe scans/<eleveId>/ (vraie forme scans/<eleve>/<job>/<n>), pagination, ignore un identifiant invalide, echec = erreur', async () => {
    const calls: { name: string; input: Record<string, unknown> }[] = [];
    let page = 0;
    const state: { errors?: unknown[] } = {};
    const client = {
      send: async (c: { constructor: { name: string }; input: Record<string, unknown> }) => {
        calls.push({ name: c.constructor.name, input: c.input });
        if (c.constructor.name === 'ListObjectsV2Command') return page++ === 0 ? { Contents: [{ Key: 'scans/stu1/job1/0' }, {}], NextContinuationToken: 't' } : {};
        return { Errors: state.errors };
      },
    };
    await s3Photos('bucket-1', client as never).deleteForStudent('stu1');
    expect(calls.map((c) => c.name)).toEqual(['ListObjectsV2Command', 'DeleteObjectsCommand', 'ListObjectsV2Command']);
    expect(calls[0].input.Prefix).toBe('scans/stu1/');
    expect((calls[1].input.Delete as { Objects: unknown[] }).Objects).toEqual([{ Key: 'scans/stu1/job1/0' }]);
    calls.length = 0;
    await s3Photos('bucket-1', client as never).deleteForStudent('../x');
    expect(calls).toEqual([]);
    page = 0;
    state.errors = [{ Code: 'AccessDenied' }];
    await expect(s3Photos('bucket-1', client as never).deleteForStudent('stu1')).rejects.toThrow('incomplete');
    const m = memoryPhotos();
    await m.deleteForStudent('a');
    expect(m.deleted).toEqual(['a']);
  });
});
